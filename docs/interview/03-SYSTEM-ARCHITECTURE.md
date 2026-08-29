# 03 — System Architecture

Everything here is ✅ **Current** unless tagged.

> **Runtime warning, once, up front.** This chapter describes what the system
> *does*. It does not describe what is *running*. The two BullMQ workers below
> have no permanent host — they are executed as manually dispatched GitHub
> Actions batch drains. Read [ch. 15](15-RUNTIME-AND-DEPLOYMENT.md) for the
> deployment truth before you claim anything about production.

---

## Contents

1. [The problem this shape solves](#1-the-problem-this-shape-solves)
2. [High-level architecture](#2-high-level-architecture)
3. [Processes, and who starts what](#3-processes-and-who-starts-what)
4. [Component responsibilities](#4-component-responsibilities)
5. [How components communicate](#5-how-components-communicate)
6. [End-to-end data flow, step by step](#6-end-to-end-data-flow-step-by-step)
7. [Synchronous vs asynchronous](#7-synchronous-vs-asynchronous)
8. [Failure points and what happens](#8-failure-points-and-what-happens)
9. [Why this architecture](#9-why-this-architecture)

---

# 1. The problem this shape solves

A placement round is not announced once. It is announced in one email, moved in
a second, given a venue in a third, and clarified in a fourth — and those emails
arrive out of order, contradict each other, and leave fields out.

That single fact is why this is not CRUD:

- **An email is not a row to insert.** It is *evidence about a round*, and two
  emails may be evidence about the same round.
- **So every write is an inference**, not a command. The system has to decide
  (a) is this email about a round I already know? and (b) is this new
  information trustworthy enough to overwrite what I already believe?
- **Both decisions can be wrong**, so the system is built to fail in the
  recoverable direction: a duplicate event (visible, fixable) rather than a
  corrupted one (invisible, unfixable).

Everything in the architecture below exists to make those two decisions
explicit, isolated, and reviewable.

---

# 2. High-level architecture

```
   BROWSER (React 19 + Vite)
        │  same-origin /api  (Vercel rewrite → Render)
        ▼
┌───────────────────────────────────────────────────────────────┐
│  API PROCESS   src/server.ts        ← runs continuously        │
│                                                               │
│   Express 5                                                   │
│    ├─ session middleware (express-session + connect-redis)    │
│    ├─ ensureCsrfCookie  (issuance only, global)               │
│    ├─ /auth      logout (POST, CSRF-checked)                  │
│    ├─ /gmail     auth · callback · sync (POST, authed)        │
│    ├─ /event     list · read · create · patch (authed)        │
│    ├─ /email     manual ingestion (POST, authed)              │
│    ├─ /user      profile · shortlists (authed)                │
│    └─ / · /health                                             │
│                                                               │
│   THREE TIMERS, each with its own re-entrancy guard:          │
│    ├─ Gmail scheduler          setInterval 120 s              │
│    ├─ Email reconciler         setInterval  60 s              │
│    └─ Attachment reconciler    setInterval  60 s              │
│                                                               │
│   Produces queue jobs. Consumes NONE.                         │
└───────┬───────────────────────────────────┬───────────────────┘
        │ enqueue                           │ enqueue
        ▼                                   ▼
┌──────────────────┐                ┌──────────────────────┐
│ email-processing │                │attachment-processing │   BullMQ / Redis (ioredis)
└────────┬─────────┘                └──────────┬───────────┘
         │                                     │
         │   ⚠ no permanent consumer — drained on demand (ch. 15)
         ▼                                     ▼
┌──────────────────────┐            ┌────────────────────────┐
│ EMAIL WORKER         │            │ ATTACHMENT WORKER      │
│ src/workers/         │            │ modules/attachment/    │
│   email.worker.ts    │            │   attachment.worker.ts │
│                      │            │                        │
│ clean → extract →    │  enqueues  │ download → store →     │
│ confidence → gate →  │───────────►│ parse → persist →      │
│ match → decide       │  on success│ understand (USE_AI)    │
└──────────┬───────────┘            └───────────┬────────────┘
           │                                    │
           ▼                                    ▼
   ┌───────────────────────────────────────────────────┐
   │ PostgreSQL (Neon)  ·  Prisma 7 + @prisma/adapter-pg│
   └───────────────────────────────────────────────────┘
                       │
   ┌───────────────────┴──────────┐
   │ Redis:  sess:*  (node-redis) │   two clients, two libraries — see ch. 15
   │         bull:*  (ioredis)    │
   └──────────────────────────────┘

   Gmail API (gmail.readonly)  ·  Google OAuth + OIDC
   OpenAI (gpt-4o-mini, temperature 0) — gated on USE_AI, off by default
```

---

# 3. Processes, and who starts what

| Process | Command | Does | Runs today? |
|---|---|---|---|
| **API** | `npm run dev` / `npm start` (`node dist/src/server.js`) | HTTP, Gmail sync, both reconcilers | ✅ continuously, on Render |
| **Email worker** | `npm run worker:email` (dev) · `node dist/src/workers/email.worker.js` (deployed) | Consumes `email-processing` | ⚠️ manual GitHub Actions drain only |
| **Attachment worker** | `npm run worker:attachment` (dev) · `node dist/src/modules/attachment/attachment.worker.js` (deployed) | Consumes `attachment-processing` | ⚠️ manual GitHub Actions drain only |

> The `npm run worker:*` scripts are `tsx watch` — development file-watchers that
> never exit. The deployed runtimes run the **compiled** entrypoint directly, for
> exactly that reason.

**Three timers in the API process, and their separation is deliberate:**

| Timer | Interval | Threshold | What it does |
|---|---|---|---|
| `startGmailScheduler` | 120 s | — | Syncs every eligible mailbox sequentially; persists Emails; enqueues |
| `startEmailReconciliationScheduler` | 60 s | age > 5 min | Re-enqueues Emails persisted but never queued |
| `startAttachmentReconciliationScheduler` | 60 s | age > 15 min, ≤ 100 rows | Re-enqueues attachment work Postgres still owes |

Each owns its own timer **and its own `isRunning` flag**. Sharing one would be a
real bug: `runSyncCycle` clears its guard in a `finally`, and a `finally` never
runs if an `await` never settles — so a single stalled Gmail socket would leave
the shared flag set for the life of the process and silently disable recovery
too. The failure that *creates* orphans (Redis unreachable during ingestion) is
exactly the degraded moment when the rest of the system is least healthy, so
recovery must not depend on it.

---

# 4. Component responsibilities

Each answers one question: **what does it do, and why is it its own thing?**

### Gmail module — `src/modules/gmail/`
- **Does:** the OAuth handshake (`state` + PKCE), ID-token verification, mailbox
  persistence, and pulling new messages — full sync or incremental via Gmail's
  history API.
- **Why separate:** it is the only place that talks to Google, so credentials
  are not scattered. Every mailbox call builds its **own** OAuth client
  (`gmailFor`) rather than sharing one — a shared client that had credentials set
  per call could serve a paginated walk a different mailbox's token halfway
  through.
- **Talks to:** Google APIs, `GmailAccount`, `email.repository`, the email
  producer.

### Email module — `src/modules/email/`
- **Does:** persists raw emails, cleans bodies, runs deterministic extraction
  patterns, and **conducts** the per-email pipeline (`email.service.processEmail`).
- **Why separate:** `processEmail` is the one place that knows the order of
  operations — extract → record → gate → match → decide. Reading it tells you the
  whole policy.

### Extraction module — `src/modules/extraction/`
- **Does:** merges the AI result with the pattern result field by field,
  validates AI dates against the source text, computes a 0–1 confidence, and
  upserts one `EmailExtraction` row.
- **Why separate:** it separates *reading* from *deciding*. **Nothing here writes
  an Event.**

### Matching module — `src/modules/matching/`
- **Does:** given an extraction, returns the Event it describes — or `null`.
- **Why separate:** recognition is the hardest judgement in the system, so it
  lives alone and returns a **verdict**, never a write.
- **Talks to:** `event.repository` for candidate queries only. It mutates nothing.

### Event module — `src/modules/event/`
- **Does:** creates events, applies guarded updates, writes audit rows, serves
  dashboard reads, applies human corrections.
- **Why separate:** **the only write point for Events in the whole system.**
  Everything upstream proposes; this commits. That is what makes "can this path
  corrupt data?" answerable by reading one file.

### Attachment module — `src/modules/attachment/`
- **Does:** queue, worker, `DocumentProcessingService` (download → store → parse
  → persist → understand), a `StorageService` interface, a MIME-routed parser
  registry (PDF, spreadsheet), and the reconciler.
- **Why separate:** attachment work has different failure modes, different
  latency and different credentials from email work, so it gets its own queue and
  its own process.

### Document Intelligence — `src/modules/document-intelligence/`
- **Does:** turns a `ParsedAttachment` into `DocumentInsights` — what a document
  *means*, as opposed to what it contains. A classifier, an event extractor, a
  participant extractor and a pure assembler; the repository upserts one
  `DocumentIntelligence` row per attachment.
- **Where it runs:** invoked by attachment processing **after** the parsed
  content is durable, gated on `USE_AI`, fail-soft at that call site.
- 🚧 **Two different states, do not blur them:**
  `participantInformation` **is consumed** — `GET /user/shortlists` answers "am I
  on this shortlist?" from it. `eventInformation` is written and **read by
  nothing**: no document has ever created or updated an Event.
- ⚠️ **Produces nothing in production.** The attachment drain workflow ships no
  `USE_AI`, so the gate returns before any provider call. See
  [ch. 15 §3.2](15-RUNTIME-AND-DEPLOYMENT.md#32-githubworkflowsproduction-attachment-workeryml--the-attachment-drain).

### AI Core — `src/modules/ai/`
- **Does:** `structuredCompletion<T>()` — one entry point that sends prompts,
  strips markdown fences, parses JSON, applies a retry policy, and throws typed
  errors.
- **Why separate:** four AI features were each rebuilding the same plumbing. Both
  current call sites pass `new RetryPolicy({ maxAttempts: 1 })`, preserving the
  single-attempt behaviour they had before the Core existed.

### Auth module — `src/modules/auth/`
- **Does:** session config, `requireAuth`, CSRF issuance and validation, session
  lifecycle, and `TenantContext`.
- **Why separate:** authentication (*who is calling*) is deliberately not the
  same mechanism as authorization (*which rows they may touch*). The second
  happens at the persistence boundary.

### User module — `src/modules/user/`
- **Does:** identity resolution from a verified Google identity, the optional
  `StudentProfile` (registration number), and the shortlist-participation
  derivation.
- **Why separate:** `User` is the authentication identity and the ownership root.
  Campus attributes live in `StudentProfile` so the auth record never starts
  carrying institutional data.

### Frontend — `client/`
- **Does:** React 19 + Vite SPA. One dashboard: event list with temporal
  grouping, a review queue, an event drawer, manual paste, profile, shortlists.
- **Why it matters architecturally:** `client/src/api/http.ts` is the one place a
  non-2xx becomes an error, and the one place the CSRF header is attached. Before
  that existed, a 401 body came back looking like data and the dashboard told a
  signed-out user their account was empty.

---

# 5. How components communicate

| From → To | Mechanism | Notes |
|---|---|---|
| Browser → API | HTTPS, same origin via the Vercel rewrite | Session cookie (HttpOnly) + `X-CSRF-Token` header on writes |
| API → Postgres | Prisma 7 over a `pg.Pool` (pooled URL) | Every tenant-scoped query carries an explicit `userId` predicate |
| API → Redis (queues) | BullMQ `Queue.add` over ioredis | `bull:` namespace |
| API → Redis (sessions) | connect-redis over node-redis | `sess:` namespace, different library on purpose |
| API → Gmail | googleapis, one OAuth client per operation | 10 s per-attempt timeout |
| **API → Worker** | **Only through the queue.** Neither imports the other | Payload is an **id**, never data — see below |
| Worker → Postgres | Same Prisma client module | Owner re-derived from the row |
| Email worker → Attachment queue | `enqueueAttachmentJobs` after the email job succeeds | Fan-out, never before success |
| Worker → OpenAI | AI Core, gated on `USE_AI` | Any failure degrades, never fails the job |

**The queue payload is deliberately minimal.** `email-processing` carries
`{ emailId, userId }` and `attachment-processing` carries `{ attachmentId }`.
The `userId` on the email job is carried **for cross-checking only** — the worker
re-derives the owner from the persisted row and treats a disagreement as an
`UnrecoverableError`. A queue is not an authenticated channel: anything that can
reach Redis can enqueue a job, so a `userId` in a payload is a *claim*, and
claims are checked, not trusted.

---

# 6. End-to-end data flow, step by step

For each step: **input → processing → output → what can fail.**

```
Gmail mailbox
   ↓  poll every 120 s
Gmail sync            → Email row (Postgres)  +  Attachment metadata rows
   ↓  enqueue  jobId = email-<id>
email-processing queue (Redis)
   ↓  ⚠ consumed only when a drain is dispatched
Email worker          → derive owner from the row
   ↓
clean → extract (patterns + optional AI) → confidence
   ↓
EmailExtraction row (upsert — always written, even if the email is abandoned)
   ↓
VIABILITY GATE        no real company / no full date → status "ignored", stop
   ↓
MATCH                 exact → soft (±3 d, identity gate) → loose (±30 d, unique)
   ↓
DECIDE                low confidence → create a "review" Event
                      matched       → guarded update + audit row (one transaction)
                      no match      → create Event
   ↓
Event / EventUpdate (Postgres)
   ↓  enqueue  jobId = attachment-<id>   (only after the email job succeeded)
attachment-processing queue (Redis)
   ↓  ⚠ consumed only when a drain is dispatched
Attachment worker     → download → store → parse → persist → understand (USE_AI)
   ↓
Attachment.text / parsedData  ·  DocumentIntelligence row
   ↓
GET /event  ·  GET /user/shortlists  →  Dashboard
```

## Step 1 — Gmail sync (`gmail.sync.service.ts → syncGmailAccount`)

- **Input:** a `GmailAccount` row (`refreshToken`, `historyId`, `userId`).
- **Processing:** no `historyId` → **full sync**: capture the watermark *before*
  listing, then walk `users.messages.list` **paginated** on `nextPageToken`.
  Otherwise → `users.history.list` from the stored cursor, also paginated.
- **Output:** message ids, and a new `historyId` written only after the cycle.
- **Key decision — capture the watermark first.** Capture it after, and a message
  arriving mid-listing gets a history id *below* the new cursor and is never seen
  again. Overlap is safe; gaps are not. Re-fetching is free because dedupe catches
  it.
- **Key decision — pagination is not optional.** `maxResults` is a *per-page*
  limit. Reading one page and discarding the token drops an unbounded remainder,
  and then advancing `historyId` past everything never seen puts those messages
  permanently beyond any later incremental sync. A page that rejects
  **propagates**: a partial listing must not be mistaken for a complete mailbox.
- **Failure:** one account's sync throwing is caught per account; the others
  still run, and `historyId` is **not** advanced so the next cycle retries the
  same window. A `404` on the cursor (Gmail expired it) falls back to full sync
  automatically. A permanent `invalid_grant` sets `reauthRequiredAt`, so the
  background scheduler skips that mailbox until the user reconnects — while an
  explicit user-triggered sync may still try.

## Step 2 — Persist and dedupe (`syncSingleMessage`)

- **Input:** one Gmail message id.
- **Processing:** fetch the message; `parseMessage` walks the MIME tree for the
  body (prefers `text/plain`, falls back to stripped `text/html`) and collects
  attachment metadata. If `gmailMessageId` already exists → return `duplicate`.
- **Output:** an `Email` row **and all its `Attachment` rows in one nested Prisma
  create** — a single implicit transaction, so either the email and its
  attachment metadata all persist or none do.
- **Key decision — ownership flows from the mailbox.** `userId` comes from the
  `GmailAccount`, never guessed.
- **Failure:** one message failing is counted in `stats.failed`; the loop
  continues. Gmail errors are logged through `describeGmailError`, never raw — a
  gaxios error carries the mailbox's refresh token in its request config.

## Step 3 — Enqueue (`email.producer.ts`)

- **Input:** `{ emailId, userId }`.
- **Processing:** `emailQueue.add` with `jobId: email-${emailId}`, `attempts: 3`,
  exponential backoff from 2000 ms, `removeOnComplete: true`,
  `removeOnFail: false`.
- **Output:** one job, or a no-op if that id already exists.
- **Key decision — the id is derived, not random.** The email is committed before
  the job is created and the two stores cannot share a transaction, so a failed
  enqueue leaves a row only the reconciler can rescue — and the reconciler cannot
  see Redis. The deterministic id is what makes blind re-enqueueing safe: BullMQ
  refuses a second `add` while a job with that id exists. **No application-side
  "does a job exist?" check is wanted** — that lookup would race the very window
  it was meant to close.
- **Failure:** Redis down → `add` throws → the row stays `pending` with no job →
  `reconcilePendingEmails` picks it up after 5 minutes.

## Step 4 — The worker claims the job (`src/workers/email.worker.ts`)

- **Input:** the job payload.
- **Processing:** read the `Email` row by id; **derive the owner from the row**;
  compare the payload's claim against it.
- **Output:** an `OwnershipContext` threaded through everything below.
- **Key decision:** a mismatch throws `UnrecoverableError` — no retry, because a
  retry cannot fix a forged payload or a broken invariant. An *absent* claim is
  tolerated: jobs enqueued before the field existed carry none, and absent is not
  conflicting.

## Step 5 — Processor (`email.processor.ts`)

- Marks the email `processing` → runs the pipeline → marks it `completed`.
- On any throw: `markEmailFailed(reason)` **then rethrow**, so BullMQ retries.
- **Only after success** does it call `enqueueAttachmentJobs(emailId)`. A failed
  email never starts attachment processing.

## Step 6 — The pipeline (`email.service.ts → processEmail`)

```
cleanEmail(body).toLowerCase()   strips quoted reply chains, collapses whitespace
   ↓
extract(text)                    patterns + optional AI, merged field by field
   ↓
createExtraction(...)            UPSERT — always written, even if abandoned below
   ↓
VIABILITY GATE                   company must be real (not the "unknown" sentinel)
                                 AND date must match ^\d{4}-\d{2}-\d{2}$
                                 else → email status "ignored", return
   ↓
matchEventV2(owner, data)        exact → soft → loose
   ↓
DECIDE
   confidence < 0.6 → createEventService(status "review", reviewReason)
   match found      → updateEventService(...)   → email "completed"
   no match         → createEventService(...)   → email "completed"
```

- **Key decision — the extraction is recorded before the gate.** Even an
  abandoned email leaves a row explaining what was read and how confident it was.
  Evidence is kept whether or not it was acted on.
- **Key decision — the viability gate uses `isResolvedCompany`, not truthiness.**
  Extraction substitutes the literal string `"unknown"` when it finds nothing, and
  that string is *truthy*. It once satisfied the gate, created a real Event named
  "unknown", and that Event then became a matching candidate for every later
  unresolved observation. Abandoning here keeps the placeholder out of the
  identity key, out of the candidate queries, and out of the database.

Full detail of extraction, confidence and matching:
[ch. 05](05-EXTRACTION-MATCHING-DECISION-ENGINE.md).

## Step 7 — Fan out attachments

`enqueueAttachmentJobs(emailId)` → for every attachment **not already
`completed`**, add a job with `jobId: attachment-<id>`. Idempotent by
construction, so an email-job retry that re-runs this line never duplicates.

## Step 8 — Attachment worker (`document-processing.service.ts`)

- **Input:** `{ attachmentId }`.
- **Processing:** load the attachment with its email and Gmail account in one
  query → **`isSettled` check** → derive owner from the row → download with that
  mailbox's refresh token → store under a random UUID key → mark completed → ask
  the parser registry for a parser → parse → persist → run Document Intelligence.
- **Output:** `Attachment.text` / `parsedData` / `parsedMetadata`, and — only when
  `USE_AI=true` — one `DocumentIntelligence` row.
- **Key decision — the replay guard asks "is this pipeline finished", not "is the
  download finished".** Those were the same question until parsing was added.
  `completed` records only the download, so reading it as a whole-pipeline fact
  left a window in which a crash-and-replay would skip parsing **permanently** —
  and nothing could re-enqueue such a row, because the normal enqueue filter
  excludes `completed`. That window is exactly what the attachment reconciler's
  third predicate branch was written for.
- **Key decision — the storage key is a random UUID, not the filename.** No
  user-controlled data reaches the on-disk path; the original filename lives in
  the database.
- **Failure:** three separate domains. A **download** failure marks the attachment
  failed **and rethrows** (retryable). A **parse** failure records `parsingError`,
  leaves the download `completed`, and is **not** rethrown — parse errors are
  deterministic, so retrying only re-downloads. A **Document Intelligence**
  failure is caught and swallowed at that one call site, because the download and
  parse already succeeded and are already durable.

## Step 9 — Read path

`GET /event` returns the caller's events ordered `confidence: "asc"` (low
confidence first, so the review queue surfaces), each decorated with a **derived**
`temporalStatus`. It is attached on the way out rather than stored, so the
category is always a statement about *now* and never a stale column — and one
`now` classifies the whole list, so two events either side of a boundary cannot
be judged against different instants in one response.

`GET /user/shortlists` reads the caller's own `DocumentIntelligence` rows with
`classification = "shortlist"`, and answers whether their stored registration
number appears among the participants. It returns an attachment id and nothing
else about the document — **no attribute of any participant, including the
caller's own** — because a shortlist lists other students by name and roll number.

---

# 7. Synchronous vs asynchronous

**Synchronous (inside the HTTP request):**

| Route | Work done in-request |
|---|---|
| `GET /gmail/auth` | Generate `state` + PKCE verifier, save the session, redirect |
| `GET /gmail/callback` | Validate `state`/PKCE, exchange the code, verify the ID token, upsert the User, link the mailbox, establish the session |
| `POST /gmail/sync` | The actual Gmail pull — but it only *enqueues* per email |
| `POST /email` | Save the row, enqueue, return **202 Accepted** |
| `GET/PATCH /event` | Plain scoped database reads and writes |
| `GET/PATCH /user/profile`, `GET /user/shortlists` | Reads and one scoped write |

**Asynchronous (workers):** extraction, confidence, matching, the decision, every
Event write, attachment download, parsing, and document understanding.

**Why the queue exists — five reasons, in the order they matter here:**

1. **Durability.** The email is persisted before any processing. A crash loses a
   job, never an email — the row is still there with its `processingStatus`.
2. **Retries.** Transient failures get 3 attempts with exponential backoff for
   free, per job.
3. **Latency.** An LLM call takes seconds. Nothing should hold an HTTP connection
   for that.
4. **Burstiness.** One sync cycle can produce a page of messages per mailbox at
   once; the queue flattens that.
5. **Isolation.** One poisonous email fails its own job. The rest are unaffected.

**The 202 on `POST /email` is the contract this buys.** "Accepted, not yet
processed" is the honest status code for work that has been made durable but not
performed — and it is honest under the current runtime too.

---

# 8. Failure points and what happens

| Where | Failure | What happens |
|---|---|---|
| Gmail API | account sync throws | Caught per account. Others still sync. `historyId` **not** advanced, so the next run retries the same window |
| Gmail cursor | `historyId` expired (404) | Automatic fall back to full sync |
| Gmail auth | permanent `invalid_grant` | `reauthRequiredAt` set; the background scheduler skips that mailbox until reconnect. The token is left in place — Google already invalidated it, so deleting it protects nothing |
| Gmail request | no response | 10 s per-attempt timeout. Without it one stalled socket stops sync for **every** user, because the scheduler awaits accounts in sequence and clears `isRunning` in a `finally` that never runs |
| Sync of one message | throws | Counted in `stats.failed`; the loop continues |
| Email insert | duplicate `gmailMessageId` | Short-circuited *before* insert by an explicit lookup |
| Redis | down at enqueue | `enqueueEmailProcessing` throws → that message's sync fails → the row stays `pending` with no job → **`reconcilePendingEmails` recovers it after 5 minutes** |
| Redis | loses the queue entirely | Every Postgres row survives. Both reconcilers re-enqueue what is still owed |
| Extraction (AI) | OpenAI error / bad JSON | Caught in `extract()`, `aiData` stays null → **pattern-only path**. The email still processes |
| Extraction (AI) | invents an unsupported date | `validateAIDate` checks the candidate day+month against every date mention in the *cleaned* source and drops it → falls back to the pattern date |
| Extraction (AI) | returns an off-vocabulary round or a differently-worded company | `canonicalStage` rejects anything outside the four known rounds; `canonicalCompany` normalises. Both fall back to the deterministic value — because those two fields become the identity key, and only the deterministic extractor is stable across re-extractions |
| Viability gate | no real company or no full date | Email marked `ignored`. Nothing written to Event. **Not an error** |
| Matching | no candidate | Creates a new event. A duplicate is the accepted failure |
| Matching | candidate's round contradicts | Vetoed **before** scoring, so it can never meet the acceptance threshold |
| Decision | confidence < 0.6 | Nothing existing is touched; a `review` event is created |
| Update | new confidence < existing | Update skipped; the existing row is returned unchanged |
| Update | event is `confirmed` | Skipped entirely — a human decision outranks any inference |
| Update transaction | any step throws | Prisma rolls back. No half-written event, no orphan audit row |
| Event create | P2002 on `(userId, eventKey)` | The repository re-reads and returns the winner's row. Any *other* P2002 is rethrown — it is a different conflict and must not be swallowed by this recovery. The worker also catches P2002 at the top level, logs "Duplicate event detected", and returns successfully rather than retrying into the same violation |
| Email worker | any other throw | `markEmailFailed(reason)` then rethrow → 3 attempts → the job sits in the failed set (`removeOnFail: false`) |
| Email worker | ownership mismatch in the payload | `UnrecoverableError` — failed permanently, never retried |
| Worker process | missing required env var | `assertWorkerEnv` prints the missing **names** (never values) and exits 1 **before** the Worker is constructed |
| Worker process | SIGTERM / SIGINT | Graceful: stop accepting jobs, **wait for the active job**, close Redis, exit 0. Never `close(true)` |
| Worker process | worker-level error (lock lapse, reconnect) | Logged as safe scalars; **not** a shutdown trigger. ioredis reconnects, and BullMQ's stalled checker recovers a lapsed lock |
| Worker process | interrupted twice mid-job | `maxStalledCount` defaults to 1 → failed permanently. With `removeOnFail: false` the deterministic jobId stays occupied, so **nothing can re-enqueue it**. Known gap — see [ch. 15 §9](15-RUNTIME-AND-DEPLOYMENT.md#9-failure-cases-specific-to-the-current-runtime) |
| Attachment download | Gmail error | `markAttachmentFailed` **and rethrow** → retryable |
| Attachment | no `gmailMessageId` or no account | `markAttachmentFailed`, **return without throwing** — not retryable, so don't burn retries |
| Attachment parse | parser throws | `markParsingFailed` only. Download stays `completed`, **not** rethrown |
| Document Intelligence | provider or database failure | Caught and logged at the one call site. The job still succeeds, because download and parse are already durable |
| Session Redis | down at startup | `server.ts` awaits `connectSessionRedis()` before `listen`. Startup fails loudly rather than serving requests it cannot authenticate |
| Session Redis | down at runtime | `disableOfflineQueue: true` fails commands immediately — a fast failure, not a hung request. The reconnect strategy returns a delay forever rather than an Error, because an Error closes the client permanently |
| Database | down during `requireAuth` | Answered **500**, not 401. A database failure is not an authentication failure; telling a legitimate caller to log in again cannot help and discards a valid session over a transient outage |
| **No worker running** | the normal state today | Jobs accumulate. Emails stay `pending`. **Nothing is lost.** See [ch. 15](15-RUNTIME-AND-DEPLOYMENT.md) |

**The overall shape: most failures degrade to staleness, which is visible and
recoverable, rather than corruption, which is neither.**

---

# 9. Why this architecture

**Why a modular monolith and not services?**
The pipeline stages are tightly coupled by data and always run together for one
email. Splitting them into services would add network calls and distributed
failure for no gain at this scale. What it *does* need is **process** separation —
API vs workers — so a slow LLM call cannot block HTTP, and that is exactly what it
has.

**Why one write point for Events?**
Every stage before `event.service` returns a proposal. That means "can this path
corrupt data?" is answerable by reading one file, instead of auditing every
module that happens to hold a Prisma client.

**Why put the decision in a service, not the matcher?**
The matcher answers *"which event is this?"* The service answers *"what am I
allowed to do about it?"* Merging them was the original design and it is what
produced the false-merge bug: a scoring function ended up making an authorization
decision. See [ch. 09 story #1](09-PROBLEMS-AND-DESIGN-DECISIONS.md).

**Why is the owner re-derived instead of trusted from the job?**
Because a queue is not an authenticated channel. Anything that can reach Redis
can enqueue a job. Deriving from the persisted row means there is exactly one
answer to "who owns this work" per job, and the payload's claim is only ever used
to *detect* a disagreement.

**Why two queues instead of one?**
Different work, different failure modes, different credentials. Attachment jobs
need Gmail credentials and take orders of magnitude longer; email jobs do not
touch Gmail at all. Separate queues mean either can be drained, retried, scaled
or paused without the other — which is exactly what the two separate drain
workflows exercise.

## Trade-offs I accepted

| Trade-off | Why, and what it costs |
|---|---|
| **The schedulers are in-process with the API** | Simple, and correct for one instance. Two API instances means two schedulers, and it uses a global "all accounts" query rather than a tenant-scoped one. The correct fix is a repeatable BullMQ job. Documented in the code as deliberate |
| **Attachments are on the local filesystem** | Behind a `StorageService` interface, so S3 is a swap and not a refactor. On ephemeral disk the files do not survive a redeploy — acceptable **only** because nothing ever reads `storagePath` back; the durable artifact is the parsed text in Postgres |
| **Worker concurrency is 1** | BullMQ's default, not a tuned choice. Safe for replays and for concurrent *creates* (unique constraint + P2002 recovery), but two jobs updating the same Event have no lock and no version column |
| **`POST /email` (manual paste) still exists** | Authenticated now. It is the escape hatch that lets the whole pipeline be exercised without a mailbox — and it is why the email reconciler cannot rely on Gmail replay for recovery |
| **The workers have no permanent host** | The largest trade-off in the system, and the one an interviewer will find. [ch. 15](15-RUNTIME-AND-DEPLOYMENT.md) is the full argument |
