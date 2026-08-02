# Runbook — Troubleshooting

Engineering Handbook — Operations
Status: operational reference. Symptom-first index.

---

# Purpose

Symptom-first index of failures encountered in this repository. Entries are
organised by **what you observe**, not by which subsystem is at fault — the
subsystem is usually the thing you are trying to work out.

Each entry states symptoms, cause, diagnosis, and resolution. Where a failure
has a fuller treatment in another runbook, this file carries the short form and
links.

---

# When to Use

Something is broken and you do not yet know what. Start here, then follow the
link into the specific runbook.

If you know the area already, go directly to
[authentication.md](authentication.md), [google-cloud.md](google-cloud.md),
[local-development.md](local-development.md), or
[migrations.md](migrations.md).

---

# Prerequisites

Before diagnosing anything, establish the baseline. Most reported failures are
one of these four being false.

```bash
cd backend
curl http://localhost:3000/health     # {"status":"ok","database":"connected"}
npm run test:redis                    # round-trips a key, exits 0
npx prisma migrate status             # "Database schema is up to date!"
npx prisma generate                   # client exists and is current
```

---

# Index

| Symptom | Section |
|---|---|
| `401` on every protected route | [Authentication](#authentication) |
| `403` at sign-in | [Authentication](#authentication) |
| `redirect_uri_mismatch` | [Google OAuth](#google-oauth) |
| `access_denied` at consent | [Google OAuth](#google-oauth) |
| `invalid_grant`, sync stops | [Google OAuth](#google-oauth) |
| Dashboard empty after signing in | [Data and ownership](#data-and-ownership) |
| Shadow database failure | [Prisma and migrations](#prisma-and-migrations) |
| `schema.prisma` lost its models | [Prisma and migrations](#prisma-and-migrations) |
| `P1001` cannot reach database | [Prisma and migrations](#prisma-and-migrations) |
| `ECONNREFUSED …:6379` | [Redis](#redis) |
| Jobs enqueue, never process | [BullMQ workers](#bullmq-workers) |
| `npm test` will not start (Windows) | [Toolchain](#toolchain) |
| `Cannot find module 'generated/prisma'` | [Toolchain](#toolchain) |

---

# Authentication

### `401 Authentication required` on every protected route

**Symptoms.** Sign-in appears to succeed; `/event`, `POST /gmail/sync`, and
`POST /email` all return `401`. The frontend dashboard is blank.

**Cause.** In order of likelihood:

1. **The client does not send cookies.** `client/src/api/eventApi.ts` calls
   `fetch` without `credentials: "include"`. Known gap — the client was not
   updated for Phase 3.
2. `FRONTEND_URL` does not match the browser origin, so CORS rejects the
   credentialed request.
3. Redis was restarted or flushed; sessions do not survive.
4. The session passed its 30-day absolute lifetime.

**Diagnosis.**

```bash
redis-cli KEYS 'sess:*'                                   # session exists?
curl -i http://localhost:3000/event -b "placement.sid=<cookie>"
```

If `curl` succeeds and the browser does not, it is cause 1 or 2. If the Redis key
is absent, it is 3 or 4.

**Resolution.** For cause 1, add `credentials: "include"` to the client's fetch
calls — not fixable from the backend. Otherwise align `FRONTEND_URL` with the
browser origin, or sign in again.

---

### `403 This Google account cannot be used to sign in`

**Symptoms.** Consent completes; the callback returns `403`.

**Cause.** Either `email_verified` is false on the Google ID token, or the
resolved `User` has `status ≠ active`.

**Diagnosis.** Backend log: `[gmail-callback] Identity refused: …` names which.

**Resolution.** Verify the address with Google, or set `status = 'active'` on
the `User` row.

---

### `500 Authentication check failed`

**Symptoms.** Protected routes return `500`, not `401`.

**Cause.** PostgreSQL was unreachable while `requireAuth` loaded the user. This
is deliberately not a `401` — the session is valid and must not be discarded
over a transient outage.

**Resolution.** Restore the database. No re-authentication needed.

---

### Signed in, then immediately signed out again

**Symptoms.** The session works once, then `401`.

**Cause.** `requireAuth` destroys the session when the user is deleted,
soft-deleted, or not `active`. It also destroys it past the absolute lifetime.

**Diagnosis.** Backend log carries the reason — `Session references a deleted
user`, `Session user N is disabled`, or `Session past absolute lifetime`. The
HTTP response deliberately does not.

**Resolution.** Fix the `User` row, or sign in again.

Full treatment: [authentication.md](authentication.md).

---

# Google OAuth

### `redirect_uri_mismatch`

**Symptoms.** Google refuses before showing consent.

**Cause.** `GOOGLE_REDIRECT_URI` and the registered URI differ. Usual culprits:
`127.0.0.1` vs `localhost`, a missing port, a trailing slash, `http` vs `https`.

**Diagnosis.** Compare `.env` against **APIs & Services → Credentials → the
OAuth client → Authorized redirect URIs**. Byte-for-byte.

**Resolution.** Make them identical; restart the backend. Both must resolve to
`GET /gmail/callback`.

---

### `access_denied` — "app has not completed the Google verification process"

**Cause.** The signing-in account is not on the test user list while the OAuth
app is in Testing mode.

**Resolution.** Add it under **OAuth consent screen → Test users**. Effective
immediately; no restart.

---

### `Google did not return an ID token`

**Symptoms.** Consent succeeds, callback returns `500`.

**Cause.** The `openid` scope is missing from the consent screen or was not
granted.

**Resolution.** Add `openid`, then revoke the app at
[Google Account → Third-party access](https://myaccount.google.com/permissions)
so the next consent re-prompts for the full scope set.

---

### `invalid_grant` — sync stops, sign-in still works

**Symptoms.** `POST /gmail/sync` returns `200` but the mailbox appears as
`{"status":"failed","error":"invalid_grant"}`. Logs show
`[gmail-sync] Failed to sync mailbox <address> for user <id>` or
`[gmail-scheduler] Failed to sync account <address>`. No new emails. Sessions
unaffected — this is a Google grant failure, not an authentication failure.

**Cause.** The stored refresh token is no longer accepted:

| Trigger | Notes |
|---|---|
| **OAuth app in Testing mode** | Refresh tokens expire after **7 days**. The usual cause here |
| User revoked access | Google Account → Security → Third-party access |
| Token unused 6 months | Google expires idle tokens |
| Client secret rotated | Invalidates all existing tokens |
| Test user removed | Access withdrawn immediately |

**Diagnosis.**

```sql
SELECT id, email, "userId", length("refreshToken") FROM "GmailAccount";
```

A token that is present but rejected is a revocation, not misconfiguration. Then
check the consent screen's publishing status.

**Resolution.** Reconnect: visit `http://localhost:3000/gmail/auth` and complete
consent. The stored token is overwritten in place; ownership and email history
are preserved. **Do not delete the `GmailAccount` row** — it cascades and
destroys the linked `Email` history.

**Permanent fix.** Publish the OAuth app, which for `gmail.readonly` requires
Google verification. See [google-cloud.md](google-cloud.md#publishing-status).

---

# Prisma and migrations

### `prisma migrate dev` fails in the shadow database

**Symptoms.** The chain works against the real database; `migrate dev` aborts
with an error raised by a data migration.

**Cause.** A migration assumed data or application state. Prisma replays every
migration against an **empty** shadow database.

**Resolution.** Make the migration return early when there is nothing to do, and
supply its own inputs rather than requiring a `User` to exist. See
[migrations.md](migrations.md#the-shadow-database-constraint).

---

### `schema.prisma` lost its models

**Symptoms.** After a failed `migrate dev`, models you wrote are gone and the
file matches the *database* instead. Observed in Phase 3: the whole `User`
model, every `userId`, the composite foreign keys, and the `MailProvider` enum
disappeared.

**Cause.** The failure path ran an introspection (`db pull`) that overwrote the
schema.

**Diagnosis.**

```bash
grep -c "model User" backend/prisma/schema.prisma      # 0 = clobbered
git diff --stat backend/prisma/schema.prisma
```

**Resolution.**

```bash
git checkout -- backend/prisma/schema.prisma && npx prisma validate
```

**Prevention.** Commit schema changes before running `migrate dev`. The loss is
silent.

---

### `P1001: Can't reach database server`

**Cause.** With a `*.neon.tech` host, almost always auto-suspend — Neon pauses
idle instances and the first connection fails while it wakes.

**Resolution.** Retry once. If it persists, check the Neon dashboard, or
`docker compose ps` for a local database.

---

### `column "userId" … contains null values`

**Cause.** The constraint migration ran without the backfill having completed.

**Diagnosis.** `SELECT count(*) FROM "Event" WHERE "userId" IS NULL;`

**Resolution.** Re-run `npx prisma migrate deploy`. A gap in the sequence means
an earlier migration failed — read that error, not this one.

---

### `pg_dump was not found`

**Cause.** PostgreSQL client tools absent or not on `PATH`. On Windows the
installer does not add them.

**Resolution.** Set `PG_DUMP`, start the Docker Postgres container, or use
`npm run migration:verify -- --direct`, which needs no external tools.

---

### Verification reports `FAIL` with every ownership check green

**Cause.** Stage 3 — `_prisma_migrations` does not record the migrations. They
are pending, or the SQL was applied outside Prisma.

**Resolution.** `npx prisma migrate deploy`. This is the correct result when
migrations are genuinely pending.

Full treatment: [migrations.md](migrations.md).

---

# Data and ownership

### Signed in successfully; dashboard is empty

**Symptoms.** `GET /event` returns `200` and `[]`. Data is visibly present in
Prisma Studio.

**Cause.** Ownership. Either the rows belong to the **legacy migration owner**
(the backfill could not derive a real owner), or they belong to a different
`User`. Event reads are tenant-scoped: an authenticated caller sees only their
own rows.

**Diagnosis.**

```bash
npm run migration:claim            # dry run: what the legacy owner holds
```

or:

```sql
SELECT u.id, u."googleSub", u.status,
       (SELECT count(*) FROM "Event" e WHERE e."userId" = u.id) AS events
  FROM "User" u ORDER BY u.id;
```

A user with `googleSub = 'migration:legacy-owner'` holding all the rows confirms
it.

**Resolution.**

```bash
npm run migration:claim -- --to <yourUserId> --apply
```

---

### An authenticated user sees another user's data

**Symptoms.** Cross-tenant rows appear in a response.

**Cause.** A repository query without a tenant predicate. Event and Email reads
are scoped; if a new query was added without threading `TenantContext`, it is
not.

**Diagnosis.**

```bash
npm run migration:verify -- --direct        # ownership consistency stage
```

Then inspect the query for a missing `userId` predicate.

**Resolution.** Thread `TenantContext` through the service and scope the query.
This is an architectural invariant — RFC-001 §7.4, §9.2 — not a preference.

---

### Two users cannot both hold an event for the same drive

**Cause.** `Event.eventKey` is still globally unique — the Phase 3 constraint
migration was not applied.

**Diagnosis.**

```bash
npm run migration:verify -- --direct
# fails: "eventKey is no longer globally unique"
```

**Resolution.** Apply `20260802030000_require_ownership`.

---

# Redis

### `ECONNREFUSED 127.0.0.1:6379`

**Cause.** Redis is not running, or `REDIS_URL` is unset and ioredis fell back to
its default. **The compose file does not provide Redis.**

**Resolution.**

```bash
docker run -d --name placement-redis -p 6379:6379 redis:7
```

Note the two clients fail at different times: the BullMQ client connects eagerly
and fails at boot; the session client connects lazily and fails at first
sign-in.

---

### Sessions vanish on restart

**Cause.** Redis restarted without persistence, or was flushed. Sessions are
stored only in Redis.

**Resolution.** Sign in again. For development this is expected; enable Redis
persistence if it becomes tedious.

---

### `maxRetriesPerRequest must be null`

**Cause.** BullMQ requires it on its ioredis connection. Already set in
`redis.ts`. If you construct your own queue client, mirror it — but **do not**
copy it to the session client, which deliberately fails fast (3 retries) so a
Redis outage produces failed requests rather than hung ones.

---

# BullMQ workers

### Jobs enqueue but never process

**Symptoms.** Emails are stored; extraction and events never appear.

**Cause.** Workers are not running. They are separate processes and the API does
not warn when a queue has no consumer.

**Diagnosis.**

```bash
redis-cli LLEN bull:email-processing:wait     # grows, never drains
```

**Resolution.**

```bash
npm run worker:email
npm run worker:attachment
```

---

### Worker fails a job with `Ownership mismatch on email N`

**Symptoms.** Job fails permanently and is not retried.

**Cause.** The `userId` in the job payload disagrees with the owner on the
persisted `Email`. Queue payloads are treated as untrusted; the worker
re-derives ownership from the database and refuses on disagreement. It throws
`UnrecoverableError`, so no retry occurs — neither a forged payload nor a broken
upstream invariant is fixable by repetition.

**Diagnosis.** Compare the payload against `SELECT "userId" FROM "Email" WHERE
id = N`.

**Resolution.** Investigate what enqueued the job. This should be unreachable in
normal operation; if it fires, an ownership invariant broke upstream.

---

### No queue dashboard

`@bull-board/api` and `@bull-board/express` are declared dependencies but are
**imported nowhere**. There is no dashboard route. Use `redis-cli` or Prisma
Studio.

---

# Toolchain

### `npm test`: "Module ts-jest in the transform option was not found" (Windows)

**Symptoms.** Jest will not start. `ts-jest` is installed and resolvable.

**Cause.** Jest 30 resolves modules through the native `unrs-resolver`, which
needs the Visual C++ 2015–2022 Redistributable (x64). When the addon fails to
load, Jest reports the transform as missing — a misleading message.

**Diagnosis.**

```bash
node -e "require('unrs-resolver')"     # throws
```

**Resolution.** Install the Visual C++ 2015–2022 Redistributable (x64). Full
analysis, including rejected alternatives, in
`Development_Environment.md` → *Testing*.

---

### `Cannot find module '../../generated/prisma/client.js'`

**Cause.** The Prisma client has not been generated. `generated/prisma` is
gitignored and absent from a fresh clone.

**Resolution.** `npx prisma generate`.

---

### `ERR_MODULE_NOT_FOUND` from `dist/generated/…` after a build

**Cause.** `scripts/fix-esm-imports.js` did not run. Prisma emits extensionless
imports that Node's ESM loader rejects.

**Resolution.** Use `npm run build`, not bare `tsc`.

---

### `Cannot find name 'jest' / 'describe'` in test files

**Cause.** Expected, not a defect. `tsconfig.json` excludes `__tests__` and
declares `types: ["node"]`; ts-jest supplies the globals at test time.

**Resolution.** None. `npx tsc --noEmit` is clean.

---

# Recovery

| Goal | Command |
|---|---|
| Clear all sessions | `redis-cli --scan --pattern 'sess:*' \| xargs redis-cli DEL` |
| Clear all queues | `redis-cli --scan --pattern 'bull:*' \| xargs redis-cli DEL` |
| Restore a clobbered schema | `git checkout -- backend/prisma/schema.prisma` |
| Drop leaked sandbox databases | `npm run migration:cleanup -- --apply` |
| Reclaim legacy-owned data | `npm run migration:claim -- --to <id> --apply` |
| Full local reset | [local-development.md](local-development.md#recovery) |

---

# Still undocumented

Operational knowledge this repository does not yet capture. Recorded so the gaps
are visible rather than discovered under pressure.

**No source material was available for some of it.** The notes/PDF referenced
when these runbooks were commissioned **did not arrive with the request**. Any
prior incident history, Google Cloud project identifiers, or account ownership
recorded only there is absent from this documentation.

| Gap | Why it matters |
|---|---|
| **Production deployment** | No hosting, deploy, or rollback procedure exists. Nothing describes how this runs anywhere but a laptop |
| **CI** | No workflow configuration in the repository. The 120-test suite runs only when someone remembers |
| **Monitoring and alerting** | RFC-001 §20 lists required signals — auth failure rates, per-mailbox sync health, tenant-guard violations. None are instrumented |
| **Backup and restore policy** | The verification framework takes ad-hoc dumps. There is no schedule, no retention, and no tested restore |
| **Secret management** | Secrets live in `.env`. No rotation schedule, no vault, no procedure beyond [google-cloud.md](google-cloud.md) |
| **Neon operations** | Branching, PITR, and the direct-vs-pooled endpoint distinction are used but not documented |
| **Incident response** | No severity definitions, no escalation, no postmortem template |
| **Data deletion** | RFC-001 §8.3 and §16.4 require a deletion path for Google restricted-scope compliance. Not implemented, not documented |
| **`invalid_grant` reproduction** | Documented from Google's behaviour and the code paths, **not reproduced here**. Confirm against a real occurrence |
| **Load and capacity** | No known throughput limits for sync, extraction, or the queues |

---

# Related Documents

- [authentication.md](authentication.md)
- [google-cloud.md](google-cloud.md)
- [local-development.md](local-development.md)
- [migrations.md](migrations.md)
- [Development_Environment.md](../03_Development/Development_Environment.md) —
  toolchain and Windows prerequisites in depth
- [RFC-001](../rfcs/RFC-001-authentication-multi-user-foundation.md)

---

# Confidence

**High for failures encountered here.** Reproduced or observed directly during
Phase 3: the shadow-database failure, `schema.prisma` clobbered by `db pull`,
`P1001` on Neon, `pg_dump was not found`, `required migrations: N of N not
applied`, the Jest/`unrs-resolver` failure, and the missing Prisma client. Log
lines, error strings, and commands are quoted from source or from actual output.

**Medium for Google OAuth failures.** `redirect_uri_mismatch`, `access_denied`,
and `invalid_grant` were **not reproduced in this environment**. Their triggers
are Google's documented behaviour; the log lines and response shapes are read
from `gmail.sync.service.ts`, `gmail.scheduler.ts`, and `gmail.controller.ts`
and are accurate. The 7-day refresh token expiry in Testing mode is Google
policy — re-check it against current documentation.

**Medium for the client-side `401`.** The missing `credentials: "include"` was
confirmed by reading `client/src/api/eventApi.ts`. The browser symptom was not
reproduced.

**Not verified.** `Ownership mismatch on email N` has never fired — it is read
from `email.worker.ts` and is expected to be unreachable in normal operation.
