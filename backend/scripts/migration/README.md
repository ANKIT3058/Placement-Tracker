# Migration Verification Framework

Validates that a database migration **transformed existing data correctly**.

This verifies migration correctness, not application behaviour. It answers "did
the data end up in the shape the migration promised?" — never "does the app
still work?", which is what the test suite is for.

---

## Quick start

```bash
# Transfer data parked under the legacy migration owner to a real account
npm run migration:claim                          # dry run — shows what is held
npm run migration:claim -- --to 2 --apply

# Verify Phase 3 in a disposable sandbox (backup → restore → verify → drop)
npm run migration:verify

# Verify the database in DATABASE_URL in place, read-only.
# Needs no PostgreSQL client tools.
npm run migration:verify -- --direct

# Verify some other database (a staging copy, a restore you made yourself)
npm run migration:verify -- --target postgresql://…

# List and remove leaked sandbox databases
npm run migration:cleanup
npm run migration:cleanup -- --apply
```

Exit codes: `0` pass, `1` verification failed, `2` could not run. Suitable as a
deploy gate in CI.

---

## Modes

| Mode | What it does | Requires |
|---|---|---|
| **sandbox** (default) | Dumps the source, restores into a temporary database, verifies there, drops it | `pg_dump`, `pg_restore` |
| **`--direct`** | Verifies `DATABASE_URL` in place, read-only | nothing beyond the app's own `pg` dependency |
| **`--target <url>`** | Verifies the given database in place, read-only | as above |

Sandbox mode is the default because it proves one thing the others cannot: that
the backup is actually restorable. That is worth knowing *before* a deploy, and
nothing else in the repository tests it.

Direct mode exists so verification is usable without the Postgres client tools
installed. Every check is a `SELECT`; nothing is written in any mode.

---

## Stages

| Stage | Question | How it is derived |
|---|---|---|
| 1. Backup | Can the source be dumped? | `pg_dump --format=custom`, timestamped, never overwritten |
| 2. Sandbox | Is the dump restorable? | `CREATE DATABASE verify_*` + `pg_restore` |
| 3. Migrations Applied | Did the migrations under test actually run? | `_prisma_migrations` vs the spec's `requiredMigrations` |
| 4. Ownership Complete | Does every row have an owner, and is the column `NOT NULL`? | every table carrying the tenant column, discovered from `information_schema` |
| 5. Referential Integrity | Any orphans? | every foreign key in `pg_constraint`, honouring `MATCH SIMPLE` |
| 6. Ownership Consistency | Do related rows agree on their owner? | every FK joining two tables that both carry the tenant column |
| 7. Spec Checks | Anything the generic rules cannot express | the spec's `customChecks` |

Stage 3 exists because verifying a migration's effects against a database that
never ran it produces a confident, meaningless PASS.

Each stage is isolated: one that cannot run is reported as a failure and the
rest still execute, so a run yields the full list of problems rather than the
first one.

---

## Configuration

Only `DATABASE_URL` is required — the same variable Prisma and the application
read. Everything else has a working default.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | The database to verify. **Required.** |
| `MIGRATION_BACKUP_DIR` | `backend/backups/migration` | Where dumps are written (gitignored) |
| `MIGRATION_MAINTENANCE_DB` | `postgres` | Database used to issue `CREATE`/`DROP DATABASE` |
| `MIGRATION_MAINTENANCE_URL` | derived from `DATABASE_URL` | Full override of the above |
| `MIGRATION_TEMP_PREFIX` | `verify_` | Sandbox name prefix — **also the cleanup guard** |
| `MIGRATION_SCHEMA` | `public` | Schema to introspect |
| `MIGRATION_MAX_DETAILS` | `10` | Violations printed per failing check |
| `PG_DUMP` / `PG_RESTORE` | auto-detected | Explicit paths to the client tools |
| `MIGRATION_PG_DOCKER_CONTAINER` | auto-detected | Run the client tools inside this container |

`pg_dump`/`pg_restore` are resolved in this order: environment override → `PATH`
→ standard Windows install directories (`C:\Program Files\PostgreSQL\*\bin`,
where the installer puts them without adding them to `PATH`) → a running Docker
container (auto-detects `placement-db` from `docker-compose.yml`). If none is
found, the error names all four options rather than reporting `ENOENT`.

### Managed Postgres

Sandbox mode issues `CREATE DATABASE`, which needs a direct (non-pooled)
endpoint and a role with `CREATEDB`. On Neon, point `MIGRATION_MAINTENANCE_URL`
at the direct endpoint — the `-pooler` host will reject it. Where that is not
available, use `--direct`.

---

## Safety properties

- **The working database is never written to.** Sandbox mode only reads it, via
  `pg_dump`, which takes no exclusive locks. Direct mode runs `SELECT`s only.
- **Backups are never overwritten.** Filenames carry an ISO timestamp; an
  existing file is an error, not something to clobber. A failed dump deletes its
  own partial file so it can never be mistaken for a usable backup.
- **Destructive statements are guarded twice.** `CREATE`/`DROP DATABASE` runs
  only against a name carrying `MIGRATION_TEMP_PREFIX` and never against the
  source database. `cleanup` re-applies the same assertion per database and is a
  dry run unless given `--apply`.
- **Cleanup failure never masks a result.** A leaked sandbox is recoverable; a
  lost report is not.
- **Credentials stay out of logs and shell history.** Connection strings are
  printed as host + database only, and `--direct` reads `DATABASE_URL` from the
  environment rather than the command line.
- **Backups are gitignored.** They contain real user data.

---

## The ownership backfill and the legacy owner

`20260802020000_backfill_ownership` is a **data** migration; the surrounding
migrations are **schema** migrations. It obeys two rules that make it safe for
Prisma's migration engine:

1. **Nothing to backfill is success.** An empty database — Prisma's shadow
   database, a freshly provisioned environment — returns immediately.
2. **It supplies its own owner.** It never waits for a User to exist, because a
   migration engine cannot cause somebody to complete Google OAuth.

Rows that can inherit ownership do (`Email` → `GmailAccount`, `EventUpdate` →
`Event`, `EmailExtraction`/`Attachment` → `Email`). Rows that cannot — mailboxes,
Events, and Emails ingested before mailbox tracking — go to the sole real User
if exactly one exists, and otherwise to a **legacy owner**: a placeholder with
`googleSub = 'migration:legacy-owner'` and `status = 'disabled'`, so nobody can
authenticate as it.

Data parked there is intact but unreachable until somebody claims it:

```bash
npm run migration:claim                    # what is held, and by whom
npm run migration:claim -- --to 2 --apply  # transfer to User 2
```

The verification spec fails while anything is still parked, so an outstanding
claim cannot be forgotten. The claim is deliberately not part of the migration:
"which account should own data that predates accounts?" is a question about
people, and is not answerable from the database contents.

---

## Adding a spec for a future migration

Most of what a spec would otherwise state is derived from the live catalog, so
a new one is usually small. Write `specs/<name>.spec.ts`:

```ts
import type { MigrationSpec } from "../types.js";

export const archivalSpec: MigrationSpec = {
  id: "phase-4-archival",
  title: "RFC-00X Phase 4 — archival model",

  requiredMigrations: ["20270101000000_add_archive"],

  // Omit `tenant` entirely if the migration is not about ownership;
  // stages 4-6 are then skipped and only custom checks run.
  tenant: { column: "userId", ownerTable: "User", ownerKey: "id" },

  customChecks: [
    {
      name: "archived rows carry an archive reason",
      description: "an archived row without a reason cannot be triaged later",
      sql: `SELECT id FROM "Event" WHERE "archivedAt" IS NOT NULL AND "archiveReason" IS NULL`,
    },
  ],
};
```

Register it in `specs/registry.ts`, then run
`npm run migration:verify -- --spec phase-4-archival`.

**Do not list tables in `includeTables`** unless you mean to exclude the ones you
did not list. Discovery is the default so that a table added by a later
migration is verified without anyone remembering to register it.

---

## Layout

```
scripts/migration/
  verify.ts            CLI entrypoint — orchestrates the stages
  cleanup.ts           CLI entrypoint — removes leaked sandbox databases
  claim-legacy-data.ts CLI entrypoint — transfers legacy-owned data to a User
  config.ts            Configuration resolution from DATABASE_URL
  config-args.ts       Argument parsing
  types.ts             Spec and result types
  lib/
    exec.ts            Process spawning (no shell; args passed as an array)
    pg-tools.ts        pg_dump / pg_restore resolution
    db.ts              Connection helpers and identifier quoting
    introspect.ts      Catalog introspection — the source of every check
    reporter.ts        Stage output and the final report
  stages/
    backup.ts          Stage 1
    sandbox.ts         Stage 2
    checks.ts          Stages 3-7
  specs/
    registry.ts        Spec lookup
    ownership.spec.ts  Phase 3
```

Typecheck with `npm run migration:typecheck`. These scripts have their own
`tsconfig.json` and are excluded from the application build; they run through
`tsx`.
