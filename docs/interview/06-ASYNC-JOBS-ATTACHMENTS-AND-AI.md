# 06 — Async Jobs, Attachments, and AI

All ✅ **Current** unless tagged.

---

# Part 1 — BullMQ + Redis

## Why a queue exists

Five reasons, in the order I'd actually say them:

1. **Durability.** The Email row is written *before* any processing starts. A crash loses a
   job; it never loses an email.
2. **Retries.** OpenAI rate-limits, Gmail hiccups, Postgres blips. BullMQ gives 3 attempts
   with exponential backoff for free.
3. **Latency.** An LLM call takes seconds. No HTTP connection should be held open for that —
   `POST /email` returns **202 Accepted** immediately.
4. **Burstiness.** A Gmail sync run produces up to 100 emails at once. The queue flattens
   that into steady work instead of 100 concurrent LLM calls.
5. **Isolation.** One malformed email fails its own job. The other 99 are unaffected.

## The two queues

`src/shared/constants/queue.constants.ts`

| Queue | Job name | Payload | Producer | Consumer |
|---|---|---|---|---|
| `email-processing` | `process-email` | `{ emailId, userId }` | `email.producer.ts` — from Gmail sync **and** `POST /email` | `src/workers/email.worker.ts` |
| `attachment-processing` | `process-attachment` | `{ attachmentId }` | `attachment.queue.ts` — from the email processor, after success | `attachment.worker.ts` |

Both share one ioredis connection (`src/infrastructure/redis/redis.ts`) configured with
`maxRetriesPerRequest: null` — **BullMQ requires this.** Without it, ioredis's own request
retries interfere with blocking commands the worker relies on.

## Job options

**Email jobs:**
```ts
{ attempts: 3, backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: true, removeOnFail: false }
```

**Attachment jobs — same, plus the important bit:**
```ts
jobId: `attachment-${attachmentId}`
```
A **deterministic job id** makes the enqueue idempotent. If BullMQ retries the upstream email
job and it re-runs `enqueueAttachmentJobs`, the same attachment is not queued twice while a
job with that id is still waiting or active.

`removeOnFail: false` is deliberate: a failed job stays in Redis so you can inspect it. The
repo also has `@bull-board/express` as a dependency for a queue dashboard (❓ not mounted in
`app.ts` — the package is installed but I can't find it wired up; don't claim it works).

## Ordering and dependencies

**There is no ordering guarantee between email jobs.** Emails are processed in whatever
order workers pick them up.

**That's fine, and it's by design.** The whole confidence model exists so that order doesn't
matter: a weak observation is rejected on its *merits*, not because it arrived late. A
correction that arrives before the announcement it corrects still produces the right final
state, because the announcement can only overwrite it if it's at least as trustworthy.

**One real dependency does exist:** attachment jobs are enqueued only *after* their email
processed successfully. See Part 2.

## Retry and failure behaviour, precisely

```
Email worker throws
   → markEmailFailed(reason)  (email.processingStatus = "failed", failureReason set)
   → rethrow
   → BullMQ retries: attempt 2 after ~2s, attempt 3 after ~4s
   → still failing → job lands in the failed set, kept (removeOnFail: false)
```

**Two exceptions where retrying is wrong and the code says so:**

1. **`UnrecoverableError` on ownership mismatch.** If the job payload's `userId` disagrees
   with the persisted Email's `userId`, that's either a forged payload or a broken
   invariant. No retry can fix either, so the job fails permanently and loudly.

2. **Prisma `P2002` (unique violation) is swallowed.** The worker logs "Duplicate event
   detected" and **returns successfully** rather than retrying.

   🕘 **This used to be the mechanism for the create race; it is now a residual safety
   net.** `createEvent` handles its own conflict at the repository boundary — it re-reads
   on a `P2002` that names `(userId, eventKey)` specifically and returns the winner's row,
   so the loser gets an Event rather than aborting. The eventKey race no longer reaches
   this catch. See [ch. 08 §4](08-RELIABILITY-IDEMPOTENCY-AND-TRANSACTIONS.md).

**"What if the worker crashes mid-job?"**
BullMQ marks the job stalled and re-delivers it. The email row is sitting at
`processingStatus = "processing"`, and the re-run recomputes everything from the raw body.
Because matching finds the event by exact key and `detectChanges` returns zero changes, the
re-run is a no-op. **The pipeline is idempotent by construction, not by a dedupe table.**

🕘 **This used to end with an honest gap, and that gap is closed.** It read: *"if Redis is
unreachable at enqueue time, the Email row exists at `pending` and no job exists — there is
no sweeper that picks pending emails back up… That's the right 'what would you build next'
answer."*

It was built. `email.reconciler.ts` sweeps `pending` Emails older than a configured age and
re-enqueues them through the normal producer, on its own timer in the API process —
deliberately not the Gmail scheduler's, since the failure that strands an email is exactly
the moment Gmail sync is least healthy. It is safe to re-enqueue a row that already has a
job: the reconciler cannot see Redis, and the deterministic `jobId` is what makes the
duplicate collapse into the existing job.

The guarantee is **at-least-once delivery with eventual processing — not exactly-once**,
which is not achievable across Postgres and Redis and is not claimed. See
[`docs/02_Backend/Gmail_Synchronization.md`](../02_Backend/Gmail_Synchronization.md) and
[`docs/deployment.md §11.6`](../deployment.md#116-the-email-reconciler).

---

# Part 2 — Attachment processing

## The lifecycle

```
Gmail sync
   collectAttachments(payload)      metadata only — filename, mimeType, size,
        │                            gmailAttachmentId. Bytes NOT downloaded.
        ▼
   createEmail({ ..., attachments }) one nested Prisma create = one transaction
        │                            Attachment rows start at status "pending"
        ▼
   ── email job runs and SUCCEEDS ──
        │
        ▼
   enqueueAttachmentJobs(emailId)   every attachment not already "completed"
        │
        ▼
   attachment worker → DocumentProcessingService.process(id)
        │
        ├─ load attachment + email + gmailAccount in ONE query
        ├─ already completed? → return (idempotent)
        ├─ derive owner from attachment.userId
        ├─ no gmailMessageId / no account? → markFailed, return (NOT retryable)
        ├─ markProcessing
        ├─ download bytes with THAT mailbox's refresh token
        ├─ store under randomUUID + extension
        ├─ markCompleted(storagePath)
        └─ parser = registry.findParser(mimeType)
              parser? → parse → updateParsedResult
              parse throws → markParsingFailed  (status stays "completed", NOT rethrown)
                  │
                  └─ runDocumentIntelligence(owner, id, parsed)     ← G-6.3
                        USE_AI !== "true"? → return, no provider call, no row
                        analyze → saveDocumentIntelligence
                        anything throws → logged, swallowed (job still succeeds)
```

## Why attachments are processed *after* the email

🕘 **Historical:** attachment jobs used to be enqueued at sync time, before extraction ran.
So an email that failed extraction still downloaded its attachments — wasted API calls,
wasted storage, and jobs for emails that turned out to be irrelevant.

✅ **Current:** `enqueueAttachmentJobs` is the **last line** of `processEmailJob`. Extraction
throws → the rethrow returns early → attachments are never queued.

**The general lesson to state:** *background jobs should be triggered only after their
prerequisites have completed successfully.*

## Attachment ownership

The attachment worker's payload is **`{ attachmentId }` and nothing else.** There is a test
suite (`attachment.queue.test.ts`) whose entire purpose is to *pin* that — it asserts
`Object.keys(payload) === ["attachmentId"]` and that the payload has no `userId`.

Why: a queue is not an authenticated channel. Anything with Redis access can enqueue a job.
A `userId` in the payload would be a **claim**, and it would sit alongside the authoritative
answer already in the database — a second, weaker source of truth. So the worker loads the
row and takes `userId` off it. Every subsequent write is scoped by that derived owner.

Credentials are resolved the same way: `Attachment → Email → GmailAccount → refreshToken`,
in a single query with nested `include`. 🕘 The first version called
`getFirstGmailAccount()` — "whichever mailbox happens to exist" — which was silently wrong
the moment a second mailbox connected.

## Storage

`StorageService` interface (`store` / `read` / `delete`), implemented by
`LocalStorageService`. Files go under `ATTACHMENT_STORAGE_DIR` (default
`<cwd>/storage/attachments`).

**Storage keys are opaque:** `randomUUID() + extension`. The original filename is kept
separately in the database.

Why: predictable keys derived from user-supplied filenames give you collisions, and they put
user-controlled data on the filesystem path. `LocalStorageService.resolve()` additionally
guards against traversal (`../`) by resolving and confirming the result stays inside the
root.

The interface exists so a future `S3StorageService` is a one-line swap. 🚧 On Render's
ephemeral disk, local storage means files don't survive a redeploy — a known limitation.

## Two independent failure domains

This is a small design point interviewers like:

| Failure | `processingStatus` | Recorded | Rethrown? |
|---|---|---|---|
| Download fails | `failed` | `processingError` | **Yes** — transient, retry it |
| No message id / no account | `failed` | `processingError` | **No** — nothing a retry can fix |
| Parse fails | stays `completed` | `parsingError` | **No** — deterministic; retrying only re-downloads |

The attachment is marked `completed` the moment the **download** succeeds, before parsing is
even attempted. So a later parse failure can never flip a successful download back to failed.

## Parser architecture (Open/Closed)

```
DocumentProcessingService
        │  "which parser handles this MIME type?"
        ▼
   ParserRegistry              ← the ONLY place that knows MIME → parser
        │
   ┌────┴─────┐
   ▼          ▼
PdfParser  SpreadsheetParser        (both implement AttachmentParser)
```

```ts
interface AttachmentParser {
  supports(mimeType: string): boolean;
  parse(filePath: string): Promise<ParsedAttachment>;
}

interface ParsedAttachment {
  text: string;              // flattened plain text — the common denominator
  structuredData?: unknown;  // e.g. spreadsheet rows
  metadata?: ParsedMetadata; // e.g. { pages, pdfVersion }
}
```

**The point:** `DocumentProcessingService` contains **zero** MIME-type conditionals. Adding
DOCX means writing one class and adding one line to the registry array. Nothing else changes.

- **`PdfParser`** — `pdf-parse` (pdf.js underneath). Overrides the default decorative page
  joiner (`-- 1 of 2 --`) with a plain paragraph break so `text` holds real content. Always
  calls `parser.destroy()` in a `finally` to release pdf.js worker resources.
- **`SpreadsheetParser`** — `exceljs`, `.xlsx` only. Preserves the grid exactly: worksheet
  names, row order, cell order, empty cells kept as `""` so positions don't shift. Produces
  both a flattened text view (`Sheet: <name>`, cells joined by `" | "`) and `structuredData`.
  It deliberately does **no** interpretation — no header detection, no schema inference.
- **`TextNormalizer`** — shared by every parser: normalise line endings, collapse repeated
  spaces, strip trailing whitespace, collapse 3+ blank lines into one.

---

# Part 3 — Document Intelligence

## Status at a glance

Three states, and the whole point of this section is not to blur them.

| Area | Status | Current reality |
|---|---|---|
| Classification | **IMPLEMENTED** | `DocumentClassifier` → `ClassificationResult { documentType, confidence, summary }` |
| Event / participant extraction | **IMPLEMENTED** | `EventExtractor`, `ParticipantExtractor`, gated on the classification |
| Assembly | **IMPLEMENTED** | `DocumentInsightsAssembler` → `DocumentInsights`, pure and offline |
| Orchestration | **IMPLEMENTED** (G-6.2) | `DocumentIntelligenceService.analyze(parsed)` runs the four above in order |
| Persistence | **IMPLEMENTED** (G-6.1) | `saveDocumentIntelligence` upserts one `DocumentIntelligence` row per attachment |
| Attachment invocation | **IMPLEMENTED** (G-6.3) | `DocumentProcessingService` calls it after the parsed content is durable |
| `USE_AI` gate | **IMPLEMENTED** | Read per call; anything other than `"true"` means no provider call and no row |
| Fail-soft boundary | **IMPLEMENTED** | One `try/catch`, at the call site |
| **Production execution** | **NOT ACTIVE** | The attachment worker *is* run in production as a manual drain, but that workflow ships no `USE_AI` — so no `DocumentIntelligence` row has ever been written there. See *Production status* |
| Participant consumption | **IMPLEMENTED** (G-8.4) | `GET /user/shortlists` reads `participantInformation` to answer *"am I on this shortlist?"* — the first and only consumer of anything this layer stores |
| **Event adjudication** | **PLANNED — remaining G-6** | `eventInformation` is stored and read by nothing. **No document has ever created or updated an Event** |
| **O-1 … O-6** | **OPEN** | Architectural decisions the planned work depends on; none resolved |

🕘 **Historical:** this section previously read *"implemented, tested, not wired into the
pipeline"*, and `index.ts` said the layer *"persists nothing"*. That was accurate then.
G-6.1, G-6.2 and G-6.3 changed it — the layer now runs and stores its output. What has
**not** changed is the part that matters most: nothing consumes what it stores.

## What runs today

```
Attachment
      │  download → store → markCompleted
      ▼
AttachmentParser (PDF | spreadsheet, via the registry)
      │
      ▼
ParsedAttachment { text, structuredData?, metadata? }
      │  updateParsedResult  ← persisted FIRST
      ▼
DocumentIntelligenceService.analyze(parsed)          ← G-6.2 orchestrator
      │
      ├─ DocumentClassifier ──► ClassificationResult { documentType, confidence, summary }
      │
      ├─ EventExtractor        (job_description | interview_schedule | general_instructions)
      │         → EventInformation { company?, stage?, date?, time?, venue? }
      │
      ├─ ParticipantExtractor  (shortlist | seating_arrangement | result)
      │         → ParticipantInformation { participants: [{ attributes }] }
      │
      └─ DocumentInsightsAssembler ──► DocumentInsights
      │
      ▼
saveDocumentIntelligence(owner, attachmentId, insights, extractedAt)   ← G-6.1
      │
      ▼
DocumentIntelligence row
      │
      ├─ participantInformation ──►  GET /user/shortlists   ("am I on this list?")
      └─ eventInformation       ──✗──►  nothing reads it
```

- `DOCUMENT_TYPE`: `job_description`, `interview_schedule`, `general_instructions`,
  `seating_arrangement`, `shortlist`, `result`, `unknown`.
- The classifier **never throws.** Any failure — AI disabled, provider error, malformed
  output, an unrecognised label — degrades to `{ UNKNOWN, confidence: 0, summary: "" }`.
- Both extractors gate on classification: a `shortlist` never reaches the event extractor.
  Their type gates are **disjoint**, so at most one of them makes a network call.
- Both extractors normalise the model's output field by field, dropping anything missing,
  wrong-typed, or empty, so `undefined` means *leave unchanged* rather than *blank it*.
- The assembler is pure — no AI, no network — and attaches the optional slices only when
  they actually carry content.

## The orchestrator — `DocumentIntelligenceService`

It **coordinates the components above; it does not add an AI architecture of its own.** Its
four collaborators are constructor-injected with singleton defaults, so a test supplies
fakes without touching a provider. `analyze(parsed)` runs classify → event extract →
participant extract → assemble, sequentially and in that fixed order.

Two deliberate absences worth being able to defend:

**It does not persist.** `analyze` returns a `DocumentInsights` and writes nothing. Storing
is `saveDocumentIntelligence`'s job, exported separately, so the call site decides whether
understanding and storing happen together.

**It contains no `try/catch`.** All three AI collaborators are contractually no-throw — an
unclassifiable document is a normal outcome that arrives as a degraded *value*, not an
exception. A catch here could therefore only ever swallow a genuine defect, such as a
collaborator breaking that contract.

## Persistence — the `DocumentIntelligence` row

One row per attachment, enforced by the database via `@@unique([attachmentId, userId])` —
the same guarantee, for the same reason, that `EmailExtraction` gets from
`@@unique([emailId, userId])`. Attachment processing is genuinely replayed (BullMQ stalled
jobs), so the write is an **upsert** resolved on that key, and the constraint is what makes
a replay converge on one row instead of appending a second.

The architecturally interesting fields:

| Field | Why it matters |
|---|---|
| `attachmentId` + `userId` | Composite FK to `Attachment(id, userId)`, so the row cannot disagree with its attachment's owner |
| `classification` | The `DocumentType`, stored as its string value — not a database enum, so the vocabulary can evolve in `document-type.ts` without a lockstep migration |
| `classificationConfidence` | **Named for what it is.** How sure the classifier was *about the document's type* — see the warning below |
| `eventInformation` | JSON. The slice the planned G-6 work will consume. Written today, **read by nothing** |
| `participantInformation` (consumption) | JSON. **Read by `GET /user/shortlists`** via `shortlist.repository` — tenant-scoped, selecting only `attachmentId` and this column. `summary` is deliberately excluded: it synopsises a document listing other students |
| `participantInformation` | JSON. Deliberately an open bag of document-supplied labels; normalising it is a later entity-resolution layer's job |
| `extractedAt` | Moves forward on every successful write, which is what distinguishes it from `createdAt` — a replay is not a new understanding |

**LATEST WINS, deliberately.** The update branch sends explicit values for every mutable
field, including SQL `NULL` for an absent slice. Prisma reads `undefined` as *leave this
column alone*, which would let a replay that understood **less** silently retain the
previous attempt's `eventInformation` — leaving the row describing neither run.

> ⚠️ **`classificationConfidence` is not an extraction confidence.** It answers *"how sure
> am I this is an interview schedule"*, not *"how sure am I this date is right"*. It is the
> **only** confidence the layer produces — there is no extractor-level or field-level
> confidence anywhere in the module, and the extraction prompts do not ask for one. It is
> **not** used for Event matching today, and whether it could be is **O-6**, below.

## The call site — where G-6.3 wired it in

In `DocumentProcessingService.parseAndPersist`, and the ordering is the design:

```
updateParsedResult(...)                 ← parsed content becomes durable
        ↓
runDocumentIntelligence(owner, id, parsed)
```

**Understanding is derived from the parsed text, so it must not be able to exist for content
that was never stored.** Persisting the parse first means a `DocumentIntelligence` row
always has the parsed document behind it that produced it.

### The `USE_AI` gate

`process.env.USE_AI !== "true"` → return immediately. No provider call, no row.

Read **per call**, not at module load — matching `extraction.service`. Compared against the
exact string `"true"`, so a missing, empty, or mistyped value means off. That is not merely
cost control: **the production worker ships no `OPENAI_API_KEY`**, so an ungated call would
fail on every attachment forever and log a failure for each one.

### Fail-soft — one boundary, and only one

This is the part to get right, because "we catch errors" is not an architecture:

```
attachment job
  ├─ download          → failure marks attachment failed, RETHROWN (BullMQ retries)
  ├─ parse             → failure records parsingError, NOT rethrown
  ├─ persist parsed    → durable
  └─ document intelligence
        ├─ classifier / extractors / assembler   no-throw by contract → degrade to values
        ├─ saveDocumentIntelligence              PROPAGATES database errors on purpose
        └─ ◄── the single try/catch lives HERE ──►  logs and swallows
```

Three distinct behaviours, and they are not the same thing:

1. **The AI components don't fail** — they degrade to `unknown` / `{}` / no participants.
2. **The repository does fail loudly.** It deliberately catches nothing, so a failed write
   is never reported as a successful understanding.
3. **The call site catches both** — and it is the *only* place that policy lives.

Why swallow at all? Because the download and the parse already succeeded and are already
durable. Failing the job would re-download the file on retry without making an AI or
database failure any likelier to resolve — the same isolation, for the same reason, that a
parse failure already gets. **This is a narrow, local decision, not a global policy: nothing
else in the application swallows AI or database errors.**

The log carries safe scalars only — `attachmentId` and `error.message`, never the error
object — because this path can surface provider errors whose payloads may carry request
context.

## Production status

**The pipeline runs. The understanding step does not.** Be precise about which half you are
claiming — the two halves have different answers.

**1. `attachment-processing` DOES have a consumer — a manual one.**
`.github/workflows/production-attachment-worker.yml` runs the compiled entrypoint
(`node dist/src/modules/attachment/attachment.worker.js`) with
`WORKER_EXIT_WHEN_DRAINED=true`, behind `workflow_dispatch` and a required reviewer. So
attachments **are** downloaded, stored and parsed in production — whenever I dispatch that
drain. What does not exist is a *continuously running* consumer: the API service
(`node dist/src/server.js`) starts Express, the Gmail scheduler and both reconcilers, and no
BullMQ worker. Jobs accumulate between drains. Full runtime picture:
[ch. 15](15-RUNTIME-AND-DEPLOYMENT.md).

**2. That workflow deliberately ships no `USE_AI` and no `OPENAI_API_KEY`.** So
`runDocumentIntelligence` returns at its first line, makes no provider call, and writes no
`DocumentIntelligence` row. **Document Intelligence has never executed in production.** The
omission is a decision about cost and data egress, not an oversight — enabling it is a
separate, deliberate change, not something a runtime change should turn on as a side effect.

> Note the asymmetry with the **email** drain, which *does* set `USE_AI=true` and does carry
> an `OPENAI_API_KEY`. `USE_AI` is read at two independent call sites — `extraction.service`
> for email extraction, and `document-processing.service` for document understanding — and
> the two production workflows deliberately differ on it.

**Say it as a distinction, because it is the interesting part:** *implemented* is a property
of the repository; *executing in production* is a property of the deployment. Document
Intelligence is the one place in this system where the two still differ, and knowing which
claim you are making is the difference between an honest status and an overclaim.

## Planned G-6 — the one step that remains

**G-6 is not complete.** The sub-numbering the repository's commits use:

| | Scope | Status |
|---|---|---|
| **G-6.1** | Persistence groundwork — `DocumentIntelligence` model, migration, repository | Done |
| **G-6.2** | Orchestration — `DocumentIntelligenceService` | Done |
| **G-6.3** | Attachment-processing integration — the gated, fail-soft call site | Done |
| **Remaining G-6** | Route persisted `eventInformation` into Event adjudication | **Not started** |

Conceptually, and **none of this exists today**:

```
DocumentIntelligence.eventInformation        (stored today)
        ↓
viability / normalization                    (does not exist)
        ↓
document observation                         (does not exist)
        ↓
Event adjudication — the SAME path an email observation takes
        ↓
existing Event create / update / review machinery — unchanged
```

The principle the earlier version of this section already stated, and which still holds:
**it should not get a private path to the database.** A document must enter where an email
enters, or the boundary was drawn wrong.

Why it is deliberately a separate step: it is the first time a document could change an
Event, and it inherits every question this system already answers for email — identity,
confidence, recognition tier, and what a document's confidence even means relative to an
extraction's.

### Open decisions — O-1 … O-6

**All OPEN.** None is resolved, and none should be read as a requirement or a plan. They are
recorded because the remaining work cannot be specified until they are answered — and
because answering them silently, inside an implementation, is how a system acquires
behaviour nobody decided on.

| | Question | Status |
|---|---|---|
| **O-1** | May a document with no resolved stage adjudicate at all? Passing the `"unknown"` sentinel makes it eligible for the weakest tier's exact-equality matching; refusing it means schedule documents naming no round never adjudicate | **OPEN** |
| **O-2** | May documents ever take the Event **update** branch, and on what evidence — or are they create-and-review only? | **OPEN** |
| **O-3** | Should document → Event provenance be recorded? No relation exists between `DocumentIntelligence` and `Event`, so "which document said this" is currently unanswerable | **OPEN** |
| **O-4** | Should the review path honour `matchResult` instead of discarding it? Copying email's low-confidence branch verbatim creates a review Event per document, including for Events that already exist | **OPEN** |
| **O-5** | Company normalization scope — documents only, or globally? The identity key applies no normalization, and email lowercases its source text while the document extractor does not | **OPEN** |
| **O-6** | What *is* a document observation's confidence? `classificationConfidence` is a statement about the document's type, not about its extracted fields, and no field-level confidence exists to substitute | **OPEN** |

## The partially-completed refactor (still true)

`DocumentClassifier` uses the AI Core (`structuredCompletion`), but `EventExtractor` and
`ParticipantExtractor` still call `openai.chat.completions.create` directly with their own
fence-stripping and `JSON.parse`. They were written before the AI Core and haven't been
migrated. That's a real, visible partial refactor — and it's a *good* thing to volunteer,
because it shows you know the difference between a plan and a shipped state.

One detail that changed underneath it: they import `getOpenAIClient` from
`extraction.service`, which now **re-exports** it rather than defining it. See *Part 4*.

---

# Part 4 — AI Core

`src/modules/ai/` — the abstraction, and why it exists.

## The problem it solved

Four AI-powered services (email extraction, document classification, event extraction,
participant extraction) each independently did:

```
build the OpenAI request → send it → get raw text
   → strip ```json fences → JSON.parse → handle empty response
   → handle malformed JSON → handle provider errors → decide whether to retry
```

The *business logic* differed. The *plumbing* was byte-for-byte identical. This is a
cross-cutting concern, and duplicating it means the fifth AI feature copies the same code a
fifth time — and any fix has to be made in four places.

## The pieces

```ts
structuredCompletion<T>({ systemPrompt, userPrompt, model?, provider?, parser?, retryPolicy? })
```

That's the one function callers need. Internally:

```
retryPolicy.execute(async () => {
   const raw = await provider.complete({ systemPrompt, userPrompt, model });
   return parser.parse<T>(raw);
});
```

| Piece | Responsibility |
|---|---|
| `AIProvider` (interface) | `complete(request) → raw text`. Knows nothing about JSON or retries. |
| `OpenAIProvider` | Wraps the **same memoized client** the services already use (`getOpenAIClient`). Translates OpenAI's error surface into typed errors. |
| `openai-client` | Owns `getOpenAIClient` — the lazily-constructed, memoized client. A **leaf**: it imports the OpenAI SDK and nothing else in this codebase. |
| `JsonResponseParser` | Strip markdown fences, `JSON.parse`, throw `MalformedResponseError` carrying the raw text. |
| `RetryPolicy` | Up to N attempts, linear backoff (`delayMs × attempt`), retrying only on transient errors. Defaults: 3 attempts, 250 ms. |
| `ModelConfig` | `{ model, temperature?, maxTokens? }`. Default: `gpt-4o-mini` @ `temperature: 0`. Provider-agnostic on purpose. |
| Error hierarchy | `AIError` → `EmptyResponseError`, `MalformedResponseError`, `ProviderError(retryable)` |

## What counts as retryable

`isTransientError`:
- `MalformedResponseError` — the model returned prose instead of JSON; it may not next time
- `EmptyResponseError` — no content came back
- `ProviderError` with `retryable: true`

And `OpenAIProvider.isRetryable` decides that last flag:
- `APIError` with **no** status → network/timeout → retry
- `408`, `429`, or any `5xx` → retry
- `400 / 401 / 403 / 404 / 422` → **don't** retry; an identical request won't fix an auth
  error or a bad request
- anything that isn't an `APIError` → don't retry (a programming fault)

## Why typed errors instead of strings

Because `if (error.message.includes("Invalid JSON"))` is a contract that breaks silently
when someone rewords a message. A caller can now catch `AIError` for "any AI failure" or
narrow to `MalformedResponseError` for "the model gave me garbage."

## Why `T` is not a runtime schema

`structuredCompletion<T>` asserts that the response **is JSON**. It does not validate that
it matches `T`. Every caller still normalises the result itself — `normalizeResult` in the
classifier and both extractors, and `mergeExtraction` + `validateAIDate` for email
extraction.

That separation is intentional: the Core owns *transport and shape*, the caller owns
*meaning*. If I wanted runtime schema validation, Zod would slot in at the parser seam
without touching anything else.

## Migration status (be precise)

| Service | Uses AI Core? |
|---|---|
| `extraction.service.ts` (email) | ✅ yes — `structuredCompletion`, with `maxAttempts: 1` |
| `document-classifier.service.ts` | ✅ yes — `structuredCompletion`, with `maxAttempts: 1` |
| `event-extractor.service.ts` | ❌ no — direct OpenAI call |
| `participant-extractor.service.ts` | ❌ no — direct OpenAI call |

**Why the two migrated ones disable retries:** they previously made exactly one provider call
and degraded on any failure (extraction → regex-only, classifier → UNKNOWN). Passing
`new RetryPolicy({ maxAttempts: 1 })` preserves that behaviour *identically*, so introducing
the Core changed nothing observable. That's a deliberate refactoring discipline worth
stating: **an abstraction that changes behaviour while it's being introduced can't be
verified.**

## The dependency graph, and the constraint it encodes

```
   openai (SDK)
       ▲
   ai/openai-client        ← leaf: owns the memoized getOpenAIClient
       ▲            ▲
       │            └──────────── extraction.service   (re-exports it)
   ai/openai-provider                    ▲
       ▲                                 │
   ai/structured-completion              └── document-intelligence extractors
       ▲
   ai/index
```

**The architectural fact:** `openai-client` is a leaf, and nothing under `ai/` imports
anything outside it. That is what makes the AI Core a genuine dependency *sink* rather than
a module tangled with its own callers.

🕘 **Historical, and worth knowing because it constrains future edits.** `getOpenAIClient`
used to live in `extraction.service`, so `openai-provider` imported it from there — closing
a cycle: `ai/index → structured-completion → openai-provider → extraction.service →
ai/index`. Under production ESM that cycle is harmless; live bindings are linked before any
module body runs. Under the **CommonJS** output ts-jest produces it is fatal — `exports` is
populated incrementally, so a module reached mid-cycle sees a half-built namespace, and the
symptom was `RetryPolicy is not a constructor` in tests that touched neither retries nor
extraction.

The fix moved the definition into its own leaf module; `extraction.service` re-exports the
symbol so its existing importers and test mocks are unaffected, and there is still exactly
one memoized client. **The rule that survives: nothing under `ai/` may import from a module
that imports `ai/`.** A cycle that passes in production and fails only under the test
transform is an expensive kind of bug to rediscover. The same rule is stated for
contributors in [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

**The client is lazy, not constructed at startup.** `getOpenAIClient()` checks
`OPENAI_API_KEY` on **every** call and throws `OPENAI_API_KEY not set` when it is absent,
then memoizes the client in a module-scoped variable on first successful call. Two
consequences worth knowing:

- Importing this module — directly or through `ai/index` — costs nothing and touches no
  configuration. A process that never reaches a gated AI path never constructs a client and
  never needs a key. That is what lets the production worker run with no `OPENAI_API_KEY` at
  all.
- Because the key is re-checked per call rather than captured once, a missing key surfaces
  at the call that needed it, not as an opaque startup failure.

**Why the leaf placement matters more than it looks.** The natural instinct when a new AI
feature needs the client is to import it from wherever is convenient — and
`extraction.service` still re-exports it, so that import compiles. The rule is about the
*direction*: `ai/openai-client` must keep importing nothing but the OpenAI SDK. Adding any
application import to it re-forms the cycle, and the failure will not appear in production
— only under Jest, in a suite that may have nothing to do with the change.

## "What happens when OpenAI is down?"

Nothing user-visible. `USE_AI` is `false` by default anyway. When it's on and the call fails,
`extract()` catches it, logs `"AI failed: <message>"`, leaves `aiData` null, and the pipeline
runs on regex output alone. Confidence will typically be lower (fewer fields resolved), which
may route the email to review — which is exactly the right degradation.
