-- AC-5.9 — Ownership backfill (RFC-001 §19 Phase 3).
--
-- Assigns an owner to every pre-existing row. Data only: no schema change, no
-- constraint. The NOT NULL migration that follows depends on this having
-- succeeded, which is why every failure mode here aborts instead of skipping.
--
-- Prisma runs each migration file in a single transaction, so any RAISE below
-- rolls the whole thing back and leaves the database exactly as it was.
--
-- THE SINGLE-TENANT ASSUMPTION
--
-- Ownership of legacy rows is not derivable in general. `Event` has no link to
-- the Email that produced it (there is no `sourceEmailId` — see RFC-001 §22.1),
-- and Emails ingested before account tracking have no `gmailAccountId` either.
-- The backfill is therefore only sound while the database holds exactly one
-- User, which is the state RFC-001 §19 Phase 3 requires it to run in.
--
-- That assumption is asserted, not assumed: if a second User exists, this
-- migration refuses to run rather than attributing one person's placement
-- history to another. Recovering from a wrong attribution would mean knowing the
-- answer this migration could not derive in the first place.

-- ---------------------------------------------------------------------------
-- 1. Preconditions
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  user_count int;
BEGIN
  SELECT count(*) INTO user_count FROM "User" WHERE "deletedAt" IS NULL;

  IF user_count = 0 THEN
    RAISE EXCEPTION
      'AC-5.9 backfill aborted: no User exists to own existing records. Complete the Google OAuth flow once before migrating.';
  END IF;

  IF user_count > 1 THEN
    RAISE EXCEPTION
      'AC-5.9 backfill aborted: % users exist. The backfill rule is only sound for a single-tenant database (RFC-001 §19 Phase 3). Ownership of legacy rows must be resolved manually before this migration can run.',
      user_count;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Backfill, parents before children
-- ---------------------------------------------------------------------------
-- Each child derives its owner from its parent wherever the link exists, so the
-- result satisfies the composite foreign keys added by the next migration by
-- construction rather than by coincidence. Only the two cases with no derivable
-- parent fall back to the sole User.

DO $$
DECLARE
  target_user int;
BEGIN
  SELECT id INTO target_user FROM "User" WHERE "deletedAt" IS NULL;

  -- Mailboxes connected before ownership was recorded.
  UPDATE "GmailAccount"
     SET "userId" = target_user
   WHERE "userId" IS NULL;

  -- Emails follow the mailbox that produced them. Rows predating account
  -- tracking (`gmailAccountId IS NULL`, see the column comment on Email) have no
  -- mailbox to follow and fall back to the sole User.
  UPDATE "Email" e
     SET "userId" = COALESCE(
           (SELECT ga."userId" FROM "GmailAccount" ga WHERE ga.id = e."gmailAccountId"),
           target_user
         )
   WHERE e."userId" IS NULL;

  -- Events have no persisted link to their originating Email, so the sole User
  -- is the only available answer.
  UPDATE "Event"
     SET "userId" = target_user
   WHERE "userId" IS NULL;

  -- History follows its Event. Never the fallback: an EventUpdate without an
  -- Event cannot exist (the relation already cascades).
  UPDATE "EventUpdate" eu
     SET "userId" = (SELECT ev."userId" FROM "Event" ev WHERE ev.id = eu."eventId")
   WHERE eu."userId" IS NULL;

  -- Derivative records follow their Email, for the same reason.
  UPDATE "EmailExtraction" ex
     SET "userId" = (SELECT em."userId" FROM "Email" em WHERE em.id = ex."emailId")
   WHERE ex."userId" IS NULL;

  UPDATE "Attachment" a
     SET "userId" = (SELECT em."userId" FROM "Email" em WHERE em.id = a."emailId")
   WHERE a."userId" IS NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Verification — completeness
-- ---------------------------------------------------------------------------
-- The next migration applies NOT NULL. A single row missed here would make that
-- migration fail mid-deploy, so the check happens where it can still roll back
-- cleanly.

DO $$
DECLARE
  offending record;
BEGIN
  FOR offending IN
    SELECT 'GmailAccount'    AS table_name, count(*) AS n FROM "GmailAccount"    WHERE "userId" IS NULL
    UNION ALL SELECT 'Email',           count(*) FROM "Email"           WHERE "userId" IS NULL
    UNION ALL SELECT 'Event',           count(*) FROM "Event"           WHERE "userId" IS NULL
    UNION ALL SELECT 'EventUpdate',     count(*) FROM "EventUpdate"     WHERE "userId" IS NULL
    UNION ALL SELECT 'EmailExtraction', count(*) FROM "EmailExtraction" WHERE "userId" IS NULL
    UNION ALL SELECT 'Attachment',      count(*) FROM "Attachment"      WHERE "userId" IS NULL
  LOOP
    IF offending.n > 0 THEN
      RAISE EXCEPTION
        'AC-5.9 backfill aborted: % rows in "%" still have no owner.',
        offending.n, offending.table_name;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Verification — consistency
-- ---------------------------------------------------------------------------
-- Every child must agree with its parent. The next migration turns these into
-- composite foreign keys, at which point disagreement becomes unrepresentable
-- (RFC-001 §12.3) — but a constraint cannot be added over data that already
-- violates it, so the violation has to surface here.

DO $$
DECLARE
  bad_emails      int;
  bad_updates     int;
  bad_extractions int;
  bad_attachments int;
BEGIN
  SELECT count(*) INTO bad_emails
    FROM "Email" e
    JOIN "GmailAccount" ga ON ga.id = e."gmailAccountId"
   WHERE e."userId" IS DISTINCT FROM ga."userId";

  SELECT count(*) INTO bad_updates
    FROM "EventUpdate" eu
    JOIN "Event" ev ON ev.id = eu."eventId"
   WHERE eu."userId" IS DISTINCT FROM ev."userId";

  SELECT count(*) INTO bad_extractions
    FROM "EmailExtraction" ex
    JOIN "Email" em ON em.id = ex."emailId"
   WHERE ex."userId" IS DISTINCT FROM em."userId";

  SELECT count(*) INTO bad_attachments
    FROM "Attachment" a
    JOIN "Email" em ON em.id = a."emailId"
   WHERE a."userId" IS DISTINCT FROM em."userId";

  IF bad_emails > 0 OR bad_updates > 0 OR bad_extractions > 0 OR bad_attachments > 0 THEN
    RAISE EXCEPTION
      'AC-5.9 backfill aborted: ownership disagrees with parent — Email/GmailAccount: %, EventUpdate/Event: %, EmailExtraction/Email: %, Attachment/Email: %.',
      bad_emails, bad_updates, bad_extractions, bad_attachments;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Verification — the constraint the next migration adds to Event
-- ---------------------------------------------------------------------------
-- `Event.eventKey` becomes unique per owner. It is globally unique today, so
-- this cannot fail — but it is asserted rather than assumed, because a failure
-- here is recoverable and a failure inside the constraint migration is not.

DO $$
DECLARE
  duplicate_keys int;
BEGIN
  SELECT count(*) INTO duplicate_keys FROM (
    SELECT "userId", "eventKey" FROM "Event" GROUP BY 1, 2 HAVING count(*) > 1
  ) d;

  IF duplicate_keys > 0 THEN
    RAISE EXCEPTION
      'AC-5.9 backfill aborted: % (userId, eventKey) pairs are duplicated; the unique constraint in the next migration would fail.',
      duplicate_keys;
  END IF;
END $$;
