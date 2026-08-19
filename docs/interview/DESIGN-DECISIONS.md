# Design Decisions

Ten decisions, all provable from the source. Format:
**Problem → Naive approach → Why it failed → Decision → Why it works → Trade-off → What I'd
improve next.**

---

## 1. Identity before similarity

**Problem.** Decide whether a new email describes a round the system already knows.

**Naive approach.** One weighted similarity score decides both *whether* any candidate is the
same event and *which* candidate it is:
```
score = 0.5·dateProximity + 0.3·roundAgreement + 0.2·confidenceAlignment,  accept ≥ 0.5
```

**Why it failed.** The date term alone is `0.5 × 1.0 = 0.5` — exactly the threshold. So same
company, same date, **different round** was accepted: a morning PPT and an afternoon OA merged
into one record.

And raising the threshold doesn't fix it. The function is a sum of non-negative terms, so it's
monotone in each — the date term is a *lower bound* and nothing can pull the total beneath it.
A mismatched round contributed `0`, which means *"no support"*, not *"evidence against"*.
**A weighted sum of corroboration cannot encode a veto.** The engine was structurally incapable
of disagreeing with itself.

**Decision.** Two phases with strictly separated authority:
1. **Admission (categorical)** — `classifyRoundIdentity` returns `AGREES | UNKNOWN |
   CONTRADICTS`. A contradiction vetoes the candidate. Runs to completion first.
2. **Ranking (continuous)** — `scoreEventMatch` orders the survivors. No authority to admit.

`UNKNOWN` deliberately stays eligible — silence is not denial. And the `"unknown"` sentinel maps
to `null`, so it never compares equal to itself.

**Why it works.** Identity is categorical — it holds or it doesn't — so it needs a categorical
representation. Forcing it through a continuum means the contradiction must be encoded as a
small number, and small numbers get outvoted. It also changes *how the system fails*: a scoring
threshold fails toward the merge because every term pushes the total up; a constraint fails
toward the duplicate because a candidate that doesn't qualify is simply absent.

**Trade-off.** Stricter admission means more duplicates. A round whose stage was
mis-extracted as a different round now creates a second event instead of updating the right one.
That's the trade I want: a duplicate is visible and one delete away; a false merge is invisible
and destroys the information needed to undo it.

**What I'd improve next.** The gate only examines round. Venue could contribute — a physical
room versus an online platform on the same day is decent evidence of two different activities —
but only as another categorical attribute, never as a score.

`matching.utils.ts`, `matching.service.ts`, `docs/06_ADR/ADR-006_Identity_Precedes_Similarity.md`

---

## 2. Confidence-aware updates

**Problem.** Two emails describe the same round with different quality of information.

**Naive approach.** Last write wins.

**Why it failed.** Every write here is an *inference*, and inferences vary in quality. A date
read from "16th August 2026" and one read from "sometime next week" are not equally good.
Concretely: a vague "evening" overwrote an exact "17:00". And because emails arrive out of
order, "last" is arbitrary anyway.

**Decision.** A 0–1 confidence score per extraction, derived from **how** each field was
obtained — not what it says. Then three uses:
- `confidence < 0.6` → touch nothing existing; create a `review` event
- `newConfidence < existingConfidence` → skip the update entirely
- 20% of the match-ranking score, as `min(incoming, existing)`

**Why it works.** It replaces a temporal ordering with a quality ordering — and that buys
**order-independence for free**. A weak late arrival is rejected on its merits, not because of
when it arrived, so the final state doesn't depend on job scheduling.

**Trade-off.** Confidence is a hand-tuned heuristic, not a calibrated probability. `0.6` is a
judgement. And a *correct* low-confidence update is rejected, so the event goes stale — visible,
and a human can fix it, which sets confidence to 1.0 and locks it.

**What I'd improve next.** Log every decision with its confidence and the human's eventual
correction, then fit the threshold to that instead of guessing. Also: confidence doesn't
currently distinguish an AI-sourced field from a regex-sourced one — it grades the value's
provenance in the text, not which extractor produced it. That's a reasonable extra signal.

`extraction/confidence.utils.ts`, `event/event.service.ts`, `shared/constants/config.ts`

---

## 3. Field-level history, written atomically

**Problem.** An event's values change over time and you need to know why.

**Naive approach.** Overwrite the row; rely on `updatedAt`.

**Why it failed.** `updatedAt` tells you *when*, never *what* or *from what*. You can't answer
"when did this get rescheduled and from which date?" or "was the venue cleared, or never set?"
— and both were questions I needed while debugging a wrong merge.

**Decision.** One `EventUpdate` row per changed field (`field / oldValue / newValue /
updatedAt`), written inside the **same** `prisma.$transaction` as the event update.

**Why it works.** The audit row isn't logging — it's part of the state change. An event whose
values moved with no matching record is a state the domain doesn't permit, so the database
shouldn't be able to hold it. It's also testable: the manual-authority tests assert that a
*refused* update writes **zero** audit rows, which proves the guard runs before the write.

**Trade-off.** Write amplification — an email changing three fields writes four rows. And
`oldValue`/`newValue` are stringified, so `null` becomes the literal `"null"`; querying history
semantically means parsing strings.

**What I'd improve next.** There's no foreign key from `EventUpdate` back to the `Email` that
caused it — the link is behavioural, not relational. An `event_emails` join table recording the
event, the email, the match type and the score would give real provenance, and would let the UI
show *"this changed because of this email."*

`event/event.service.ts`, `prisma/schema.prisma` → `EventUpdate`

---

## 4. Idempotency by construction

**Problem.** BullMQ is at-least-once. A worker can crash after doing the work and before
acknowledging, and the job gets redelivered.

**Naive approach.** A `processed` boolean set at the end, or a dedupe table keyed by job id.

**Why it failed.** Both add state that can itself be wrong, and neither helps in the exact case
that matters — a crash *after* writing but *before* setting the flag.

**Decision.** No dedupe table. Make the operation idempotent instead:
- extraction is a pure function of the email body
- matching finds the same event by exact `eventKey`
- `detectChanges` returns `[]` when nothing differs → early return, no write, no audit row

**Why it works.** Idempotency is a **property of the operation**, not a flag someone has to
remember to set — so there's nothing that can drift out of sync with reality. And it composes:
the same property that makes a retry safe also makes reprocessing an email for debugging safe.

**Trade-off.** `createExtraction` is deliberately *not* idempotent — a re-run appends a second
row. That's correct: it's an append-only log of "the extractor ran and produced this", and a
second run genuinely is a second event worth recording. It does mean extraction rows outnumber
emails.

**What I'd improve next.** Nothing about the mechanism. What's missing is a **sweeper** for
emails stuck at `pending` when Redis was down at enqueue time. `getPendingEmails` and
`getFailedEmails` already exist, tenant-scoped, and nothing calls them.

**Never say "exactly-once".** The correct phrasing: *"the system is designed to tolerate
duplicate processing rather than to prevent it."*

`event/event.service.ts` → `detectChanges`, `workers/email.worker.ts`

---

## 5. Incremental Gmail sync with a watermark-first cursor

**Problem.** Read new mail every two minutes without re-listing the mailbox.

**Naive approach.** List the last N messages each run and skip the ones already stored.

**Why it failed.** Wasteful and quota-hungry, and it scales with mailbox size rather than with
what actually changed.

**Decision.** Store Gmail's `historyId` per mailbox as a cursor. No cursor → full sync;
otherwise `history.list` from the cursor, paginated. A 404 means the cursor expired → automatic
full-sync fallback. And on a full sync, **capture the watermark before listing.**

**Why it works.** Each run is proportional to the delta. The watermark ordering is the subtle
part: capturing it *after* listing means a message arriving mid-run gets a history id below the
new cursor and is never seen again. Capturing first means it's re-fetched next run — free,
because the unique constraint catches it.

> **Overlap is safe; gaps are not.**

**Trade-off.** Polling costs a request every two minutes even when nothing changed. And full
sync uses `maxResults: 100` **without pagination**, so a brand-new mailbox bootstraps from its
most recent 100 messages rather than its whole history.

**What I'd improve next.** Gmail push notifications via `users.watch` and Pub/Sub. The sync
logic wouldn't change — only what triggers it. And paginate the full sync.

`gmail/gmail.sync.service.ts`, `gmail/gmail.service.ts`

---

## 6. Async processing with a durable queue

**Problem.** Extraction, an LLM call, matching and a database write per email — and Gmail sync
produces up to 100 emails at once.

**Naive approach.** Do it synchronously inside `POST /email`.

**Why it failed.** It *was* synchronous originally. A failure lost the email entirely — there
was nowhere to retry from. And an LLM call takes seconds, so the request held a connection open
for the whole pipeline.

**Decision.** Persist the Email row first, enqueue `{ emailId, userId }`, return **202
Accepted**. A separate worker process runs the pipeline, with 3 attempts and exponential backoff.

**Why it works.** The email is durable *before* anything risky starts, so a crash loses work,
never data — the row is still there with its processing status. And failures are isolated: one
poisonous email fails its own job while the other 99 proceed.

**Trade-off.** More moving parts — Redis becomes a hard dependency for ingestion, and there's
now an operational gap between "the email exists" and "the event exists" that the UI doesn't
surface. Also: if Redis is down at enqueue time, the email sits at `pending` and nothing picks
it up.

**What I'd improve next.** The sweeper from #4. And surfacing `processingStatus` in the UI, so
a user can see an email was received but not yet interpreted.

`email/email.producer.ts`, `workers/email.worker.ts`

---

## 7. Ownership derived from the database, never from the channel

**Problem.** A worker has no HTTP request. How does it know whose data it's touching?

**Naive approach.** Put `userId` in the job payload and use it.

**Why it failed.** **A queue is not an authenticated channel.** Anything that can reach Redis
can enqueue a job. A `userId` in a payload is a *claim*, and it would sit alongside the
authoritative answer already in the database — a second, weaker source of truth.

**Decision.** Two deliberately unscoped functions — `getEmailById` and `getAttachmentById` —
are the documented **ownership derivation roots**. The worker reads the row and takes `userId`
off it. The email payload still carries `userId`, but **only so a disagreement is detectable**;
a mismatch throws `UnrecoverableError` (no retry — no retry fixes a forged payload). The
attachment payload carries nothing but the id, and there's a test asserting that.

**Why it works.** One derivation, one place, one answer per job. And it's safe despite being
unscoped, because neither root is reachable from a request — their only callers are workers
keyed by an id the system enqueued itself.

**Trade-off.** An extra database read at the start of every job. Negligible, and it's the read
that makes the guarantee.

**What I'd improve next.** Nothing here. It composes with the composite foreign keys — even if
this layer were wrong, Postgres would reject a cross-tenant child row.

`email/email.repository.ts`, `attachment/attachment.repository.ts`, `workers/email.worker.ts`

---

## 8. Multi-tenancy enforced in the schema, not just the code

**Problem.** Once there's more than one user, every query is a potential leak.

**Naive approach.** Check ownership in the controller.

**Why it failed.** It's a check you have to remember, in every handler, forever. The one you
forget is the bug — and it's invisible until it isn't.

**Decision.** Three reinforcing layers:
1. **Type** — `TenantContext` threaded as a *required* parameter, never ambient. *"A service
   that takes one cannot be called without it, while one that reaches for ambient state
   compiles and runs identically whether or not the state was set."*
2. **Query shape** — `findFirst({ where: { id, userId } })` instead of `findUnique`;
   `updateMany` instead of `update`, so a refused write returns `count: 0` and is **observable**.
3. **Database** — composite foreign keys `(parentId, userId) → Parent(id, userId)`, plus
   `@@unique([userId, eventKey])`.

**Why it works.** Layer 3 is the one that matters. A child row whose owner disagrees with its
parent's is **unrepresentable**, not merely incorrect — Postgres rejects the insert regardless
of what the application does. There's even a nice side effect: `Attachment.userId` is no longer
written by application code at all, because Prisma fills it from the parent. *The constraint
deleted the code that could violate it.*

**Trade-off.** `updateMany` instead of `update` everywhere is less ergonomic, and the composite
indexes cost write throughput. Also `@@unique([userId, eventKey])` was a breaking migration —
the constraint used to be global, which was itself a bug, because two students on the same
mailing list produce the same key.

**What I'd improve next.** `Email.gmailMessageId` is still **globally** unique rather than
per-account. Re-scoping it to `(gmailAccountId, gmailMessageId)` requires that column to be
reliably populated, and rows predating account tracking have NULL.

`auth/tenant-context.ts`, `prisma/schema.prisma`, `prisma/migrations/20260802030000_require_ownership/`

---

## 9. Hybrid extraction — regex floor, LLM ceiling

**Problem.** Pull five structured fields out of unstructured email prose.

**Naive approach.** Either pure regex, or pure LLM.

**Why it failed.** Regex alone misses every phrasing you didn't anticipate. LLM alone fails
*differently and worse*: a regex that doesn't match returns `null`, which is honest; an LLM that
doesn't know returns a confident-looking wrong answer. It turned "in 2027" into `2027-01-01` by
inventing the missing day and month — syntactically perfect, semantically fabricated.

**Decision.** Run both, merge **field by field** with the LLM preferred per field and regex
filling the gaps. Gate the LLM behind `USE_AI` (default **false**). And validate its most
dangerous output deterministically: `validateAIDate` keeps a candidate date only if a
day+month mention in the source (after quote-stripping) corroborates it. An unsupported date is
**dropped, not replaced**, so it falls back to regex like any other missing field.

**Why it works.** The regex layer is a floor the system can always stand on — it runs with no
API key, which is also why the entire test suite needs none. And the validator makes the AI
*strictly safer than regex-only*, because it can only ever **remove** an AI date, never add a
wrong one.

**Trade-off.** Two extraction paths to maintain, and merge semantics to reason about. Company
matching is exact and case-sensitive downstream, which works because everything is lowercased —
but "Amazon" versus "Amazon India" still misses.

**What I'd improve next.** Extend evidence-validation beyond dates — a company name the model
returns should also appear in the source. And call the model only when the regex layer left a
required field empty, which would cut cost and latency.

`extraction/extraction.service.ts`, `extraction/extraction.utils.ts`, `email/email.parser.ts`

---

## 10. The AI Core abstraction

**Problem.** Four AI-powered services each independently built an OpenAI request, stripped
markdown fences, `JSON.parse`d, handled empty responses, handled malformed JSON, handled
provider errors, and decided what to retry.

**Naive approach.** Keep copying it. It's only ~20 lines each.

**Why it failed.** By the fourth copy, any fix has to be made in four places and the fifth
feature copies it again. It's not four small duplications — it's one **cross-cutting concern
that hadn't been named**.

**Decision.** `src/modules/ai/`: an `AIProvider` interface with an `OpenAIProvider`
implementation, a `JsonResponseParser`, a `RetryPolicy` (transient-only, linear backoff), a
typed error hierarchy (`AIError` → `EmptyResponseError` / `MalformedResponseError` /
`ProviderError(retryable)`), a `ModelConfig`, and one entry point: `structuredCompletion<T>()`.

**Why it works.** Each AI feature becomes only its business logic — a prompt and a
normalisation function. And the discipline matters as much as the design: **it was introduced
without changing any behaviour.** The two migrated callers pass `new RetryPolicy({ maxAttempts:
1 })`, reproducing their previous single-attempt behaviour exactly. An abstraction that changes
behaviour while it's being introduced can't be verified — you can't tell a refactoring bug from
an intended improvement.

**Trade-off.** `structuredCompletion<T>` asserts the response *is* JSON, not that it matches
`T`. Every caller still normalises the result itself. That's deliberate — the Core owns
transport and shape, the caller owns meaning — but it does mean the generic is weaker than it
looks.

**What I'd improve next.** Two things. **Finish the migration** — `event-extractor` and
`participant-extractor` still call OpenAI directly; that's a visible partially-completed
refactor and I'd rather own it than hide it. And add runtime schema validation (Zod) at the
parser seam, which would make `T` a real guarantee rather than an assertion.

`src/modules/ai/`

---

# The five one-liners

| Decision | The line to say |
|---|---|
| Identity before similarity | *"A weighted sum of non-negative terms cannot encode a veto."* |
| Confidence-aware updates | *"Highest trust wins, not last write — which buys order-independence for free."* |
| Idempotency | *"At-least-once delivery, so the operation is idempotent by construction rather than by a flag."* |
| Incremental sync | *"Overlap is safe; gaps are not."* |
| Multi-tenancy | *"The constraint didn't just validate the invariant — it deleted the code that could violate it."* |
