# Runbook — Local Development

Engineering Handbook — Operations
Status: operational reference. Verified against the working tree at Phase 3 completion.

---

# Purpose

How to start the stack, in what order, and how to confirm each process is
actually healthy rather than merely running.

**This runbook does not replace
[Development_Environment.md](../03_Development/Development_Environment.md)**,
which is the canonical setup contract: required software, dependency inventory,
the full environment variable table, Windows prerequisites, and the Jest native
resolver analysis. Read that first, once. Return here for the daily loop and for
what Phase 3 changed.

---

# When to Use

- Daily startup
- Verifying a checkout after `npm install` or a branch switch
- A process starts but nothing happens
- Confirming infrastructure before debugging application behaviour

---

# Prerequisites

Per `Development_Environment.md`:

- Node 24.x, npm 11.x
- PostgreSQL 16 (bundled compose file, or any instance)
- **Redis — not in the compose file; you must provide it**
- Windows only: Visual C++ 2015–2022 Redistributable (x64), or `npm test`
  cannot start
- `backend/.env` and `client/.env` present
- `npx prisma generate` has been run — `generated/prisma` is gitignored and
  absent from a fresh clone

---

# Topology

| Process | Command (from `backend/`) | Port | Consumes |
|---|---|---|---|
| API + Gmail scheduler | `npm run dev` | 3000 | PostgreSQL, Redis (sessions), Gmail API |
| Email worker | `npm run worker:email` | — | Redis (`email-processing`), PostgreSQL, OpenAI (optional) |
| Attachment worker | `npm run worker:attachment` | — | Redis (`attachment-processing`), PostgreSQL, Gmail API |
| Frontend | `npm run dev` (from `client/`) | 5173 | API |

The Gmail scheduler runs **inside the API process** — `server.ts` calls
`startGmailScheduler()` after `listen`. There is no separate scheduler process
and no HTTP route that starts or stops it.

Workers are separate processes. The API enqueues jobs and **does not warn when
nothing is consuming a queue**: without workers, emails are captured and never
interpreted.

---

# Environment variables

`Development_Environment.md` carries the full table. Phase 3 added four; only
these are new.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SESSION_SECRET` | **Production only** | insecure dev default, with a warning | Session cookie signing. Comma-separated list supports rotation |
| `SESSION_REDIS_URL` | No | falls back to `REDIS_URL` | Session store connection. Point at a separate instance in production |
| `SESSION_COOKIE_DOMAIN` | No | unset | Cookie `Domain`. Set only when API and frontend are on different hosts under one registrable domain |
| `NODE_ENV` | No | unset | `production` enables `Secure` cookies, `trust proxy`, and the hard failure on a missing `SESSION_SECRET` |

Locally, all four can be left unset. The backend logs
`[session] SESSION_SECRET is unset — using an insecure development default`
on startup, which is expected in development and a **hard startup failure** in
production.

## Redis: two logical uses, one instance locally

| Use | Client | Key prefix | Requirement |
|---|---|---|---|
| BullMQ queues | `redis.ts` | `bull:` | `maxRetriesPerRequest: null` |
| Sessions | `session-redis.ts` | `sess:` | fails fast (3 retries); connects lazily |

They share one Redis locally and cannot collide — the prefixes are disjoint.
**In production they must be separate instances**: BullMQ requires
`maxmemory-policy noeviction` (an evicted job key is a lost job), and a session
store is commonly deployed with an eviction policy. See RFC-001 §11.5.

The session client uses `lazyConnect`, so it opens no socket until the first
session operation. A Redis outage therefore surfaces at first sign-in, not at
boot.

## Neon

The configured `DATABASE_URL` in this checkout points at a **Neon** serverless
Postgres instance, not the compose container.

Operational consequences:

- **Neon auto-suspends when idle.** The first connection after a pause fails or
  is slow; the second succeeds. A `P1001` on a previously-working database is
  usually a cold start, not an outage — retry once before investigating.
- The `-pooler` host does **not** support `CREATE DATABASE`. Migration sandbox
  mode needs a direct endpoint — see [migrations.md](migrations.md).
- Compose still provisions `postgres:16` on host port 5435 if you prefer a local
  database. Point `DATABASE_URL` at it; nothing else changes.

---

# Procedure — start the stack

Order matters. Each step depends on the previous one.

### 1. Infrastructure

```bash
cd backend
docker compose up -d                 # PostgreSQL, host port 5435 (skip if using Neon)
docker run -d --name placement-redis -p 6379:6379 redis:7
```

### 2. Prisma client

```bash
npx prisma generate
```

Required after a fresh clone, after any `schema.prisma` change, and after
`rm -rf node_modules`. Nothing type-checks or runs without it.

### 3. Migrations

```bash
npx prisma migrate status            # confirm the target and what is pending
npx prisma migrate deploy            # apply
```

There are **18** migrations. Confirm the printed `Datasource "db": … at
"host:port"` line names the database you intend before applying. Full procedure:
[migrations.md](migrations.md).

### 4. API

```bash
npm run dev
```

### 5. Workers — one terminal each

```bash
npm run worker:email
npm run worker:attachment
```

### 6. Frontend

```bash
cd ../client && npm run dev
```

### 7. Sign in

```
http://localhost:3000/gmail/auth
```

Required before any protected route responds. See
[authentication.md](authentication.md).

---

# Expected startup logs

## API (`npm run dev`)

```
[session] SESSION_SECRET is unset — using an insecure development default
Server running on port 3000
[gmail-scheduler] Starting, interval 120000ms
[gmail-scheduler] Run started, N account(s) to sync
✅ Redis connected
```

Notes:

- The `SESSION_SECRET` warning is expected locally and absent once the variable
  is set.
- **The scheduler fires immediately on startup**, not after the first interval.
  With no mailbox connected it reports `0 account(s)` and does nothing.
- `✅ Redis connected` comes from the **BullMQ** client (`redis.ts`), which
  connects eagerly. The session client connects lazily and logs
  `✅ Redis (session) connected` only at first sign-in.
- No log line confirms the database. Use `/health`.

## Workers

Both are quiet until a job arrives. Startup emits nothing beyond
`✅ Redis connected`. Silence is correct; it is not evidence the worker is
consuming the right queue.

On a job:

```
{ jobId: '1', queue: 'email-processing', emailSubject: '…', userId: 1, attempts: 0 }
Job 1 completed
```

## Frontend

```
VITE v8.x  ready in NNN ms
➜  Local:   http://localhost:5173/
```

---

# Verification

Run in order. Each assumes the previous passed.

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | API up | `curl http://localhost:3000/` | `Backend Running` |
| 2 | Database | `curl http://localhost:3000/health` | `{"status":"ok","database":"connected"}` |
| 3 | Redis | `npm run test:redis` | prints the round-tripped value and exits 0 |
| 4 | Migrations | `npx prisma migrate status` | `Database schema is up to date!` |
| 5 | Schema shape | `npx prisma studio` | `User` table exists; `Event` has `userId` |
| 6 | Auth enforced | `curl -i http://localhost:3000/event` | `401` |
| 7 | Sign-in | browse `http://localhost:3000/gmail/auth` | `{"success":true,"email":…}` |
| 8 | Session stored | `redis-cli KEYS 'sess:*'` | at least one key |
| 9 | Authenticated read | `curl http://localhost:3000/event -b "placement.sid=<cookie>"` | `200`, JSON array |
| 10 | Queues wired | `redis-cli KEYS 'bull:*'` | keys for `email-processing` |
| 11 | Tests | `npm test` | **7 suites, 120 tests, 0 failures** |
| 12 | Types | `npx tsc --noEmit` | no output |
| 13 | Ownership integrity | `npm run migration:verify -- --direct` | `Migration Status: PASS` |

Checks 3, 8, and 10 are the ones that distinguish "Redis is running" from
"Redis is being used correctly by both clients".

---

# Common Failures

### Everything starts; the dashboard is empty and the console shows `401`

**Cause.** `client/src/api/eventApi.ts` calls `fetch` **without
`credentials: "include"`**, so the session cookie is never sent. Known gap; the
client has not been updated for Phase 3.
**Diagnosis.** The same request via `curl -b "placement.sid=…"` returns `200`.
**Resolution.** Add `credentials: "include"` to the client's fetch calls. Not
fixable from the backend.

---

### `ECONNREFUSED 127.0.0.1:6379`

**Cause.** Redis is not running, or `REDIS_URL` is unset and ioredis fell back to
its default host. The compose file does not provide Redis.
**Resolution.** Start Redis. Note this surfaces at boot for the BullMQ client and
at first sign-in for the session client.

---

### Jobs enqueue but never process

**Cause.** Workers are not running. The API does not warn.
**Diagnosis.** `redis-cli LLEN bull:email-processing:wait` grows and never drains.
**Resolution.** Start both workers.

---

### `P1001: Can't reach database server`

**Cause.** With Neon, most often auto-suspend. Otherwise the container is not
running or `DATABASE_URL` is wrong.
**Resolution.** Retry once — the first connection wakes the instance. If it
persists, check `docker compose ps` or the Neon dashboard.

---

### `Cannot find module '../../generated/prisma/client.js'`

**Cause.** The Prisma client has not been generated; `generated/prisma` is
gitignored.
**Resolution.** `npx prisma generate`.

---

### The scheduler syncs a mailbox you did not expect

**Cause.** The background scheduler is deliberately **global** — it iterates
every `GmailAccount` regardless of owner, because background work has no caller
to derive a tenant from. Only the manual `POST /gmail/sync` is ownership-scoped.
This is intended; see RFC-001 §14.2.
**Resolution.** None needed. To stop polling entirely, disconnect the mailbox or
raise `GMAIL_SYNC_INTERVAL_MS`.

---

### `npm test` fails to start on Windows with "Module ts-jest … was not found"

**Cause.** Jest 30's native `unrs-resolver` cannot load without the Visual C++
runtime. The message is misleading — ts-jest is installed.
**Diagnosis.** `node -e "require('unrs-resolver')"` throws.
**Resolution.** Install the Visual C++ 2015–2022 Redistributable (x64). Full
analysis in `Development_Environment.md` → *Testing*.

---

# Recovery

## Reset to a known-good local state

```bash
cd backend
docker compose down -v               # destroys the Postgres volume
docker compose up -d
docker rm -f placement-redis && docker run -d --name placement-redis -p 6379:6379 redis:7
npx prisma generate
npx prisma migrate deploy
npm test
```

Then sign in again — the session store was destroyed with Redis.

**This destroys all local data.** Do not run it against Neon or any shared
database.

## Clear sessions without touching queues

```bash
redis-cli --scan --pattern 'sess:*' | xargs redis-cli DEL
```

## Clear queues without touching sessions

```bash
redis-cli --scan --pattern 'bull:*' | xargs redis-cli DEL
```

Drops queued and in-flight jobs. Emails already persisted are unaffected and can
be reprocessed by re-running a sync.

## Stale Prisma client after a schema change

```bash
npx prisma generate && npx tsc --noEmit
```

Type errors mentioning fields that exist in `schema.prisma` mean the client is
stale.

---

# Related Documents

- [Development_Environment.md](../03_Development/Development_Environment.md) —
  **the canonical setup contract**; read first
- [authentication.md](authentication.md) — signing in
- [migrations.md](migrations.md) — applying and verifying migrations
- [troubleshooting.md](troubleshooting.md) — symptom-first index
- [Gmail_Synchronization.md](../02_Backend/Gmail_Synchronization.md) — ingestion
  architecture

---

# Confidence

**High for topology, commands, and environment variables.** Read from
`package.json`, `server.ts`, `app.ts`, `session.config.ts`, `redis.ts`,
`session-redis.ts`, `gmail.scheduler.ts`, `docker-compose.yml`, and
`.env.example`. Non-secret values (`PORT`, `GOOGLE_REDIRECT_URI`,
`FRONTEND_URL`, `NODE_ENV`) were read from `backend/.env`; no secret values were
read or reproduced.

**Verified by execution:** `npm test` (7 suites / 120 tests / 0 failures),
`npx tsc --noEmit` (clean), `npm run migration:verify -- --direct` (connects and
reports), and the Neon `P1001`-then-success cold-start behaviour.

**Not executed:** the startup log excerpts are assembled from the `console.log`
calls in `server.ts`, `gmail.scheduler.ts`, `redis.ts`, and `session.config.ts`
rather than captured from a run. Line content is accurate; ordering may vary
because Redis connects asynchronously. Checks 7–10 in *Verification* were not
run end to end — no browser sign-in was performed.

**Superseded.** `Development_Environment.md` states 14 migrations and 73 tests
and documents `GET /gmail/sync` as unauthenticated. All three are stale as of
Phase 3; the counts and endpoints in this runbook are current.
