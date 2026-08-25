# 03 — System Architecture

Everything here is ✅ **Current** unless tagged.

---

## High-level architecture

```
   BROWSER (React 19 + Vite)
        │  same-origin /api  (Vercel rewrite → Render)
        ▼
┌───────────────────────────────────────────────────────────────┐
│  API PROCESS   src/server.ts                                  │
│                                                               │
│   Express 5                                                   │
│    ├─ session middleware (express-session + connect-redis)    │
│    ├─ /auth      logout                                       │
│    ├─ /gmail     auth · callback · sync (POST, authed)        │
│    ├─ /event     CRUD-ish, all authed, all tenant-scoped      │
│    ├─ /email     manual ingestion (POST, authed)              │
│    └─ / · /health                                             │
│                                                               │
│   Gmail scheduler  setInterval(120s), guarded, sequential     │
└───────┬───────────────────────────────────┬───────────────────┘
        │ enqueue                           │
        ▼                                   ▼
┌──────────────────┐                ┌──────────────────────┐
│ email-processing │                │attachment-processing │   BullMQ / Redis (ioredis)
└────────┬─────────┘                └──────────┬───────────┘
         │                                     │
         ▼                                     ▼
┌──────────────────────┐            ┌────────────────────────┐
│ EMAIL WORKER         │            │ ATTACHMENT WORKER      │
│ src/workers/         │            │ modules/attachment/    │
│   email.worker.ts    │            │   attachment.worker.ts │
│                      │            │                        │
│ clean → extract →    │  enqueues  │ download → parse →     │
│ confidence → gate →  │───────────►│ persist                │
│ match → decide       │  on success│                        │
└──────────┬───────────┘            └───────────┬────────────┘
           │                                    │
           ▼                                    ▼
   ┌───────────────────────────────────────────────────┐
   │ PostgreSQL (Neon)  ·  Prisma 7 + @prisma/adapter-pg│
   └───────────────────────────────────────────────────┘
                       │
   ┌───────────────────┴──────────┐
   │ Redis:  sess:*  (node-redis) │   two clients, two libraries — see below
   │         bull:*  (ioredis)    │
   └──────────────────────────────┘

   OpenAI (gpt-4o-mini, temperature 0) — optional, off by default (USE_AI)
   Gmail API (gmail.readonly)
```

**Three processes**, started separately:

| Process | Command | Does |
|---|---|---|
| API | `npm run dev` / `npm start` | HTTP + Gmail scheduler |
| Email worker | `npm run worker:email` | Consumes `email-processing` |
| Attachment worker | `npm run worker:attachment` | Consumes `attachment-processing`. **Development only** — no production runtime starts it, which is why Document Intelligence is implemented but not production-active |

---

## Component responsibilities

### Gmail module — `src/modules/gmail/`
- **What it does:** OAuth handshake, identity verification, mailbox persistence, and pulling
  new messages (full sync or incremental via Gmail's history API).
- **Why it exists:** it's the only place that talks to Google. One OAuth client, one set of
  API helpers, so credentials aren't scattered.
- **Talks to:** Google APIs, `GmailAccount` table, `email.repository` (to save), and the
  email queue producer.

### Email module — `src/modules/email/`
- **What it does:** persists raw emails, cleans bodies, runs deterministic extraction
  patterns, and orchestrates the whole per-email pipeline (`email.service.ts`).
- **Why it exists:** `email.service.processEmail` is the *conductor*. It's the one place
  that knows the order of operations: extract → record → gate → match → decide.
- **Talks to:** extraction, matching, event services, and the attachment producer.

### Extraction module — `src/modules/extraction/`
- **What it does:** merges the AI result with the regex result, validates AI dates against
  the source text, computes a confidence score, and persists an `EmailExtraction` row.
- **Why it exists:** it separates *reading* from *deciding*. Nothing here writes an Event.

### Matching module — `src/modules/matching/`
- **What it does:** given an extraction, finds the Event it describes — or says "none".
- **Why it exists:** recognition is the hardest judgement in the system, so it lives alone
  and returns a verdict rather than performing a write.
- **Talks to:** `event.repository` for candidate queries only. It never mutates anything.

### Event module — `src/modules/event/`
- **What it does:** creates events, applies guarded updates, writes audit rows, serves the
  dashboard reads, and applies human corrections.
- **Why it exists:** **the only write point for Events in the whole system.** Everything
  upstream proposes; this commits.

### Attachment module — `src/modules/attachment/`
- **What it does:** queue + worker + `DocumentProcessingService` (download → select parser
  → parse → persist) + a storage abstraction + a MIME-routed parser registry.

### AI Core — `src/modules/ai/`
- **What it does:** `structuredCompletion<T>()` — one entry point that sends prompts, strips
  markdown fences, parses JSON, retries transient failures, and throws typed errors.
- **Why it exists:** four AI features were each rebuilding the same plumbing.

### Auth module — `src/modules/auth/`
- **What it does:** session config, `requireAuth`, session lifecycle, and `TenantContext`.
- **Why it exists:** authentication (*who is calling*) is deliberately separate from
  authorization (*which rows they may touch*). The second happens at the persistence
  boundary, not here.

### Document Intelligence — `src/modules/document-intelligence/`
- **What it does:** turns a `ParsedAttachment` into a `DocumentInsights` — what a document
  *means*, as opposed to what it contains. `DocumentIntelligenceService` orchestrates a
  classifier, an event extractor, a participant extractor and an assembler; the repository
  upserts the result as one `DocumentIntelligence` row per attachment.
- **Where it runs:** invoked by attachment processing after the parsed content is durable,
  gated on `USE_AI`, and fail-soft at that call site.
- 🚧 **The gap that remains.** Its output is stored and **read by nothing** — no document has
  ever created or updated an Event. Routing `eventInformation` into adjudication is the
  remaining G-6 work, and it depends on open decisions O-1 … O-6.
- ⚠️ **Implemented, not production-active.** No production runtime consumes the
  `attachment-processing` queue, and the one that exists sets no `USE_AI`.
- See [ch. 06](06-ASYNC-JOBS-ATTACHMENTS-AND-AI.md) for all of the above in detail.

---

## End-to-end flow — one email, in detail

**1. Gmail sync** (`gmail.sync.service.ts → syncGmailAccount`)
The scheduler wakes every 2 minutes and, for each connected account:
- no `historyId` yet → full sync: capture the watermark **before** listing (so messages
  arriving mid-run are caught next time), then list up to 100 messages
- otherwise → `users.history.list` from the stored cursor, paginated
- a `404` on the cursor (Gmail expired it) → fall back to full sync
- finally, write the new `historyId`

**2. Persist + dedupe** (`syncSingleMessage`)
Fetch the message, `parseMessage` walks the MIME tree for the body (prefers `text/plain`,
falls back to stripped `text/html`) and collects attachment metadata. If
`gmailMessageId` already exists → return `duplicate`, do nothing. Otherwise
`createEmail` inserts the Email **and all its Attachment rows in one nested Prisma create**
(a single implicit transaction).

**3. Enqueue** (`email.producer.ts`)
`{ emailId, userId }` onto `email-processing`, `attempts: 3`, exponential backoff from 2 s,
`removeOnComplete: true`, `removeOnFail: false`.

**4. Worker picks it up** (`src/workers/email.worker.ts`)
- reads the Email row by id
- **derives the owner from the row**, not from the payload
- if the payload's `userId` disagrees → `UnrecoverableError` (no retry — a retry can't fix
  a forged payload or a broken invariant)

**5. Processor** (`email.processor.ts`)
Marks the email `processing`, calls `processEmail`, marks it `completed`. On any throw:
`markEmailFailed(reason)` and rethrow so BullMQ retries.

**6. The pipeline** (`email.service.ts → processEmail`)
```
cleanEmail(body).toLowerCase()          strips quoted reply chains, collapses whitespace
   ↓
extract(text)                           regex + optional AI, merged; confidence computed
   ↓
createExtraction(...)                   ALWAYS written, even if we abandon below
   ↓
VIABILITY GATE                          company must be real (not the "unknown" sentinel)
                                        AND date must match ^\d{4}-\d{2}-\d{2}$
                                        else → email status "ignored", return
   ↓
matchEventV2(owner, data)               exact → soft → loose
   ↓
DECIDE
   confidence < 0.6  → createEventService(status "review", reviewReason)
   match found       → updateEventService(...)   → email "completed"
   no match          → createEventService(...)   → email "completed"
```

**7. Fan out attachments** (`processEmailJob`, after success only)
`enqueueAttachmentJobs(emailId)` → for every attachment not already `completed`, add a job
with a deterministic `jobId` of `attachment-<id>`.

**8. Attachment worker** (`document-processing.service.ts`)
Load attachment + email + gmailAccount in one query → skip if already completed → derive
owner from the row → download bytes with that mailbox's refresh token → store under a random
UUID key → mark completed → ask the parser registry for a parser → parse → persist result →
**run Document Intelligence and persist the understanding** (gated on `USE_AI`, fail-soft, so
neither an AI nor a database failure here fails the job). The understanding stops at storage:
nothing reads it, and no Event is touched.

---

## Synchronous vs asynchronous

**Synchronous (inside the HTTP request):**
- OAuth callback: token exchange, ID-token verification, user upsert, mailbox link, session
- `POST /gmail/sync`: the actual Gmail pull happens in-request (it just enqueues per email)
- `POST /email`: save the row, enqueue, return **202 Accepted**
- `GET /event`, `PATCH /event/:id`: plain database reads/writes

**Asynchronous (workers):**
- extraction, confidence, matching, decision, event writes
- attachment download and parsing

**Why the queue exists:**
1. **Durability.** The email is persisted before any processing. A crash loses a job, never
   an email — the row is still there with `processingStatus`.
2. **Retries.** Transient failures (OpenAI 429, Gmail hiccup) get 3 attempts with
   exponential backoff for free.
3. **Latency.** An LLM call takes seconds. Nothing should hold an HTTP connection for that.
4. **Burstiness.** A sync run produces up to 100 emails at once; the queue flattens that.
5. **Isolation.** One poisonous email fails its own job. The other 99 are unaffected.

---

## Failure points and what happens

| Where | Failure | What happens |
|---|---|---|
| Gmail API | account sync throws | Caught per account. Others still sync. Logged. `historyId` **not** advanced, so the next run retries the same window. |
| Gmail cursor | `historyId` expired (404) | Automatic fall back to full sync. |
| Sync of one message | throws | Counted in `stats.failed`, loop continues to the next message. |
| Email insert | duplicate `gmailMessageId` | Short-circuited *before* insert by an explicit lookup. |
| Redis | down | `enqueueEmailProcessing` throws → the sync of that message fails → email stays `pending` and no job exists. **Honest gap: there is no "sweep pending emails" job.** |
| Extraction (AI) | OpenAI error / bad JSON | Caught in `extract()`, logged, `aiData` stays null → regex-only path. The email still processes. |
| Extraction (AI) | invents an unsupported date | `validateAIDate` drops it → falls back to the regex date. |
| Viability gate | no real company or no full date | Email marked `ignored`. Nothing written to Event. Not an error. |
| Matching | no candidate | Creates a new event. A duplicate is the accepted failure. |
| Decision | confidence < 0.6 | Nothing existing is touched; a `review` event is created. |
| Update | new confidence < existing | Update skipped; existing row returned unchanged. |
| Update | event is `confirmed` | Skipped entirely — a human decision outranks any inference. |
| Update transaction | any step throws | Prisma rolls back. No half-written event, no orphan audit row. |
| Event create | unique violation (P2002) | The worker catches it, logs "Duplicate event detected", and **returns successfully** — no retry, because a retry produces the same violation. |
| Email worker | any other throw | `markEmailFailed(reason)` then rethrow → BullMQ retries up to 3× → then the job sits in the failed set (`removeOnFail: false`). |
| Attachment download | Gmail error | `markAttachmentFailed` **and rethrow** → retryable. |
| Attachment | no `gmailMessageId` or no account | `markAttachmentFailed`, **return without throwing** — not retryable, so don't burn retries. |
| Attachment parse | parser throws | `markParsingFailed` only. Download stays `completed`, and it is **not** rethrown (parse failures are deterministic; retrying just re-downloads). |
| Session Redis | down at startup | `server.ts` awaits `connectSessionRedis()` before `listen`. Startup fails loudly rather than serving requests it can't authenticate. |

The overall shape: **most failures degrade to staleness, which is visible and recoverable,
rather than corruption, which is neither.**

---

## Why this architecture

**Why a modular monolith and not services?**
The pipeline stages are tightly coupled by data and always run together for one email.
Splitting them into services would add network calls and distributed failure for no gain at
this scale. What it *does* need is **process** separation — API vs workers — so a slow LLM
call can't block HTTP, and that's exactly what it has.

**Why one write point?**
Every stage before `event.service` returns a proposal. That means you can reason about "can
this path corrupt data?" by reading one file.

**Why put the decision in a service, not the matcher?**
The matcher answers "which event is this?" The service answers "what am I allowed to do
about it?" Merging them was the original design and it's what produced the false-merge bug —
a scoring function ended up making an authorization decision.

**Trade-offs I accepted**
- The scheduler is **in-process** with the API. Simple, and fine for one instance — but two
  API instances means two schedulers, and it uses a global "all accounts" query rather than
  a tenant-scoped one. Documented in the code as deliberate.
- Attachments are stored on the **local filesystem** behind a `StorageService` interface.
  On Render's ephemeral disk that means files don't survive a redeploy. The interface exists
  precisely so swapping in S3 is one line.
- `POST /email` (manual paste) still exists alongside Gmail sync. It's authenticated now,
  and it's the escape hatch that lets the whole pipeline be exercised without a mailbox.
