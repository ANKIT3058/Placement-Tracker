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

2. **Prisma `P2002` (unique violation) is swallowed.** Two workers racing to create the same
   event: the loser gets a unique-constraint error on `(userId, eventKey)`. The worker logs
   "Duplicate event detected" and **returns successfully**. Retrying would just reproduce
   the same violation, and the desired end state — one event — already exists.

**"What if the worker crashes mid-job?"**
BullMQ marks the job stalled and re-delivers it. The email row is sitting at
`processingStatus = "processing"`, and the re-run recomputes everything from the raw body.
Because matching finds the event by exact key and `detectChanges` returns zero changes, the
re-run is a no-op. **The pipeline is idempotent by construction, not by a dedupe table.**

**Honest gap:** if Redis is unreachable at enqueue time, the Email row exists at `pending`
and no job exists — there is no sweeper that picks pending emails back up. The repository
of `getPendingEmails` / `getFailedEmails` exists in `email.repository.ts` for exactly that,
but nothing calls them yet. That's the right "what would you build next" answer.

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

## 🚧 Status: implemented, tested, **not wired into the pipeline**

Say this plainly. `src/modules/document-intelligence/index.ts` says it itself: *"It is not
yet wired into the attachment pipeline and persists nothing."* I verified it — nothing
outside that folder imports it.

**What exists:**

```
ParsedAttachment
      │
      ▼
DocumentClassifier ──► ClassificationResult { documentType, confidence, summary }
      │
      ├──► EventExtractor        (job_description | interview_schedule | general_instructions)
      │         → EventInformation { company?, stage?, date?, time?, venue? }
      │
      └──► ParticipantExtractor  (shortlist | seating_arrangement | result)
                → ParticipantInformation { participants: [{ attributes }] }
      │
      ▼
DocumentInsightsAssembler ──► DocumentInsights
```

- `DOCUMENT_TYPE`: `job_description`, `interview_schedule`, `general_instructions`,
  `seating_arrangement`, `shortlist`, `result`, `unknown`.
- The classifier **never throws.** Any failure — AI disabled, provider error, malformed
  output, an unrecognised label — degrades to `{ UNKNOWN, confidence: 0, summary: "" }`.
- Both extractors gate on classification: a `shortlist` never reaches the event extractor.
- Both extractors normalise the model's output field by field, dropping anything missing,
  wrong-typed, or empty, so `undefined` means *leave unchanged* rather than *blank it*.
- The assembler is pure — no AI, no network — and attaches the optional slices only when
  they actually carry content.

**Honest inconsistency worth knowing:** `DocumentClassifier` uses the AI Core
(`structuredCompletion`), but `EventExtractor` and `ParticipantExtractor` still call
`openai.chat.completions.create` directly with their own fence-stripping and `JSON.parse`.
They were written before the AI Core and haven't been migrated. That's a real, visible
"partially completed refactor" — and it's a *good* thing to volunteer, because it shows you
know the difference between a plan and a shipped state.

**How I'd wire it up:** after `updateParsedResult`, run classify → extract → assemble, then
feed `EventInformation` into the *existing* decision layer as another observation — with its
own confidence, subject to the same identity gate and the same confidence guard. The point
is that it should not get a private path to the database.

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
| `OpenAIProvider` | Wraps the **same memoized client** the services already used (`getOpenAIClient`). Translates OpenAI's error surface into typed errors. |
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

## "What happens when OpenAI is down?"

Nothing user-visible. `USE_AI` is `false` by default anyway. When it's on and the call fails,
`extract()` catches it, logs `"AI failed: <message>"`, leaves `aiData` null, and the pipeline
runs on regex output alone. Confidence will typically be lower (fewer fields resolved), which
may route the email to review — which is exactly the right degradation.
