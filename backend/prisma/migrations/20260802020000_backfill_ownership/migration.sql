-- AC-5.9 — Ownership backfill (RFC-001 §19 Phase 3).
--
-- Data migration. Contains no DDL: the columns it fills were added by
-- 20260802010000, and the constraints that make them mandatory are applied by
-- 20260802030000. Schema and data are separate migrations so that either can be
-- reasoned about, replayed, or rolled back without the other.
--
-- ---------------------------------------------------------------------------
-- WHY THIS MIGRATION LOOKS THE WAY IT DOES
-- ---------------------------------------------------------------------------
--
-- Prisma replays the whole migration chain against an empty shadow database to
-- detect drift. A data migration that *requires* data — or worse, requires
-- application state such as somebody having completed Google OAuth — cannot
-- survive that replay, and would also fail on any freshly provisioned
-- environment. Two rules follow, and everything below is a consequence of them:
--
--   1. NOTHING TO BACKFILL IS SUCCESS. An empty database is the normal case,
--      not an error. The migration inspects the data and returns immediately
--      when no row needs an owner.
--
--   2. THE MIGRATION SUPPLIES ITS OWN OWNER. It never waits for a User to
--      exist. Where ownership cannot be derived from a parent row, it mints a
--      clearly-marked legacy owner rather than depending on an application
--      event that a migration engine cannot cause.
--
-- The result is deterministic — the outcome is a function of the database
-- contents alone — and idempotent, so a re-run after a partial failure
-- converges rather than duplicating.
--
-- ---------------------------------------------------------------------------
-- HOW OWNERSHIP IS DECIDED
-- ---------------------------------------------------------------------------
--
--   * Derivable rows follow their parent: Email → GmailAccount,
--     EventUpdate → Event, EmailExtraction/Attachment → Email. This is exact,
--     never a guess, and satisfies the composite foreign keys added by the next
--     migration by construction.
--
--   * Root rows (GmailAccount, Event, and Emails ingested before mailboxes were
--     tracked) have no parent to follow. They go to:
--       - the sole real User, when exactly one exists — RFC-001 §19 Phase 3's
--         single-tenant rule, and the common case for this project;
--       - otherwise the legacy owner, a disabled placeholder. Zero users and
--         several users are both handled this way, because in neither case is
--         there a non-arbitrary answer, and quarantining data under an
--         identifiable owner is recoverable where mis-attributing it is not.
--
-- The legacy owner is `status = 'disabled'`, so authentication rejects it and
-- nobody can log in as it. Transferring its data to a real account is a
-- deliberate application-level step, not something a migration should decide:
--   npm run migration:claim -- --to <userId>

DO $$
DECLARE
  -- A real Google `sub` is a numeric string, so a colon-prefixed sentinel can
  -- never collide with one.
  legacy_sub     CONSTANT text := 'migration:legacy-owner';
  -- Fixed rather than generated, so replaying this migration on two databases
  -- produces identical rows.
  legacy_public  CONSTANT text := '00000000-0000-4000-8000-000000000001';

  pending          bigint;
  real_user_count  bigint;
  owner_id         integer;
BEGIN
  ------------------------------------------------------------------------
  -- 1. Is there anything to do?
  ------------------------------------------------------------------------
  SELECT (SELECT count(*) FROM "GmailAccount"    WHERE "userId" IS NULL)
       + (SELECT count(*) FROM "Email"           WHERE "userId" IS NULL)
       + (SELECT count(*) FROM "Event"           WHERE "userId" IS NULL)
       + (SELECT count(*) FROM "EventUpdate"     WHERE "userId" IS NULL)
       + (SELECT count(*) FROM "EmailExtraction" WHERE "userId" IS NULL)
       + (SELECT count(*) FROM "Attachment"      WHERE "userId" IS NULL)
    INTO pending;

  IF pending = 0 THEN
    -- The shadow database, a fresh environment, and a re-run after a completed
    -- backfill all land here.
    RAISE NOTICE 'Ownership backfill: nothing to do (no unowned rows).';
    RETURN;
  END IF;

  RAISE NOTICE 'Ownership backfill: % unowned row(s) found.', pending;

  ------------------------------------------------------------------------
  -- 2. Resolve an owner for rows with no parent to inherit from
  ------------------------------------------------------------------------
  SELECT count(*) INTO real_user_count
    FROM "User"
   WHERE "deletedAt" IS NULL
     AND "googleSub" <> legacy_sub;

  IF real_user_count = 1 THEN
    SELECT id INTO owner_id
      FROM "User"
     WHERE "deletedAt" IS NULL
       AND "googleSub" <> legacy_sub;

    RAISE NOTICE 'Ownership backfill: assigning root records to the sole User (id %).', owner_id;
  ELSE
    -- ON CONFLICT makes this idempotent across re-runs and across a partially
    -- applied previous attempt.
    INSERT INTO "User" ("publicId", "googleSub", "email", "emailVerified",
                        "name", "status", "createdAt", "updatedAt")
    VALUES (legacy_public,
            legacy_sub,
            'legacy-data-owner@migration.invalid',  -- RFC 2606 reserved TLD
            false,
            'Legacy data (pre multi-user)',
            'disabled',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP)
    ON CONFLICT ("googleSub") DO NOTHING;

    SELECT id INTO owner_id FROM "User" WHERE "googleSub" = legacy_sub;

    RAISE NOTICE
      'Ownership backfill: % real user(s) found; assigning root records to the legacy owner (id %). Run `npm run migration:claim -- --to <userId>` to transfer them.',
      real_user_count, owner_id;
  END IF;

  ------------------------------------------------------------------------
  -- 3. Backfill, parents before children
  ------------------------------------------------------------------------
  UPDATE "GmailAccount" SET "userId" = owner_id WHERE "userId" IS NULL;

  -- Emails follow the mailbox that produced them; those predating mailbox
  -- tracking have none and fall back to the resolved owner.
  UPDATE "Email" e
     SET "userId" = COALESCE(
           (SELECT ga."userId" FROM "GmailAccount" ga WHERE ga.id = e."gmailAccountId"),
           owner_id)
   WHERE e."userId" IS NULL;

  -- Events carry no link to the Email that produced them (RFC-001 §22.1), so
  -- the resolved owner is the only available answer.
  UPDATE "Event" SET "userId" = owner_id WHERE "userId" IS NULL;

  UPDATE "EventUpdate" eu
     SET "userId" = (SELECT ev."userId" FROM "Event" ev WHERE ev.id = eu."eventId")
   WHERE eu."userId" IS NULL;

  UPDATE "EmailExtraction" ex
     SET "userId" = (SELECT em."userId" FROM "Email" em WHERE em.id = ex."emailId")
   WHERE ex."userId" IS NULL;

  UPDATE "Attachment" a
     SET "userId" = (SELECT em."userId" FROM "Email" em WHERE em.id = a."emailId")
   WHERE a."userId" IS NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Verification
-- ---------------------------------------------------------------------------
-- The next migration applies NOT NULL and the composite foreign keys. A row
-- missed or mis-assigned here would fail that migration mid-deploy, against a
-- half-constrained schema. These checks move that failure to a point where the
-- whole thing still rolls back cleanly.
--
-- Every check is vacuously true on an empty database, so the shadow replay
-- passes through them without special-casing.

DO $$
DECLARE
  offending record;
BEGIN
  FOR offending IN
              SELECT 'GmailAccount'    AS t, count(*) AS n FROM "GmailAccount"    WHERE "userId" IS NULL
    UNION ALL SELECT 'Email',           count(*) FROM "Email"           WHERE "userId" IS NULL
    UNION ALL SELECT 'Event',           count(*) FROM "Event"           WHERE "userId" IS NULL
    UNION ALL SELECT 'EventUpdate',     count(*) FROM "EventUpdate"     WHERE "userId" IS NULL
    UNION ALL SELECT 'EmailExtraction', count(*) FROM "EmailExtraction" WHERE "userId" IS NULL
    UNION ALL SELECT 'Attachment',      count(*) FROM "Attachment"      WHERE "userId" IS NULL
  LOOP
    IF offending.n > 0 THEN
      RAISE EXCEPTION 'Ownership backfill incomplete: % row(s) in "%" still have no owner.',
        offending.n, offending.t;
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  bad_emails      bigint;
  bad_updates     bigint;
  bad_extractions bigint;
  bad_attachments bigint;
BEGIN
  SELECT count(*) INTO bad_emails
    FROM "Email" e JOIN "GmailAccount" ga ON ga.id = e."gmailAccountId"
   WHERE e."userId" IS DISTINCT FROM ga."userId";

  SELECT count(*) INTO bad_updates
    FROM "EventUpdate" eu JOIN "Event" ev ON ev.id = eu."eventId"
   WHERE eu."userId" IS DISTINCT FROM ev."userId";

  SELECT count(*) INTO bad_extractions
    FROM "EmailExtraction" ex JOIN "Email" em ON em.id = ex."emailId"
   WHERE ex."userId" IS DISTINCT FROM em."userId";

  SELECT count(*) INTO bad_attachments
    FROM "Attachment" a JOIN "Email" em ON em.id = a."emailId"
   WHERE a."userId" IS DISTINCT FROM em."userId";

  IF bad_emails + bad_updates + bad_extractions + bad_attachments > 0 THEN
    RAISE EXCEPTION
      'Ownership backfill inconsistent — Email/GmailAccount: %, EventUpdate/Event: %, EmailExtraction/Email: %, Attachment/Email: %. The composite foreign keys in the next migration would reject this data.',
      bad_emails, bad_updates, bad_extractions, bad_attachments;
  END IF;
END $$;

DO $$
DECLARE
  duplicate_keys bigint;
BEGIN
  SELECT count(*) INTO duplicate_keys FROM (
    SELECT "userId", "eventKey" FROM "Event" GROUP BY 1, 2 HAVING count(*) > 1
  ) d;

  IF duplicate_keys > 0 THEN
    RAISE EXCEPTION
      'Ownership backfill produced % duplicated (userId, eventKey) pair(s); the unique constraint in the next migration would fail.',
      duplicate_keys;
  END IF;
END $$;
