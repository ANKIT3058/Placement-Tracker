# Runbook — Migrations

Engineering Handbook — Operations
Status: operational reference. Verified against the working tree at Phase 3 completion.

---

# Purpose

How to apply, verify, and recover database migrations, and how to operate the
migration verification framework under `backend/scripts/migration/`.

Covers the Prisma workflow, the shadow-database constraint that shapes every
data migration in this repository, and the specific failures encountered during
Phase 3.

---

# When to Use

- Applying pending migrations to any database
- Authoring a migration that touches data, not only schema
- `prisma migrate dev` fails on the shadow database
- Verifying that a migration transformed existing data correctly
- Recovering from a partially applied or failed migration
- The dashboard is empty after a migration

---

# Prerequisites

- `backend/.env` with **both** `DATABASE_URL` (pooled) and `DIRECT_DATABASE_URL`
  (direct) naming the intended database
- `npx prisma generate` has been run
- For sandbox verification only: `pg_dump` and `pg_restore` on `PATH`, or
  `PG_DUMP`/`PG_RESTORE` set, or a running Postgres container

> The Prisma CLI reads **`DIRECT_DATABASE_URL`** (via `prisma.config.ts`); the
> application runtime reads `DATABASE_URL`. Migrate needs the unpooled endpoint
> because it takes a session-level advisory lock that a transaction pooler cannot
> hold. Point both at the same database — a mismatch means migrations alter one
> database while the API talks to another, silently. Confirm the
> `Datasource "db": …` line the CLI prints before acting; it echoes the direct
> host.

---

# Migration inventory

18 migrations. The last four constitute Phase 3.

| Migration | Kind | Effect |
|---|---|---|
| `20260802000000_add_user_model` | schema | Creates `User` |
| `20260802010000_add_user_ownership_columns` | schema | Nullable `userId` on six tables, `MailProvider` enum, indexes |
| `20260802020000_backfill_ownership` | **data** | Assigns an owner to every existing row |
| `20260802030000_require_ownership` | schema | `NOT NULL`, composite foreign keys, `@@unique([userId, eventKey])` |

Schema and data are deliberately separate migrations so either can be reasoned
about, replayed, or rolled back without the other.

---

# Procedure — apply migrations

## Development

```bash
cd backend
npx prisma migrate status            # what is pending, and against which database
npx prisma migrate dev               # apply + regenerate client
```

`migrate dev` replays the **entire chain against a temporary shadow database**
to detect drift. Every migration must therefore succeed against an empty
database — see *The shadow database constraint*.

## Shared or production database

```bash
npx prisma migrate deploy
```

`deploy` applies pending migrations without a shadow database and without reset.
**Use this against any database whose data matters.**

## Verify afterwards

```bash
npm run migration:verify -- --direct
```

Expected: `Migration Status: PASS`. See *Migration verification framework*.

---

# The shadow database constraint

The single most important rule for authoring migrations in this repository.

Prisma replays every migration against an empty shadow database. A migration
that **requires** data — or requires application state, such as a user having
completed Google OAuth — cannot survive that replay and will also fail on every
freshly provisioned environment.

Two rules follow. `20260802020000_backfill_ownership` is the worked example.

**1. Nothing to do is success.** A data migration inspects the data first and
returns immediately when there is nothing to change.

```sql
IF pending = 0 THEN
  RAISE NOTICE 'nothing to backfill';
  RETURN;
END IF;
```

**2. A migration supplies its own inputs.** It never waits for application state
a migration engine cannot cause. Where the ownership backfill cannot derive an
owner from a parent row, it mints a clearly-marked **legacy owner** rather than
requiring a real `User` to exist:

| Field | Value |
|---|---|
| `googleSub` | `migration:legacy-owner` — a real Google subject is numeric, so this can never collide |
| `status` | `disabled` — `requireAuth` rejects it; nobody can sign in as it |
| `email` | `legacy-data-owner@migration.invalid` (RFC 2606 reserved TLD) |

The result is **deterministic** — the outcome is a function of database contents
alone — and **idempotent**, so a re-run after a partial failure converges.

The trade-off: on a populated database, data may land on the placeholder and
require an explicit claim step. That is preferred over the alternatives —
aborting makes the chain fail on state, and auto-assigning to an arbitrary user
guesses at an answer whose mis-attribution is unrecoverable.

---

# Procedure — claim legacy data

Run when sign-in succeeds but the dashboard is empty after a migration.

```bash
cd backend
npm run migration:claim                        # dry run: what is held, and by whom
npm run migration:claim -- --to <userId> --apply
```

The dry run lists holdings per table and every candidate user with its id. The
apply step moves all six tables in one transaction; the destination must exist,
must not be deleted, and must be `active`.

Composite foreign keys are `ON UPDATE CASCADE`, so moving a parent drags its
children. A child table reporting `0 moved` means the cascade got there first,
not that rows were missed — confirm with the final counts.

The legacy owner row is left in place, disabled and owning nothing. It is
harmless and records that a migration occurred.

---

# Migration verification framework

Validates that a migration **transformed existing data correctly**. It verifies
migration correctness, not application behaviour.

Full documentation: [`backend/scripts/migration/README.md`](../../backend/scripts/migration/README.md).

## Commands

| Command | Purpose |
|---|---|
| `npm run migration:verify` | Sandbox: back up → restore into a temp database → verify → drop |
| `npm run migration:verify -- --direct` | Verify `DATABASE_URL` in place, read-only, no external tools |
| `npm run migration:verify -- --target <url>` | Verify a specific database, read-only |
| `npm run migration:cleanup` | List leaked sandbox databases (`--apply` to drop) |
| `npm run migration:claim` | Transfer legacy-owned data |
| `npm run migration:typecheck` | Typecheck the tooling |

Exit codes: `0` pass, `1` verification failed, `2` could not run. Usable as a
CI deploy gate.

## Stages

| Stage | Question |
|---|---|
| 1. Backup | Can the source be dumped? (`pg_dump --format=custom`, timestamped, never overwritten) |
| 2. Sandbox | Is the dump restorable? (`CREATE DATABASE verify_*` + `pg_restore`) |
| 3. Migrations Applied | Did the migrations under test actually run? (`_prisma_migrations`) |
| 4. Ownership Complete | Does every row have an owner, and is the column `NOT NULL`? |
| 5. Referential Integrity | Any orphans, across every foreign key in the schema? |
| 6. Ownership Consistency | Do related rows agree on their owner? |
| 7. Spec Checks | Assertions the generic rules cannot express |

Stages 4–6 are **derived from the live catalog**, not hardcoded: any table
carrying a `userId` column is discovered automatically, and any foreign key
joining two such tables is checked for ownership agreement. A table added by a
future migration is verified without anyone registering it.

Stage 3 exists because verifying a migration's effects against a database that
never ran it produces a confident, meaningless PASS.

## Modes

Sandbox mode is the default because it proves the backup is **restorable** —
worth knowing before a deploy, and not otherwise tested anywhere. It needs
`pg_dump`/`pg_restore`.

`--direct` exists so verification is usable without the Postgres client tools.
Every check is a `SELECT`; nothing is written in any mode.

## Safety

- The working database is never written to
- Backups are never overwritten; a failed dump deletes its own partial file
- `CREATE`/`DROP DATABASE` runs only against names carrying the `verify_` prefix
  and never against the source database
- `cleanup` is a dry run unless given `--apply`
- Backups land in `backend/backups/` and are gitignored — they contain real data

## Managed Postgres

Sandbox mode issues `CREATE DATABASE`, which needs a direct (non-pooled)
endpoint and a role with `CREATEDB`. **On Neon the `-pooler` host rejects it** —
point `MIGRATION_MAINTENANCE_URL` at the direct endpoint, or use `--direct`.

---

# Verification

| Check | Command | Expected |
|---|---|---|
| Pending migrations | `npx prisma migrate status` | `Database schema is up to date!` |
| Ownership integrity | `npm run migration:verify -- --direct` | `Migration Status: PASS` |
| Schema shape | `npx prisma studio` | `User` exists; `Event.userId` is `NOT NULL` |
| No leaked sandboxes | `npm run migration:cleanup` | `No sandbox databases … to clean up` |
| Application still builds | `npx tsc --noEmit` | no output |
| Tests | `npm test` | 7 suites, 120 tests, 0 failures |

---

# Common Failures

These were all encountered during Phase 3.

### `prisma migrate dev` fails inside the shadow database

**Symptom.** The chain applies to the real database but `migrate dev` aborts
with an error raised by a data migration.

**Cause.** A migration assumed data or application state. The original ownership
backfill raised `no User exists to own existing records` — true on the shadow
database, which is empty by construction.

**Resolution.** Rewrite the migration to follow the two rules in *The shadow
database constraint*. Verify by replaying against an empty database.

---

### `prisma migrate dev` silently reverted `schema.prisma`

**Symptom.** After a failed `migrate dev`, `schema.prisma` no longer contains
models you wrote — it matches the *database* instead. Observed in Phase 3: the
entire `User` model, every `userId`, the composite foreign keys, and the
`MailProvider` enum vanished from the working copy.

**Cause.** The failure path performed an introspection (`db pull`), overwriting
the schema file with the shape of the un-migrated database.

**Diagnosis.**

```bash
grep -c "model User" backend/prisma/schema.prisma       # 0 = clobbered
git diff --stat backend/prisma/schema.prisma
```

**Resolution.**

```bash
git checkout -- backend/prisma/schema.prisma
npx prisma validate
```

**Prevention.** Commit schema changes before running `migrate dev`. This failure
is silent and destroys uncommitted schema work.

---

### `P1001: Can't reach database server`

**Symptom.** Every Prisma command fails; the host is a `*.neon.tech` address.

**Cause.** Neon auto-suspends when idle. The first connection after a pause
fails; the next succeeds.

**Resolution.** Retry once. If it persists, check the Neon dashboard.

---

### `column "userId" of relation "Event" contains null values`

**Symptom.** `20260802030000_require_ownership` fails partway through.

**Cause.** The backfill did not run, or did not complete, so `SET NOT NULL` has
nulls to reject.

**Diagnosis.**

```sql
SELECT count(*) FROM "Event" WHERE "userId" IS NULL;
```

**Resolution.** Establish why the backfill was skipped — usually the constraint
migration ran against a database where the data migration was not applied.
Re-run `npx prisma migrate deploy`. Prisma applies migrations in order, so a
gap means the earlier one failed and its error is the real one to read.

---

### `pg_dump was not found`

**Symptom.** `npm run migration:verify` fails immediately in sandbox mode.

**Cause.** PostgreSQL client tools are not installed or not on `PATH`. On
Windows the installer places them in `C:\Program Files\PostgreSQL\<v>\bin`
without adding them to `PATH`.

**Resolution.** Any one of:

```bash
# 1. Point at them explicitly
PG_DUMP="C:/Program Files/PostgreSQL/16/bin/pg_dump.exe" npm run migration:verify

# 2. Use the docker container
docker compose up -d                 # framework auto-detects "placement-db"

# 3. Skip stages 1-2 entirely
npm run migration:verify -- --direct
```

---

### Verification reports `required migrations: N of N not applied`

**Symptom.** Every ownership check passes but the report is `FAIL`.

**Cause.** `_prisma_migrations` does not record the migrations. Either they were
genuinely never applied, or the SQL was executed directly rather than through
Prisma.

**Resolution.** If pending, `npx prisma migrate deploy`. If the effects are
clearly present, the database was migrated outside Prisma and its migration
history is inconsistent — see *Recovery*.

---

### Editing an already-applied migration

**Symptom.** Prisma reports that a migration's checksum does not match.

**Cause.** Migration files are hashed when applied. Editing one afterwards makes
the recorded checksum wrong.

**Resolution.** Never edit an applied migration; add a new one. If the edit is
already made and the migration was applied only locally, reset the local
database. On a shared database, `npx prisma migrate resolve` is the escape
hatch — treat it as a last resort and record why.

---

# Recovery

## A migration failed partway

Every migration file runs inside a transaction, so a failure rolls back that
file. Earlier migrations in the same `deploy` remain applied.

```bash
npx prisma migrate status            # identifies the first failed migration
```

Fix the cause, then re-run `npx prisma migrate deploy`. Do not skip the failed
migration.

## Restore from a verification backup

Sandbox verification leaves a timestamped dump in `backend/backups/migration/`.

```bash
pg_restore --clean --if-exists --no-owner --no-privileges \
           --dbname="$DATABASE_URL" \
           backend/backups/migration/<file>.dump
```

**`--clean` drops existing objects.** Confirm the target before running it.

## Leaked sandbox databases

A crashed run or `--keep` leaves `verify_*` databases behind.

```bash
npm run migration:cleanup                        # list
npm run migration:cleanup -- --apply             # drop
npm run migration:cleanup -- --older-than-hours 24 --apply
```

Only names carrying the `verify_` prefix are ever considered, and each is
re-checked against the same assertion the verifier uses.

## Local database reset

```bash
docker compose down -v && docker compose up -d
npx prisma migrate deploy
```

Destroys all local data. Never against Neon or a shared database.

## Migration history inconsistent with the schema

If the database has the right shape but `_prisma_migrations` disagrees:

```bash
npx prisma migrate resolve --applied <migration_name>
```

Marks a migration as applied without running it. Use only when the effects are
verifiably already present — confirm with `npm run migration:verify -- --direct`
first — and record why.

---

# Authoring a data migration

Checklist, derived from what Phase 3 got wrong first.

1. **Empty database must succeed.** Guard on a count; return early.
2. **No dependency on application state.** No user, no session, no external
   service. Mint what you need or derive it from data.
3. **Idempotent.** `ON CONFLICT DO NOTHING`, `WHERE … IS NULL`. A re-run after a
   partial failure must converge.
4. **Deterministic.** Fixed sentinels, not `gen_random_uuid()`, so two databases
   replaying the same migration produce identical rows.
5. **Verify inside the migration.** `RAISE EXCEPTION` on inconsistency, so the
   transaction rolls back while it still can. Every check must be vacuously true
   on an empty database.
6. **Separate from schema changes.** DDL and DML in different files.
7. **Replay it against an empty database** before committing.

---

# Related Documents

- [`backend/scripts/migration/README.md`](../../backend/scripts/migration/README.md) —
  full framework documentation
- [RFC-001 §12, §19](../rfcs/RFC-001-authentication-multi-user-foundation.md) —
  schema design and the phased migration strategy
- [local-development.md](local-development.md) — database setup, Neon notes
- [authentication.md](authentication.md) — empty dashboard after migration
- [troubleshooting.md](troubleshooting.md) — symptom-first index

---

# Confidence

**High for the framework.** Commands, stages, modes, exit codes, and safety
properties were read from `backend/scripts/migration/` and exercised: the
framework was run in `--direct` mode against the live database, and the full
migration chain was replayed against three scratch databases (empty, seeded
with legacy data, and post-claim). Empty replay produced `PASS`; the seeded
replay produced the legacy owner and passed every ownership check; the claim
transferred all rows and the check turned green.

**High for the failures.** Every entry under *Common Failures* was encountered
in this repository except two: `column … contains null values` and the migration
checksum mismatch, which are documented from Prisma and PostgreSQL behaviour
rather than from an incident here.

**Verified by execution:** shadow-database replay, `P1001` on Neon,
`schema.prisma` clobbered by `db pull` (and recovered with `git checkout`),
`pg_dump was not found`, and `required migrations: 4 of 4 not applied`.

**Not verified:** the `pg_restore` recovery command was not executed — no backup
was taken, because `pg_dump` is unavailable on this machine. `migrate resolve`
was not run.

**State at the time of writing:** the four Phase 3 migrations were **pending**
on the configured database. `npm run migration:verify -- --direct` reported
`FAIL` for that reason, which is the correct result and demonstrates stage 3
working as intended.
