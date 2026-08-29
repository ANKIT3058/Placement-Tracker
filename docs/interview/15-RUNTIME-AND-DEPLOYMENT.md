# 15 — Runtime and Deployment: what is actually running

> **This chapter is the single source of truth for "what is deployed today".**
> Every other chapter defers to it. If another document disagrees with this one,
> this one is right — it was written by reading `.github/workflows/`,
> `deploy/systemd/`, `client/vercel.json`, `backend/src/server.ts` and both
> worker entrypoints.

The most important sentence in this chapter:

> **The application server runs continuously. The background workers do not.
> Jobs are produced all day and consumed only when I dispatch a GitHub Actions
> workflow by hand.**

That is not a bug and it is not an accident. It is a deployment decision with a
specific cause, and the architecture was built so that the decision is
reversible without a code change. The rest of this chapter is that argument,
stated the way you should state it out loud.

---

## Contents

1. [The one-picture answer](#1-the-one-picture-answer)
2. [What runs continuously](#2-what-runs-continuously)
3. [What is manually triggered](#3-what-is-manually-triggered)
4. [What is written but not deployed](#4-what-is-written-but-not-deployed)
5. [Why the worker is not continuously running](#5-why-the-worker-is-not-continuously-running)
6. [What the manual model actually costs](#6-what-the-manual-model-actually-costs)
7. [Why the architecture survives it](#7-why-the-architecture-survives-it)
8. [What production deployment would look like](#8-what-production-deployment-would-look-like)
9. [Failure cases specific to the current runtime](#9-failure-cases-specific-to-the-current-runtime)
10. [Interview questions on this chapter](#10-interview-questions-on-this-chapter)

---

# 1. The one-picture answer

```
  ALWAYS ON                              MANUALLY TRIGGERED           WRITTEN, NOT DEPLOYED
  ───────────────────────────────        ────────────────────────     ─────────────────────────
  VERCEL — static SPA                    GITHUB ACTIONS               deploy/systemd/
    React 19 + Vite build                  workflow_dispatch only       *-email-worker.service
    /api/:path* → rewrite to Render        required reviewer            *-attachment-worker.service
                                                                        worker.env.example
  RENDER — web service                   production-worker.yml
    node dist/src/server.js                → email.worker.js           Units exist in the repo.
    ├─ Express 5 (HTTP API)                → WORKER_EXIT_WHEN_DRAINED  They are installed on
    ├─ Gmail scheduler       120 s         → USE_AI=true               NO host today.
    ├─ Email reconciler       60 s
    └─ Attachment reconciler  60 s       production-attachment-worker.yml
                                           → attachment.worker.js
    Produces queue jobs.                   → WORKER_EXIT_WHEN_DRAINED
    Consumes NONE.                         → no USE_AI  (so Document
                                              Intelligence writes nothing)
  NEON — PostgreSQL
    pooled URL  → runtime (Prisma adapter)
    direct URL  → migrations, applied by hand from a workstation

  REDIS
    bull:*  queues    (ioredis)          ← fills up between drains
    sess:*  sessions  (node-redis)
```

**Say it in one breath:** *"The API, the Gmail poller and both reconcilers run
continuously on Render. The two BullMQ workers have no permanent host — I drain
each queue by dispatching a GitHub Actions workflow manually. So the
asynchronous architecture is fully built and running; continuous worker hosting
is the piece that isn't deployed."*

---

# 2. What runs continuously

## 2.1 Vercel — the frontend and the only origin the browser sees

`client/vercel.json` rewrites `/api/:path*` to the Render service and strips
`/api`. That rewrite is not a convenience — it is what makes the session cookie
work at all. `vercel.app` and `onrender.com` are both Public Suffix List
entries, so they are different **sites**, not merely different origins, and a
`SameSite=Lax` cookie is withheld across them. The rewrite collapses the two
into one origin so the cookie minted by the OAuth callback is the cookie sent
with `/api/event`. Full story: [ch. 11](11-SECURITY-DEPLOYMENT-AND-OPERATIONS.md)
and `docs/postmortems/vercel-render-oauth-deployment.md`.

## 2.2 Render — the API process

One process, started as `node dist/src/server.js`. Read `src/server.ts` top to
bottom and it does exactly four things:

| Step | What | Why it is there |
|---|---|---|
| `await connectSessionRedis()` | Connect the session store **before** `listen` | node-redis throws rather than queueing when closed. A process that accepted requests first would answer every sign-in with an opaque 500 |
| `app.listen(PORT)` | Express 5 | The HTTP API |
| `startGmailScheduler()` | `setInterval`, `GMAIL_SYNC_INTERVAL_MS` = 120 s | Syncs every eligible mailbox sequentially, persists Emails, **enqueues** jobs |
| `startEmailReconciliationScheduler()` | `setInterval`, 60 s | Re-enqueues Emails persisted but never queued |
| `startAttachmentReconciliationScheduler()` | `setInterval`, 60 s | Re-enqueues attachment work that Postgres still owes and Redis no longer represents |

**All five are producers or servers. Not one of them consumes a queue.** That is
the fact the whole chapter turns on.

Each scheduler has **its own timer and its own re-entrancy guard**, and that
separation is deliberate rather than incidental. `runSyncCycle` clears its guard
in a `finally`, and a `finally` never runs if an `await` never settles — so one
stalled Gmail socket would leave a shared flag set forever and silently disable
recovery too. Recovery must not depend on the component whose failure creates
the work it recovers.

## 2.3 Neon PostgreSQL

Two connection strings for one database, because the runtime and the migration
engine want opposite things:

- `DATABASE_URL` — **pooled**, read by `src/lib/prisma.ts`, which builds a
  `pg.Pool` and hands it to `PrismaPg`. Many short-lived queries across
  concurrent handlers.
- `DIRECT_DATABASE_URL` — **unpooled**, read by `prisma.config.ts` for
  `prisma migrate`. Migrations take a *session-level* advisory lock, and a
  transaction pooler cannot hold one — it takes the lock on one backend and
  releases it to another.

Under Prisma 7 neither URL appears in `schema.prisma`; the schema file cannot
carry `url` or `directUrl` any more, so the split is expressed by *which side
reads which variable*.

**Migrations are applied by hand from a workstation.** No workflow and no
service runs `prisma migrate deploy`. The drain workflows pass a deliberately
dead `DIRECT_DATABASE_URL` (`postgresql://unused:unused@localhost:5432/unused`)
purely because Prisma's `env()` helper is eager and throws at config-evaluation
time for every CLI command including offline codegen — so the real unpooled
endpoint never enters GitHub at all.

## 2.4 Redis — two clients, two libraries, one habit worth defending

| Client | Library | Serves | Why not the other one |
|---|---|---|---|
| `infrastructure/redis/redis.ts` | **ioredis** | BullMQ (`bull:*`) | BullMQ requires ioredis and requires `maxRetriesPerRequest: null` |
| `infrastructure/redis/session-redis.ts` | **node-redis** | `connect-redis` v10 (`sess:*`) | connect-redis v10 issues node-redis command signatures; with ioredis the SET reached Redis as `SET <key> <value> [object Object]` and the store **never wrote a session** |

They also want different eviction policies. The queue instance must run
`maxmemory-policy noeviction` — an evicted job key is a silently lost job — while
a session store is commonly deployed with LRU. `SESSION_REDIS_URL` falls back to
`REDIS_URL` so one instance works locally; the namespaces (`sess:` vs `bull:`)
keep them from colliding at the key level.

---

# 3. What is manually triggered

Two workflows, both `workflow_dispatch`-only. **No `schedule`, no `push`, no
`pull_request`.** They hold production database and Redis credentials, so they
run when a human decides they run and never as a side effect of a commit.

## 3.1 `.github/workflows/production-worker.yml` — the email drain

```
  workflow_dispatch (manual)
        ↓
  environment: production-worker      ← required reviewer; the job PAUSES here
        ↓                               before a single step runs, and the
        ↓                               production secrets are scoped to it
  checkout (pinned to a commit SHA, not a tag)
        ↓
  setup-node 24  →  npm ci  →  npm run build
        ↓                       (prisma generate && tsc && fix-esm-imports)
  verify DATABASE_URL, REDIS_URL, OPENAI_API_KEY are present   ← fail fast
        ↓
  node dist/src/workers/email.worker.js
        WORKER_EXIT_WHEN_DRAINED=true
        USE_AI=true
        ↓
  process at concurrency 1 → queue genuinely empty → graceful close → exit 0
```

| Property | Value |
|---|---|
| Trigger | `workflow_dispatch` only — manual |
| Approval | `environment: production-worker` carries a required reviewer |
| Concurrency | `group: production-email-worker`, `cancel-in-progress: false` — a second dispatch **queues** rather than cancelling a drain mid-job |
| Permissions | `contents: read` — the job opens no PR, pushes no commit, publishes nothing |
| Actions | Pinned to commit SHAs, not tags — a tag is repointable by whoever controls it, and this job holds production credentials |
| Timeout | 30 minutes — a ceiling for the cases where the worker *cannot* exit (wedged Redis, paused queue), not the expected duration |
| Queue | `email-processing` only |
| AI | `USE_AI=true` with `OPENAI_API_KEY` — this drain runs the AI-assisted extraction path |

## 3.2 `.github/workflows/production-attachment-worker.yml` — the attachment drain

A **separate workflow file**, not a second job or a queue input, and separate on
purpose: the two queues are independent, they are dispatched for different
reasons, and either must be runnable without touching the other's definition. It
has its own concurrency group for the same reason.

Three things differ from the email drain, and each is worth being able to
explain:

1. **It carries `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.** This worker
   downloads bytes from Gmail, so google-auth-library must exchange the stored
   refresh token for an access token, and that POST carries the client
   credentials. The email worker never calls Gmail — it processes bodies the API
   already persisted — so it deliberately does not get them.
2. **It ships no `USE_AI` and no `OPENAI_API_KEY`.** `USE_AI` is the entire gate
   on Document Intelligence, so in production the attachment pipeline downloads,
   stores and parses — and writes **no `DocumentIntelligence` row at all**.
3. **It ships no `ATTACHMENT_STORAGE_DIR`,** so downloaded bytes land under
   `backend/storage/attachments` on the runner and vanish with it. That is
   already how this pipeline behaves elsewhere: the stored file is read only by
   the parser, inside the same job, and nothing in the codebase ever reads
   `storagePath` back. The durable artifact is the parsed text in PostgreSQL.

### The credential check that exists because of a real incident

Both workflows have a `Verify credentials are present` step, and it was added
after a production run that **reported success while doing nothing**. The
attachment drain shipped no Gmail credentials, every job failed at the OAuth
token refresh with `400 invalid_request`, the queue drained, and the workflow
exited 0 — green. `test -n` reads each variable without printing it and fails
the run before the first job rather than once per job and invisibly.

That check has since been **moved into the program itself**
(`src/shared/config/worker-env.ts`, `assertWorkerEnv`), because a systemd
`ExecStart=` has no shell wrapper to run it. It is now the first statement each
worker module executes.

## 3.3 `WORKER_EXIT_WHEN_DRAINED` — the only difference between the two runtimes

This is the detail that makes the manual model an architectural choice rather
than a hack.

**The same compiled entrypoint** is a permanent worker without the flag and a
batch job with it. Nothing else differs — no second code path, no separate
build, no "batch mode" module.

```ts
const exitWhenDrained = process.env.WORKER_EXIT_WHEN_DRAINED === "true";
```

Read **once**, at module load, because the mode is a property of the run;
re-reading it would let a mutated environment change the process's lifecycle
halfway through. Compared against the literal string, so a missing, empty or
mistyped value leaves the process the permanent worker it has always been.

**And the drain condition is not the `drained` event.** BullMQ emits `drained`
when a fetch found nothing *immediately available* — it is a statement about the
wait list, not about the queue. A job that fails with attempts remaining is moved
to the **delayed** set, and if nothing else is waiting the very next thing the
worker does is emit `drained`. Exiting on the event alone would abandon a pending
retry.

So the event is the **trigger** and `getJobCounts` is the **decision**:

```ts
const counts = await queue.getJobCounts(
  "waiting", "active", "delayed", "paused", "prioritized", "waiting-children",
);
if (sum(counts) > 0) return;      // a retry is waiting out its backoff
await shutdown("Queue drained");  // the graceful path, not process.exit
```

The six types are named explicitly. A bare `getJobCounts()` includes `completed`
and `failed`, and with `removeOnFail: false` the failed set is permanent —
counting it would mean the queue is never drained and the process never exits.
`active` is counted even at concurrency 1 because a *previous* run killed without
draining leaves its job in `active` with an expired lock, and a check that ignored
it would exit and orphan that job until the next dispatch.

**The window that is deliberately not closed:** a job can arrive between the
counts coming back zero and the close completing. It cannot be closed — the API
is a live producer and no lock closes it without making this a permanent worker
again. It costs nothing: the job is durable in Redis and its id is
deterministic, so the next run simply picks it up.

---

# 4. What is written but not deployed

`deploy/systemd/` contains two unit files and an environment template, and
`docs/oracle-worker-deployment.md` is a full installation procedure for running
both workers continuously on an Oracle Cloud VM.

> **None of it is installed on any host today.** It is a prepared deployment, not
> the current runtime. When you talk about it in an interview, say *"the units are
> written and committed; I have not stood the VM up"* — the honest claim is that
> you designed the deployment, not that you are running it.

What the units get right is still worth walking through, because it shows you
know what a permanent worker needs beyond `node worker.js`:

| Directive | Why |
|---|---|
| `After=network-online.target` + `Wants=` | `network.target` is reached before an address is usable, and the worker's first action is to dial Redis and Postgres. `Wants=` is required — `After=` alone orders against a unit that may never run |
| `StartLimitIntervalSec=300` / `StartLimitBurst=5` **in `[Unit]`** | Five starts per five minutes, then systemd parks the unit in `failed` instead of spinning. These moved from `[Service]` in systemd v229 and are **silently ignored** in the wrong section — the usual reason a "rate limited" unit still loops |
| `Environment=WORKER_EXIT_WHEN_DRAINED=` after `EnvironmentFile=` | Pinned empty so it wins. A stray `true` would make the process exit the moment the queue emptied and let `Restart=` restart it seconds later, forever |
| `Restart=on-failure`, not `always` | A deliberate `systemctl stop` and the graceful signal path both end in exit 0, and neither should be undone by a restart |
| `KillSignal=SIGTERM` + `TimeoutStopSec` (90 s email / 300 s attachment) | systemd's half of the graceful-stop contract. When the timeout expires it sends SIGKILL, which abandons the job mid-flight while it still holds its Redis lock — the exact failure the handler exists to prevent |
| `User=placement`, `ProtectSystem=strict`, `NoNewPrivileges`, `ProtectHome`, … | The worker needs no privileged port and no other user's files |
| `StateDirectory=placement-tracker` (attachment only) | `ProtectSystem=strict` makes `/opt` read-only, so downloads would fail with `EROFS` on every attachment. This creates `/var/lib/placement-tracker` with the right ownership and points `ATTACHMENT_STORAGE_DIR` inside it |

The 300 s vs 90 s stop timeout is the interesting asymmetry: an email job is
regex plus at most one OpenAI call; an attachment job is a Gmail download plus a
full PDF or spreadsheet parse, and parsing is the long pole.

---

# 5. Why the worker is not continuously running

State this as a cost decision, not an apology.

**The direct reason:** Render — where the API is deployed — has no free tier for
Background Workers. A continuously running worker is a paid service on the
platform the rest of the system already lives on.

**Why that was acceptable instead of blocking:** because the work is *durable and
deferrable*. Nothing in this product needs an email turned into an Event within
seconds. The email is already committed to Postgres at ingestion time; the job in
Redis is only the instruction to interpret it. Delay costs freshness, and
freshness is the one property this domain can trade — a placement round announced
this morning is still useful when it is read this evening.

**Why it did not become a design compromise:** the alternative would have been to
do the work synchronously in the request or in a `setInterval` inside the API
process. Both would have deleted the queue from the architecture to work around a
hosting bill, and both are strictly worse:

- In-request extraction holds an HTTP connection for the duration of an LLM call.
- An in-process loop gives up per-job retries, backoff, the durable failed set,
  and the ability to scale consumers independently of the API.

So the queue stayed, the worker stayed a worker, and only its *runtime* was
downgraded — which is the reversible part.

---

# 6. What the manual model actually costs

Do not soften this. An interviewer will find it in thirty seconds, and owning it
is worth more than the version where they discover it.

| Consequence | Reality |
|---|---|
| **Processing latency is unbounded** | An email becomes an Event when I dispatch a drain. Between drains that is hours or days |
| **The dashboard is stale between drains** | A user who connects a mailbox sees their events after the next drain, not after the next sync |
| **`bull:email-processing:wait` grows monotonically** | A healthy `/health`, a growing wait list and no new Events is the **expected steady state between drains**, not a malfunction |
| **`attachment-processing` accumulates further** | Attachment jobs are only produced after their email job succeeds, so the attachment backlog lags the email backlog by one drain |
| **Document Intelligence produces nothing in production** | The attachment drain ships no `USE_AI`, so the classifier and extractors are never called there. They run in development and in tests only |
| **The failed set is never triaged automatically** | `removeOnFail: false` keeps failed jobs forever, which is deliberate — but nothing looks at them except me |
| **Redis is a single point of durable state between drains** | The queue holds work for far longer than a continuously drained queue would, so a Redis loss costs more here than it would with a permanent worker. The email reconciler recovers `pending` rows; jobs whose row already left `pending` are recovered by the attachment reconciler only for attachments |
| **The drain has a 30-minute ceiling** | A backlog large enough to exceed it is simply resumed on the next dispatch — jobs are durable and ids are deterministic — but nothing tells me it happened except reading the run |

**The one thing that is NOT a consequence:** lost work. Emails are committed to
Postgres before any job exists, job ids are deterministic, and both reconcilers
re-enqueue what Postgres still owes. The backlog is a latency problem, not a
durability problem — and that distinction is the answer to most follow-ups here.

---

# 7. Why the architecture survives it

This is the part that turns "my worker isn't hosted" into an engineering answer.

**1. The producer and the consumer were never coupled.** The API enqueues; the
worker consumes. Neither imports the other. Removing the consumer's host changes
*when* work happens, not *what* happens or in what order.

**2. Every unit of work is durable before it is queued.** `createEmail` commits
the row, then `enqueueEmailProcessing` adds the job. The email exists whether or
not the job does — which is exactly why a missing consumer is survivable and a
missing database would not be.

**3. Job ids are deterministic, so re-enqueueing is free.**
`jobId: email-${emailId}` and `jobId: attachment-${attachmentId}`. BullMQ refuses
a second `add` while a job with that id exists, so a racing duplicate collapses
into the job already queued. This is what lets the reconcilers be *deliberately
blind to Redis* — no `getJob`, no check-then-enqueue, because that lookup would
race the exact window it was meant to close.

**4. The reconcilers exist precisely because Postgres and Redis cannot share a
transaction.** They are the dual-write mitigation, and they run in the *always-on*
process — so recovery keeps working even though consumption does not:

| Sweep | Interval | Selects | Bound |
|---|---|---|---|
| `reconcilePendingEmails` | 60 s | `processingStatus = pending` AND `createdAt < now − 5 min` | unbounded (an orphan requires a failed enqueue, so it normally finds nothing) |
| `reconcileOrphanedAttachments` | 60 s | `pending`/`processing`, **or** `completed` with both parse columns NULL, AND `createdAt < now − 15 min` | 100 rows per sweep |

The attachment sweep is batch-bounded *because* of the manual runtime: with a
standing backlog of legitimately queued work, an unbounded sweep would attempt
one Redis round trip per backlogged row every 60 seconds. Rows beyond the bound
stay eligible for the next sweep, because the reconciler never marks anything
done.

**5. The worker already behaves like a production worker.** It fails fast on a
missing variable, handles worker-level errors without dying, and shuts down
gracefully on SIGTERM/SIGINT — waiting for the active job rather than abandoning
it. None of that is required by a GitHub Actions runner. It is there because the
runtime is meant to change.

**Say it like this:** *"The queue architecture is real and running — jobs are
produced continuously, they are durable, they are idempotent, they retry, and two
reconcilers repair the Postgres/Redis dual-write gap. What is missing is one
thing: a host that keeps the consumer process alive. That is a deployment gap,
not a design gap, and the code needs no change to close it — I unset one
environment variable."*

---

# 8. What production deployment would look like

Clearly labelled **FUTURE**. None of this is running.

## 8.1 The change itself is trivial — that is the point

Run the same compiled entrypoint on any host that keeps a process alive, with
`WORKER_EXIT_WHEN_DRAINED` unset. That is the entire code-level change: nothing.
The units in `deploy/systemd/` are one way to do it; a Render Background Worker
or a container in any scheduler is another.

## 8.2 What I would add, in the order I would add it

| # | Change | Why, specifically for this system |
|---|---|---|
| 1 | **A permanent host for both workers** | Removes the unbounded latency. Everything else on this list is worth less until this exists |
| 2 | **A health signal for the workers** | Neither worker listens on a port, so an HTTP health check does not apply. The right signal is *queue depth and oldest-job age*, exported from the API process — a worker that is `active (running)` but consuming nothing is the hardest failure to notice, and it is exactly what a missing `REDIS_URL` produces (ioredis dials 127.0.0.1 and retries forever) |
| 3 | **Alert on backlog age, not backlog size** | Size is normal after a Gmail sync burst. *Oldest waiting job older than N minutes* is the condition that actually means the consumer is gone |
| 4 | **Structured logging** | Everything is `console.log` today, unaggregated. The log lines are already redacted to safe scalars — see §9 — so the remaining work is shipping them somewhere queryable |
| 5 | **A dead-letter review path** | `removeOnFail: false` already retains every failed job permanently, and `getFailedEmails` exists and is tenant-scoped but is called by nothing. The missing piece is a surface that shows them |
| 6 | **Object storage for attachments** | Files land on ephemeral disk today. `StorageService` is an interface with one local implementation precisely so S3 is a swap, not a refactor |
| 7 | **Worker concurrency above 1** | Both workers run at BullMQ's default of 1. Raising it is safe for *distinct* jobs — every write is either constraint-protected or an upsert — but see the concurrency caveat in §9 before claiming it is safe for two jobs touching the same Event |
| 8 | **Encrypt `GmailAccount.refreshToken` at rest** | Plaintext today; database access currently equals mailbox access |
| 9 | **Rate limiting** | None on any route |
| 10 | **Automated migrations in a deploy step** | Applied by hand from a workstation today |

## 8.3 What I would deliberately NOT do

- **Not a scheduled drain.** A `schedule:` trigger on the workflow would look
  like a fix and would be worse than either real option: it keeps the unbounded
  latency (just quantised to the cron period), it runs against production
  credentials without a human, and it removes the pressure to do the actual
  deployment.
- **Not moving the schedulers to the worker host.** `startGmailScheduler` runs in
  the web process. Two hosts running it would sync every mailbox twice.
- **Not a second queue technology.** Nothing in the failure list is a BullMQ
  limitation.

---

# 9. Failure cases specific to the current runtime

The general failure table is in [ch. 03](03-SYSTEM-ARCHITECTURE.md). These are
the ones that exist *because of* the runtime.

| Failure | What happens today | Recovered by |
|---|---|---|
| **No worker is running** (the normal state) | Jobs accumulate in Redis. Emails sit at `processingStatus = pending`. The user sees no new events | The next manual drain. Nothing is lost |
| **The reconciler re-enqueues a job that already exists** | `enqueueEmailProcessing` is called for a row whose job is alive. BullMQ's `add` is a no-op for an existing `jobId` | By design — the deterministic id **is** the concurrency control |
| **The drain hits the 30-minute timeout** | The timeout arrives as a signal, so the graceful handler runs: the active job finishes, the process exits | The next dispatch resumes; jobs are durable |
| **A job is interrupted twice** | `maxStalledCount` defaults to 1, so the second stall fails it permanently with "job stalled more than allowable limit". `removeOnFail: false` then keeps the deterministic jobId occupied, so **nothing can re-enqueue that email** | Nothing automatic. This is a real gap — see below |
| **Redis is unavailable at enqueue time** | The row is committed, the `add` throws, the sync of that message is counted failed. No job exists | `reconcilePendingEmails` after 5 minutes |
| **Redis loses the queue** (restart without persistence, or eviction reaching job hashes) | Jobs vanish; every Postgres row survives | Both reconcilers. This is the case the attachment reconciler's third predicate branch was written for |
| **The drain runs with a missing credential** | `assertWorkerEnv` logs the missing **names** (never values) and exits 1 before constructing the Worker | The workflow's `Verify credentials` step catches it one layer earlier |
| **The drain runs with `USE_AI=true` and no `OPENAI_API_KEY`** | Would silently degrade every email to regex-only forever — a green run with quietly worse output. So the key is a **conditional requirement**: `resolveRequiredEnv` adds it when `USE_AI === "true"`, and the worker refuses to start | Fail-fast, by design |
| **A worker-level error** (lock not renewed, reconnect failed, internal `run()` rejecting) | Logged as safe scalars and **not** a shutdown trigger — ioredis reconnects and BullMQ's stalled checker recovers a lapsed lock. Exiting would turn a blip into a restart | Self-healing |
| **Two drains dispatched at once** | The second **queues**; `cancel-in-progress: false`. Cancelling mid-drain would interrupt a job already holding its lock, and waiting is free | Workflow concurrency group |

### The one I would raise before being asked

**A permanently failed job is unreachable.** `removeOnFail: false` is the right
default — it keeps evidence — but combined with a deterministic jobId it means a
job that exhausted its attempts *occupies its own id forever*, so no reconciler
can re-enqueue that email. `getFailedEmails` exists, is tenant-scoped, and is
called by nothing. `backend/scripts/recovery/retry-failed-attachments.ts` is the
one-off tool that closes this for attachments; there is no email equivalent.

### Concurrency, stated precisely

Both workers run at **concurrency 1**, which is BullMQ's default and not a
configured choice. Do not claim concurrent updates are safe:

- Two jobs adjudicating the **same** Event have no lock and no version column.
  `updateEventService` reads, compares confidence, then writes in a transaction —
  the transaction gives atomicity, not mutual exclusion. Two interleaved runs can
  both pass the confidence check and both write.
- Two jobs **creating** the same Event *are* safe: `@@unique([userId, eventKey])`
  is enforced by Postgres, and `createEvent` catches exactly that P2002 —
  checking `meta.target` names both `userId` and `eventKey`, so an unrelated
  conflict is not swallowed — re-reads, and returns the winner's row.
- Replays are safe: `createExtraction` is an **upsert** on
  `@@unique([emailId, userId])`, and `saveDocumentIntelligence` upserts on
  `@@unique([attachmentId, userId])`.

**The honest sentence: at-least-once delivery with convergent effects, not
exactly-once.** Exactly-once is not achievable across Postgres and Redis and is
not claimed anywhere in this repository.

### Logging, and why it is redacted

The drain runs in GitHub Actions, whose logs on a public repository are readable
by anyone with the URL and no login. So every handler logs **safe scalars only,
never the error object**: a gaxios error carries the full request config and
headers (including a mailbox's refresh token), and a pg error can carry the
failing statement and its parameters. `describeGmailError` is the allowlist the
Gmail-touching paths use. The email worker's `failed` handler also deliberately
omits the payload's `userId` — it is an unverified claim, and the derived owner
may not exist yet if the job failed before the row was read.

---

# 10. Interview questions on this chapter

**Q: What is actually deployed today?**
> The frontend on Vercel, the API on Render, Postgres on Neon and Redis. The API
> runs Express plus three timers — a Gmail poller every two minutes and two
> reconcilers every minute. All of those produce work. Neither BullMQ worker has
> a permanent host: I drain each queue by dispatching a GitHub Actions workflow
> manually, behind a required reviewer.

**Q: Why isn't the worker running continuously?**
> Cost. Render has no free tier for Background Workers, and this is a personal
> project. What I refused to do was let the hosting decide the architecture — the
> alternative was doing the work in-request or in a `setInterval` inside the API,
> and both would have deleted the queue to save a bill. So the queue stayed and
> only the runtime was downgraded.

**Q: So is the async architecture real, or is it decoration?**
> It is real and it is running — half of it. Production continuously enqueues
> durable jobs with deterministic ids, retries, backoff, a retained failed set and
> two reconcilers repairing the Postgres/Redis dual-write gap. The consumer is
> the part with no permanent host. The distinction I would want you to hear is
> that *implemented* is a property of the repository and *continuously executing*
> is a property of the deployment, and this is the one place they differ.

**Q: How would you deploy the worker in production?**
> Run the identical compiled entrypoint on a host that keeps a process alive,
> with `WORKER_EXIT_WHEN_DRAINED` unset. That is the whole change — the batch
> behaviour is one environment variable, not a code path. The systemd units for
> that are already written in `deploy/systemd/`; I have not stood the host up.

**Q: How would you monitor it?**
> Not with an HTTP health check — neither worker listens on a port. The signal
> that matters is *oldest waiting job age*, exported from the API process, because
> the failure mode I actually fear is a worker that is up and consuming nothing.
> A missing `REDIS_URL` produces exactly that: ioredis treats an undefined target
> as "use the defaults", dials 127.0.0.1:6379, and retries forever because
> `maxRetriesPerRequest: null` is set for the long-running case. The unit stays
> `active (running)`, systemd never restarts it because it never exits, and the
> queue is drained by nobody. That is why the worker now refuses to start when a
> required variable is missing.

**Q: What happens to the queue while nothing is consuming it?**
> It grows. That is the expected steady state, not a malfunction — a healthy
> `/health`, a growing `bull:email-processing:wait` list and no new events all at
> once is normal here. Nothing is lost, because the email is committed to
> Postgres before the job is created and the job id is derived from the row.

**Q: What breaks first if I dispatch a drain against a 10,000-job backlog?**
> The 30-minute workflow timeout, at concurrency 1. It arrives as a signal, so the
> graceful handler finishes the active job and exits, and the next dispatch
> resumes — jobs are durable and ids are deterministic. Before that, the real
> bottleneck is the OpenAI call in the email path, since `USE_AI=true` on that
> drain; regex extraction and the three candidate queries are microseconds by
> comparison. The fix is worker concurrency and more consumers, both of which the
> queue already supports.

**Q: Why GitHub Actions and not a cron job?**
> Deliberately not a schedule. A `schedule:` trigger would run against production
> database and Redis credentials with no human in the loop, and it would still
> leave latency unbounded — just quantised to the cron period. `workflow_dispatch`
> plus an environment with a required reviewer means the job pauses for approval
> before a single step executes. And it removes the temptation to call the problem
> solved when it isn't.

**Q: What would you fix first if this were a real product?**
> The permanent worker host, because every other operational improvement is worth
> less until the consumer is always on. Then a backlog-age alert, then encrypting
> the stored refresh tokens — database access currently equals mailbox access.

---

## See also

- [ch. 03 — System Architecture](03-SYSTEM-ARCHITECTURE.md) — components, the
  end-to-end flow, and the general failure table
- [ch. 06 — Async jobs, attachments and AI](06-ASYNC-JOBS-ATTACHMENTS-AND-AI.md)
  — queue mechanics, the attachment pipeline, Document Intelligence
- [ch. 08 — Reliability, idempotency and transactions](08-RELIABILITY-IDEMPOTENCY-AND-TRANSACTIONS.md)
- [ch. 11 — Security and Operations](11-SECURITY-DEPLOYMENT-AND-OPERATIONS.md)
- `docs/deployment.md` — the operational runbook
- `docs/oracle-worker-deployment.md` — the **prepared, not applied** VM procedure
