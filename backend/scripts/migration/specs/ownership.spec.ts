import type { MigrationSpec } from "../types.js";

// Phase 3 — the ownership migration (RFC-001 §19 Phases 3 and 4).
//
// Note how little is here. Stages 3-5 are generated from the live catalog by
// the engine, so this file states conventions and the handful of assertions the
// generic rules cannot derive. Tables are not listed: every table carrying a
// `userId` column is discovered and verified, including ones added later.

export const ownershipSpec: MigrationSpec = {
  id: "phase-3-ownership",
  title: "RFC-001 Phase 3 — User ownership model",

  requiredMigrations: [
    "20260802000000_add_user_model",
    "20260802010000_add_user_ownership_columns",
    "20260802020000_backfill_ownership",
    "20260802030000_require_ownership",
  ],

  tenant: {
    column: "userId",
    ownerTable: "User",
    ownerKey: "id",
    // No `includeTables`: discovery is the point. Adding one would mean a table
    // introduced by a future migration silently escapes verification.
  },

  customChecks: [
    {
      // Deliberately NOT "at least one User exists". A freshly migrated,
      // never-used database legitimately has none, and asserting otherwise
      // would make the framework fail on exactly the environments the backfill
      // was redesigned to support.
      name: "legacy-owned data has been claimed",
      description:
        "records parked under the legacy migration owner are unreachable until transferred — run `npm run migration:claim`",
      sql: `SELECT t.table_name, t.held
              FROM (
                SELECT 'GmailAccount' AS table_name,
                       count(*) AS held
                  FROM "GmailAccount" x
                  JOIN "User" u ON u.id = x."userId"
                 WHERE u."googleSub" = 'migration:legacy-owner'
                 UNION ALL
                SELECT 'Email', count(*)
                  FROM "Email" x
                  JOIN "User" u ON u.id = x."userId"
                 WHERE u."googleSub" = 'migration:legacy-owner'
                 UNION ALL
                SELECT 'Event', count(*)
                  FROM "Event" x
                  JOIN "User" u ON u.id = x."userId"
                 WHERE u."googleSub" = 'migration:legacy-owner'
              ) t
             WHERE t.held > 0`,
    },
    {
      name: "event keys unique per owner",
      description:
        "RFC-001 §7.4 — eventKey individuates an activity within one User's world, not globally",
      sql: `SELECT "userId", "eventKey", count(*)::int AS occurrences
              FROM "Event"
             GROUP BY "userId", "eventKey"
            HAVING count(*) > 1`,
    },
    {
      name: "eventKey is no longer globally unique",
      description:
        "a leftover global unique index would stop two Users holding an Event for the same placement drive",
      sql: `SELECT i.relname AS index_name
              FROM pg_index x
              JOIN pg_class i ON i.oid = x.indexrelid
              JOIN pg_class t ON t.oid = x.indrelid
             WHERE t.relname = 'Event'
               AND x.indisunique
               AND (SELECT count(*) FROM unnest(x.indkey)) = 1
               AND EXISTS (
                     SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = t.oid
                        AND a.attnum = x.indkey[0]
                        AND a.attname = 'eventKey'
                   )`,
    },
    {
      name: "no User is soft-deleted while owning data",
      description:
        "ownership must point at a live User; a deleted owner leaves records unreachable",
      sql: `SELECT u.id, u.email
              FROM "User" u
             WHERE u."deletedAt" IS NOT NULL
               AND (EXISTS (SELECT 1 FROM "Event" e WHERE e."userId" = u.id)
                 OR EXISTS (SELECT 1 FROM "Email" m WHERE m."userId" = u.id))`,
    },
  ],
};

export default ownershipSpec;
