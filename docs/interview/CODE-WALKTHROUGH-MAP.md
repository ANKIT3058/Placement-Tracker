# Code Walkthrough Map

For when the interviewer says **"open the code and show me."**

Every path below was verified to exist. Paths are relative to `backend/` unless noted.

---

## The 60-second orientation

If they ask "show me around the repo", say this while scrolling:

> "Backend and client are separate packages — there's no workspace root. Inside the backend,
> `src/modules/` is feature-based, not layer-based: each module has its controller, service,
> repository and types together. `gmail` handles ingestion, `email` orchestrates the pipeline,
> `extraction` reads fields, `matching` decides identity, `event` is the only thing that writes
> events. `infrastructure/` is Redis and the queues, `workers/` is the process entry points,
> and `shared/` is constants and date utilities."

---

# 1. Gmail OAuth

| | |
|---|---|
| **Files** | `src/modules/gmail/gmail.service.ts`, `gmail.controller.ts`, `gmail.route.ts`, `gmail.repository.ts` |
| **Functions** | `generateAuthUrl`, `getTokens`, `verifyGoogleIdToken`, `getGmailAddress`, `gmailCallbackController`, `connectGmailAccount` |

**What to explain:**
1. `generateAuthUrl` — point at `access_type: "offline"` and `prompt: "consent"`. *"Offline is
   what gets me a refresh token; consent forces it, because Google only issues one on first
   authorization."*
2. `verifyGoogleIdToken` — signature, `aud`, `exp`, an explicit issuer allowlist, `sub`,
   `email_verified`. *"Absent `email_verified` is treated as unverified — reading a missing value
   as 'verified' would invert the guard."*
3. `gmailCallbackController` — **the ordering**: all validation first, then two writes.
   *"Resolving the user earlier would leave an orphan User row whenever the token exchange
   failed."*
4. `connectGmailAccount` — read-then-write, not upsert. *"The ownership rule is conditional — a
   mailbox already owned by a different user keeps its owner — and an upsert can't express
   that."*
5. **Pre-empt:** the comment above `gmailCallbackController` naming the missing `state`
   parameter. Point at it yourself.

---

# 2. Gmail sync

| | |
|---|---|
| **Files** | `src/modules/gmail/gmail.sync.service.ts`, `gmail.service.ts`, `gmail.scheduler.ts` |
| **Functions** | `syncGmailAccount`, `syncSingleMessage`, `processMessages`, `getHistoryChanges`, `getLatestHistoryId`, `isHistoryIdExpired`, `runSyncCycle` |

**What to explain:**
1. `syncGmailAccount` — the full-vs-incremental branch. **Point at `runFullSync` calling
   `getLatestHistoryId` *before* `getRecentMessages`.** *"Overlap is safe; gaps are not."*
2. `isHistoryIdExpired` → the 404 fallback to full sync.
3. `getHistoryChanges` — the `do/while` on `nextPageToken`, ids into a `Set`.
4. `syncSingleMessage` — the duplicate short-circuit, and `userId: account.userId`.
   *"Ownership flows from the mailbox that produced the observation."*
5. `runSyncCycle` — the `isRunning` guard and the sequential per-account loop with try/catch.

---

# 3. Email parsing (MIME)

| | |
|---|---|
| **File** | `src/modules/gmail/gmail.service.ts` |
| **Functions** | `parseMessage`, `extractBody`, `findBodyByMimeType`, `htmlToPlainText`, `collectAttachments`, `decodeBase64Url` |

**What to explain:**
- `findBodyByMimeType` is **recursive**. *"The first version only read `payload.body.data`,
  which is empty for any multipart message — so basically every real email."*
- Preference order: `text/plain` → stripped `text/html` → Gmail's `snippet`.
- `collectAttachments` keeps a part only if it has **both** a `filename` and a
  `body.attachmentId` — inline body parts have no attachmentId.
- Base64**url**, not base64.

---

# 4. Email persistence

| | |
|---|---|
| **File** | `src/modules/email/email.repository.ts` |
| **Functions** | `createEmail`, `getEmailByGmailMessageId`, `getEmailById`, `updateEmailStatus`, `markEmailFailed` |

**What to explain:**
- `createEmail` — the **nested create**. *"One implicit transaction: the email and all its
  attachment rows, or none of them."* And: *"I don't write `Attachment.userId` at all — the
  composite foreign key makes both columns relation scalars, so Prisma fills them from the
  parent. The constraint deleted the code that could violate it."*
- **`getEmailById` — the ownership derivation root.** Read the comment aloud if you can.
  *"Deliberately unscoped. This is where the pipeline learns who owns the work. Requiring an
  owner would be circular, and it's safe because it's not reachable from a request."*
- `updateEmailStatus` — `updateMany` with a tenant predicate, and the `count === 0` warning.
  *"A refused cross-tenant write returns a count instead of throwing, so it's observable."*

---

# 5. Queue producer

| | |
|---|---|
| **Files** | `src/modules/email/email.producer.ts`, `src/infrastructure/queue/queues.ts`, `src/shared/constants/queue.constants.ts` |
| **Function** | `enqueueEmailProcessing` |

**What to explain:**
- The job options: `attempts: 3`, exponential backoff from 2000 ms, `removeOnComplete: true`,
  `removeOnFail: false`. *"Failed jobs are kept so I can inspect them."*
- The comment on `userId`: *"Carried for cross-checking only. It never authorizes anything."*

---

# 6. Queue worker

| | |
|---|---|
| **Files** | `src/workers/email.worker.ts`, `src/modules/email/email.processor.ts` |
| **Functions** | the `Worker` handler, `processEmailJob` |

**What to explain — this is a strong file, spend time here:**
1. Owner derivation: `const owner = { userId: email.userId }` — from the **row**.
2. The claim cross-check → `UnrecoverableError`. *"A queue isn't an authenticated channel. The
   payload's userId is a claim, carried only so a disagreement is detectable, and a mismatch is
   something no retry can fix."*
3. The `P2002` catch → `return` (success, no retry). *"The desired end state already exists."*
4. In `processEmailJob`: `markEmailFailed` then **rethrow**, so BullMQ still retries.
5. `enqueueAttachmentJobs` as the **last line**. *"An email that fails never starts attachment
   processing, because the rethrow returns before this line."*

---

# 7. The pipeline orchestrator

| | |
|---|---|
| **File** | `src/modules/email/email.service.ts` |
| **Function** | `processEmail` |

**This is the file to open first if they say "show me how it works."** It reads top to bottom
as the whole pipeline.

**What to explain:**
1. `cleanEmail(email.body).toLowerCase()`
2. `extract(cleanText)` — destructuring **all four** values. *"This is where a real bug lived —
   I used to destructure only `data`, so confidence never reached the layer that guards
   updates, and the entire guard silently never fired."*
3. `createExtraction(...)` — written **before** the gate. *"So I can debug what was read even
   for emails I abandon."*
4. **The viability gate** — read the comment aloud. *"`isResolvedCompany` instead of a
   truthiness check, because extraction substitutes the literal string 'unknown' and that's
   truthy. It used to pass, create an event named 'unknown', and that event then became a
   matching candidate for every later unresolved email."*
5. `matchEventV2` → the three-way decision.
6. **Be honest:** matching is called *before* the low-confidence check, so on the review path
   its result is discarded. *"Slightly wasteful — something I'd tidy up."*

---

# 8. Extraction — deterministic

| | |
|---|---|
| **File** | `src/modules/email/email.parser.ts` |
| **Functions** | `cleanEmail`, `QUOTE_BOUNDARY`, `findDateEvidence`, `extractExactDate`, `extractCompany`, `extractStage`, `extractTime`, `extractVenue`, `isResolvedCompany` |

**What to explain:**
- **`QUOTE_BOUNDARY`** — the five alternatives, and read the comment about the Bajaj Auto
  email. *"An event landed on 2025-07-29, a date that appears nowhere in the message anyone
  actually sent — it was in the quoted attribution line."* Mention that pattern 1 spans newlines
  because the real body wrapped before `wrote:`.
- **`cleanEmail`'s fallback** — if cutting leaves nothing, keep the full text. *"A bare forward
  would otherwise clean to empty."*
- **`EXACT_DATE_PATTERN`** — day + month name is the minimum shape. *"A bare year or 'August
  2027' can never match, so it can never be mistaken for an exact date."*
- **`extractVenue`** — the priority order, the noise blacklist, the invalid-venue regex, and
  crucially the **return shape**: `{ value: null, isExplicit: true }`. *"That's not 'no venue' —
  it's 'the email spoke about venue and what it said isn't one'."*
- **`isResolvedCompany`** — a type guard (`company is string`).

---

# 9. Extraction — AI + merge + validation

| | |
|---|---|
| **Files** | `src/modules/extraction/extraction.service.ts`, `extraction.utils.ts` |
| **Functions** | `extract`, `extractWithAI`, `getOpenAIClient`, `validateAIDate`, `mergeExtraction`, `getExtractionStatus`, `detectEstimatedTime` |

**What to explain:**
1. `extract` — the `USE_AI` flag, and the try/catch that degrades to regex-only. *"The LLM is
   never a hard dependency."*
2. `NO_RETRY = new RetryPolicy({ maxAttempts: 1 })` — *"preserves the exact behaviour the
   service had before the AI Core existed."*
3. **`validateAIDate`** — the strongest function to show. *"The model turned 'in 2027' into
   2027-01-01. Shape validation can't catch that — it's a perfectly well-formed date. So the
   candidate has to be corroborated by a day+month mention in the source, it checks *every*
   mention rather than just the first, it runs `cleanEmail` first so a quoted date can't
   authorize it, and an unsupported date is **dropped, not replaced**, so it falls back to
   regex."*
4. `mergeExtraction` — field by field, and the `venueMeta` construction.

---

# 10. Confidence

| | |
|---|---|
| **File** | `src/modules/extraction/confidence.utils.ts` |
| **Functions** | `computeConfidence`, `scoreCompany`, `scoreDate`, `scoreTime`, `scoreStage`, `scoreVenue` |

**What to explain:**
- `WEIGHTS` — date 0.35, company 0.25, time 0.20, stage 0.10, venue 0.10, plus the 0.05
  completeness bonus.
- `scoreCompany` — the `"unknown" → 0` line, with its comment *"previously returned 1 because
  length > 2"*. *"The confidence system that existed to catch weak extractions was rating the
  weakest possible one as certain."*
- `scoreVenue` — three outcomes: inferred 0.5 (**neutral, not penalised**), explicitly invalid
  0.3, explicit real value 0.9.
- The penalties back in `extraction.service.ts`.

---

# 11. Identity gate

| | |
|---|---|
| **File** | `src/modules/matching/matching.utils.ts` |
| **Symbols** | `IdentityRelation`, `UNRESOLVED_ROUND`, `resolveRound`, `classifyRoundIdentity`, `passesIdentityGate` |

**Open this file when they ask about the resume's identity claim.** The header comment states
the whole argument.

**What to explain:**
- The three-valued type. *"A score can only express 'how much support'. Identity also has to be
  able to express 'this is a different thing', and a non-negative term in a weighted sum
  cannot."*
- `resolveRound` mapping the sentinel to `null`. *"So it never compares equal to itself — it
  marks 'not extracted', not a round any company runs."*
- `passesIdentityGate` — only CONTRADICTS vetoes. *"UNKNOWN stays eligible. Silence is not
  denial."*

---

# 12. Candidate matching

| | |
|---|---|
| **Files** | `src/modules/matching/matching.service.ts`, `src/modules/event/event.repository.ts` |
| **Functions** | `matchEventV2`, `scoreEventMatch`, `findByEventKey`, `findNearbyEvents`, `findByCompanyAndStage` |

**What to explain:**
1. Tier 1 → `generateEventKey` + `findByEventKey`, returns confidence 1.0, short-circuits.
2. Tier 2 → **the gate loop runs to completion before the ranking loop.** Point at the two
   separate `for` loops. *"That separation is the design. A vetoed candidate is never scored."*
   And: *"The candidate query deliberately doesn't filter on stage — the engine has to see the
   contradicting candidate in order to refuse it, and to say that it did."*
3. `scoreEventMatch` — the date bands, the `>3 days` early return, `min()` for confidence.
4. Tier 3 → `looseMatches.length === 1`, and `LOOSE_MATCH_WINDOW_DAYS` in
   `src/shared/constants/config.ts` — **read that constant's comment aloud**, it's the best
   explanation of the bound in the repo.
5. In `findByCompanyAndStage`: `windowDays` is a **required** parameter. *"So a caller can't
   reintroduce the unbounded query by omission."*

---

# 13. Event creation

| | |
|---|---|
| **Files** | `src/modules/event/event.service.ts`, `event.repository.ts`, `event.utils.ts` |
| **Functions** | `createEventService`, `createEvent`, `generateEventKey` |

**What to explain:**
- `generateEventKey` is four lines. *"That's the whole identity model — deliberately trivial and
  deterministic."*
- `createEvent` — `findFirst` scoped by owner, then create. *"The check is an optimisation; the
  unique constraint is the guarantee."*
- **Know this gap:** `isTimeEstimated` is not in the create payload, so `Event.isTimeEstimated`
  stays `false` even though the frontend renders "(estimated)" from it. Volunteer it if the
  frontend comes up.

---

# 14. Event update + guards + history + transaction

| | |
|---|---|
| **File** | `src/modules/event/event.service.ts` |
| **Functions** | `updateEventService`, `detectChanges`, `updateEventManuallyService`, `getEventsService`, `getEventByIdService` |

**The single most important file. Be able to narrate it line by line.**

1. **Guard 1** — `if (existing.status === "confirmed") return existing;` and read the comment.
   *"The guard is on status rather than the confidence comparison, because manual confirmation
   sets confidence to exactly 1.0 and so does a maximally confident extraction — the comparator
   literally can't tell them apart. Authority is a kind, not a quantity."*
2. **Guard 2** — `detectChanges`: IST key comparison for date, the `undefined && null` checks
   for time, the `isExplicit` branch for venue. *"A field the email didn't mention isn't in the
   changes list."*
3. **Guard 3** — `if (newConfidence < existingConfidence) return existing;` *"Strictly
   less-than, so equal confidence updates — only *worse* information is refused."*
4. **Guard 4** — building `updateData` from `changes.some(...)`. *"So there's no code path that
   writes an unmentioned field."*
5. **Reschedule** — `updateData.eventKey = generateEventKey({ company: existing.company, stage:
   existing.stage, date: incoming.date })`. *"Rebuilt from the *stored* identity attributes,
   because a reschedule changes when, not what."*
6. **The transaction** — N `eventUpdate.create` then `event.update`. *"One business action, one
   atomic unit. An event whose values moved with no record of why is a state the domain
   forbids."*
7. `getEventByIdService` — `findFirst` with a tenant predicate, not `findUnique`. Read the
   comment: *"a findUnique returns another user's event and leaves the caller to remember to
   check, which is the kind of check that's eventually forgotten."*

---

# 15. Multi-tenancy

| | |
|---|---|
| **Files** | `src/modules/auth/tenant-context.ts`, `auth.middleware.ts`, `src/modules/event/event.controller.ts` |
| **Symbols** | `TenantContext`, `OwnershipContext`, `requireTenantContext`, `requireAuth` |

**What to explain:**
- `TenantContext` vs `OwnershipContext` — same shape, different provenance. *"A TenantContext is
  what the caller claims via their session; an OwnershipContext is what a row records. They must
  be produced differently."*
- `requireTenantContext` **throws** rather than returning null. *"Reaching it without a user
  means a route was mounted without `requireAuth` — a wiring mistake. Returning null would let
  that degrade into an unscoped query."*
- `getEventByIdController` — 404 for both cases. *"A 403 would confirm the record exists, and
  ids are sequential."*

---

# 16. Attachment processing

| | |
|---|---|
| **Files** | `src/modules/attachment/document-processing.service.ts`, `attachment.worker.ts`, `attachment.queue.ts`, `attachment.repository.ts`, `attachment.service.ts` |
| **Functions** | `DocumentProcessingService.process`, `downloadAttachment`, `selectParser`, `parseAndPersist`, `enqueueAttachmentProcessing`, `getAttachmentById` |

**What to explain:**
1. `enqueueAttachmentProcessing` — `jobId: attachment-${id}`. *"Deterministic, so a retried
   upstream job can't queue it twice."*
2. `process()` — the early return for already-completed, then owner derivation from the row.
3. **The failure asymmetry**, which is the point of this file:
   - download fails → `markAttachmentFailed` **and rethrow** (retryable)
   - no messageId / no account → `markAttachmentFailed`, **return without throwing** (not
     retryable — don't burn retries on something a retry can't fix)
   - parse fails → `markParsingFailed`, status stays `completed`, **not rethrown**
4. `markAttachmentCompleted` is called **before** parsing. *"So a parse failure can never flip a
   successful download back to failed."*
5. `buildStorageKey` — `randomUUID() + ext`. *"Opaque, so no user-controlled data reaches the
   filesystem path, and no collisions."*

---

# 17. Parser registry

| | |
|---|---|
| **Files** | `src/modules/attachment/parsers/parser-registry.ts`, `attachment-parser.interface.ts`, `pdf.parser.ts`, `spreadsheet.parser.ts`, `../storage/storage.interface.ts`, `../storage/local-storage.service.ts` |

**What to explain:**
- The interface: `supports(mimeType)` + `parse(filePath)`.
- *"`DocumentProcessingService` contains zero MIME-type conditionals. Adding DOCX is one class
  and one line in the registry array."*
- `LocalStorageService.resolve` — the path-traversal guard.
- *"The `StorageService` interface exists so S3 is a one-line swap. On Render the local disk is
  ephemeral, so files don't survive a redeploy — a known limitation."*

---

# 18. AI Core

| | |
|---|---|
| **Files** | `src/modules/ai/structured-completion.ts`, `ai-provider.interface.ts`, `openai-provider.ts`, `json-response-parser.ts`, `retry-policy.ts`, `ai-errors.ts`, `model-config.ts`, `index.ts` |

**What to explain:**
- `structuredCompletion<T>` — the five-step cycle, and that every collaborator is injectable
  (that's how a test supplies a fake provider).
- `OpenAIProvider.isRetryable` — no status → retry (network); 408/429/5xx → retry;
  400/401/403/404/422 → don't.
- The error hierarchy. *"So callers catch a type instead of matching on error message
  strings."*
- **Be honest:** `extraction.service` and `document-classifier` use the Core;
  `event-extractor` and `participant-extractor` still call OpenAI directly. *"A partially
  completed refactor."*
- The discipline: *"Introduced without changing any behaviour — the migrated callers pass
  `maxAttempts: 1` to reproduce their previous single-attempt behaviour exactly. An abstraction
  that changes behaviour while it's being introduced can't be verified."*

---

# 19. Tests

| | |
|---|---|
| **Files** | `src/modules/matching/__tests__/matching.service.test.ts`, `src/modules/attachment/__tests__/attachment.repository.test.ts`, `src/modules/event/__tests__/event.service.test.ts`, `src/lib/__mocks__/prisma.ts`, `jest.config.cjs` |

**Open `matching.service.test.ts` if they ask about testing.**

1. The `requireActual` wrap of `scoreEventMatch` — read the comment. *"The gate's contract is
   that a contradicted candidate is never scored at all, and that's only provable by asserting
   on what the scorer was never asked to evaluate. An assertion on the outcome alone can't
   distinguish 'correctly vetoed' from 'scored and happened to lose'."*
2. `scoredCandidateIds()` — the helper that makes control flow observable.
3. The D-1 sweep — 4 date deltas × 5 confidences. *"A regression test for a threshold bug has to
   cover the space, not a point."*
4. In `attachment.repository.test.ts` — the in-memory table. *"An unscoped `update WHERE id` is
   indistinguishable from a scoped `updateMany WHERE id, userId` if you only inspect call
   arguments. Applying the WHERE predicate for real is what makes 'the other tenant's row didn't
   change' an observation instead of an assumption."*
5. In `event.service.test.ts` — `"writes no history when an automated update is refused"`
   asserts **zero** `eventUpdate.create` calls. *"That proves the guard runs before the write."*
6. `jest.config.cjs` — every setting has a comment explaining why.

---

# 20. Prisma schema

| | |
|---|---|
| **Files** | `prisma/schema.prisma`, `prisma.config.ts`, `prisma/migrations/20260802030000_require_ownership/migration.sql` |

**What to explain:**
- The schema is heavily commented — the `User` and `Event` comments state the identity model.
- `@@unique([userId, eventKey])` — and that it was global before.
- The composite FK on `EventUpdate`: `references: [id, userId]`.
- The `Attachment.userId` comment: *"a plain column with no relation to User — a direct User
  relation would add a second, weaker path to the same fact."*
- `prisma.config.ts` — the pooled/direct split and the advisory-lock reason.
- The `require_ownership` migration header — expand/backfill/contract, and the shadow-database
  constraint on the backfill.

---

# Frontend (client/)

| | |
|---|---|
| **Files** | `client/src/pages/Dashboard.tsx`, `client/src/lib/eventDisplay.ts`, `client/src/api/eventApi.ts`, `client/src/types/event.ts`, `client/vercel.json` |

Only if asked. The one detail worth showing: `formatDateTime` formats with an explicit
`timeZone: "UTC"`. *"The date column is a calendar date stored as UTC midnight. Reading it in
the viewer's zone rolls the day backwards for anyone west of UTC and makes midnight look like a
real clock time — 05:30 in IST. And the time is parsed as text, never through a Date, so no
timezone conversion can reach it."*

And `vercel.json`'s `/api` rewrite — *"that exists because the origin terminating the OAuth
callback owns the session cookie."*

---

# If they say "show me the most interesting file"

**`src/modules/matching/matching.utils.ts`.** It's short, the header comment states the entire
design argument, and it's the thing your resume's strongest bullet is about.

Second choice: **`src/modules/event/event.service.ts`** — five guards in order, each one a bug
you fixed.
