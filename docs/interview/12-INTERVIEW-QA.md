# 12 — Interview Q&A

Answers written the way you'd actually speak them. Read them out loud once.

---

## Project Basics

**Q: What does your project do?**
> It reads a student's placement emails from Gmail and keeps one up-to-date list of their
> tests and interviews. During placement season one round gets described across four or five
> emails — announced, moved, venue added later — and students track that by hand across
> fifteen or twenty companies. The system does the merging.

**Q: Why isn't this just an email parser?**
> Because parsing isn't the hard part. The hard part is that no single email contains the
> truth. One email says "Amazon OA on 20th August", another says "moved to the 25th", a third
> says "venue: TPO". So the durable thing in the system is the real-world round, and each
> email is *evidence about it*. That changes every design decision — I need to decide whether
> a new email is about a round I already have, and whether it's trustworthy enough to
> overwrite what I stored.

**Q: Why couldn't you just use CRUD?**
> Because CRUD has one write behaviour: last write wins. That's correct when a human typed
> the value. Here every write is an inference, and inferences vary in quality — a date read
> from "16th August 2026" and one read from "sometime next week" aren't equally good. And
> emails arrive out of order, so "last" is arbitrary. The two concrete failures were partial
> emails wiping fields they never mentioned, and vague data overwriting exact data.

**Q: Who uses it?**
> It's a personal project — I built it because I had the problem. It's deployed and it works
> on my own mailbox. It's multi-user by design, but I'm not going to claim it has users.

**Q: What are you most proud of?**
> The identity gate. I found a bug where a morning PPT and an afternoon test on the same day
> got merged into one event, and the interesting part was realising it wasn't a tuning
> problem. The matcher used a weighted sum, and a weighted sum of non-negative terms can
> express "no support" but never "evidence against" — so a contradicted round contributed
> zero and the date term alone already met the threshold. Fixing it meant changing the
> representation, not the constants.

---

## Architecture

**Q: Walk me through the architecture.**
> Three processes. An Express API that also runs the Gmail sync scheduler, and two BullMQ
> workers — one for emails, one for attachments. Postgres through Prisma, Redis for both the
> queues and the sessions.
>
> The flow is: the scheduler pulls new mail from Gmail, saves the raw Email row with its
> attachment metadata, and enqueues a job. The email worker picks it up, cleans the body,
> extracts five fields with regex plus an optional LLM, scores confidence, checks whether the
> observation is even viable, matches it against existing events, and then decides — create,
> update, or park for review. If that all succeeds it fans out attachment jobs to the second
> queue.

**Q: Why a queue instead of doing it in the request?**
> Four reasons. The LLM call takes seconds, so nothing should hold an HTTP connection open.
> A sync run produces up to a hundred emails at once, and the queue flattens that. Failures
> get retried with backoff for free. And most importantly, the email is persisted *before*
> any processing starts — so a crash loses a job, never an email.

*Follow-up: what if the worker crashes mid-job?*
> BullMQ marks it stalled and re-delivers it. The re-run recomputes everything from the raw
> body, finds the same event by its identity key, and `detectChanges` returns an empty list —
> so it writes nothing. The pipeline is idempotent by construction rather than by a dedupe
> table, which means there's no flag that can drift out of sync with reality.

*Follow-up: what if Redis goes down?*
> Sessions fail, so nobody can authenticate — the server actually refuses to start if it
> can't connect to the session store, because a process that starts without one answers
> every sign-in with an opaque 500. For the queues: an enqueue throws, so the Email row stays
> at `pending` and no job exists. That's a real gap — I have `getPendingEmails` in the
> repository but nothing calls it. The fix is a sweeper job.

**Q: Why a monolith and not microservices?**
> The pipeline stages are tightly coupled by data and always run together for one email.
> Splitting them into services would add network hops and distributed failure for no benefit
> at this scale. What it *does* need is *process* separation — API versus workers — so a slow
> external call can't block HTTP. And it has that.

**Q: How would you scale this to a hundred thousand users?**
> Three things break first. The Gmail scheduler is in-process and does a global "all
> accounts" query — that becomes a repeatable BullMQ job partitioned across workers, and I'd
> move to Gmail push notifications via Pub/Sub instead of polling. The matcher's candidate
> queries need `(userId, company, date)` as a composite index. And attachment storage moves
> from local disk to S3, which the `StorageService` interface already allows as a one-line
> swap. The workers themselves scale horizontally as-is — they're stateless and BullMQ
> handles distribution.

---

## Database

**Q: Walk me through your schema.**
> Seven models. `User` is the tenant root. `GmailAccount` is a connected mailbox with its
> refresh token and sync cursor. `Email` is the raw message plus its processing status.
> `EmailExtraction` is what the extractor read out of one email, with its confidence.
> `Event` is the real-world round — the only genuinely mutable row. `EventUpdate` is an
> append-only audit row per accepted field change. `Attachment` is file metadata plus
> download and parse state.

**Q: Why separate `Email`, `EmailExtraction` and `Event`?**
> They're three different facts with three different failure modes. `Email` is what arrived —
> immutable, so I can always reprocess. `EmailExtraction` is what was *read* — so when an
> event looks wrong I can tell an extraction bug from a decision bug. `Event` is what's
> *believed*. Collapsing them would mean losing the ability to answer "did we misread it, or
> did we misjudge it?"

**Q: Why is `eventKey` unique per user and not globally?**
> It was global at first, and that was a bug I only found when I added multi-user support.
> Two students on the same TPO mailing list receive the same broadcast, so their extractions
> produce the *same* key — `amazon|OA|2026-08-20`. Under a global constraint the second
> student's create silently resolved to the first student's event. Per-owner uniqueness is
> what makes multi-tenancy actually work.

**Q: Tell me about the composite foreign keys.**
> Every child that has a tenant-scoped parent points at `(parentId, userId)` together, not
> just `parentId`. So `Attachment(emailId, userId)` references `Email(id, userId)`. The
> effect is that a child row whose owner disagrees with its parent's owner is
> **unrepresentable** — Postgres rejects the insert. That's a stronger guarantee than "the
> service layer remembers to check."
>
> There's a nice side effect: in `createEmail` I don't write `Attachment.userId` at all,
> because both columns are relation scalars now, so Prisma fills them from the parent it just
> inserted. The constraint didn't just validate the invariant, it deleted the code that could
> violate it.

**Q: How do you handle timezones?**
> The date column is a calendar date stored as UTC midnight — it carries no clock time; the
> real time is a separate `"HH:MM"` string. But comparison happens on **IST calendar keys**,
> because the users are in India and "20 August" means 20 August in IST. So `detectChanges`
> converts both sides with `toISTKey` before comparing. And the frontend formats the date
> with an explicit `timeZone: "UTC"`, because reading UTC midnight in the viewer's zone rolls
> the day backwards for anyone west of UTC.
>
> Short version: store UTC, compare in IST, render in UTC, and never let a clock time into
> the date column.

**Q: How did you add multi-tenancy to an existing schema?**
> Expand, backfill, contract. First migration adds `userId` as **nullable** everywhere, so old
> and new code both work. Second migration is data only, no DDL, filling every `userId` — rows
> derivable from a parent follow their parent exactly, and root rows get a clearly-marked
> legacy owner. Third migration makes it `NOT NULL`, adds the composite anchors and foreign
> keys, and swaps the global `eventKey` unique for the per-user one.
>
> One constraint shaped it: Prisma replays the whole chain against an empty shadow database
> to detect drift, so a data migration that *requires* data can't survive that replay.
> "Nothing to backfill" had to be success, not an error.

---

## Backend

**Q: How is the code organised?**
> Feature modules, not layer folders. Each module has its controller, service, repository and
> types together — `gmail`, `email`, `extraction`, `matching`, `event`, `attachment`, `ai`,
> `auth`. So a change to matching touches one directory.

**Q: What's the difference between your service and repository layers?**
> The repository does database operations and nothing else. The service holds business logic
> and makes decisions. It matters practically: the interesting logic — "when do I refuse this
> update?" — is all in the service, so that's what the tests target, and the repositories are
> mocked.

**Q: What's your one write point?**
> `event.service`. Everything upstream — extraction, confidence, matching — produces a
> *proposal*. Matching returns a verdict; it never mutates anything. That means I can answer
> "can this path corrupt data?" by reading one file.

**Q: You return 202 from `POST /email`. Why?**
> Because the email is accepted but not yet processed. 201 would claim a resource was
> created, and no Event exists yet — it might never exist, if the viability gate abandons the
> observation.

---

## AI / LLM

**Q: Where do you use an LLM?**
> One place in the live pipeline: extracting company, stage, date, time and venue from an
> email body. It's `gpt-4o-mini` at temperature 0, and it's **off by default** — `USE_AI=false`.
> There's also a document-intelligence layer that classifies attachments and extracts from
> them, but I should be clear: that's built and tested and **not wired into the pipeline yet**.

**Q: Why hybrid regex plus LLM instead of just the LLM?**
> The failure modes are different in a way that matters. A regex that doesn't match gives you
> `null`, which is honest. An LLM that doesn't know gives you a confident-looking wrong
> answer. So regex is the floor the system can always stand on, and the LLM is the ceiling
> that handles phrasings I never anticipated. They merge field by field — the LLM wins on any
> field where it produced something, regex fills every gap.
>
> It also means the whole system runs with no API key, which is why the test suite needs one
> neither.

**Q: How do you stop the model from hallucinating?**
> For dates — the field that matters most — there's a deterministic guard. The model returned
> `2027-01-01` for an email that only said "in 2027"; it invented the day and month to satisfy
> the output format. Validating the *shape* catches nothing, because `2027-01-01` is a
> perfectly well-formed date.
>
> So `validateAIDate` extracts every day-plus-month mention from the source text and keeps
> the model's candidate only if one of them corroborates it. If not, the date is **dropped**,
> not replaced — so it falls back to the regex date like any other missing field. A prompt is
> a request; a check is a guarantee. And the check makes the AI strictly safer than
> regex-only, because it can only ever remove an AI date, never add a wrong one.

*Follow-up: why not just use structured outputs / JSON schema mode?*
> That would guarantee the *shape*, which was never the problem — the model already returned
> valid JSON with a valid date string. The problem was that the content was fabricated. A
> schema can't express "this date must appear in the input text."

**Q: What if OpenAI is down?**
> Nothing user-visible. The call is wrapped in a try/catch in `extract()`; a failure logs and
> leaves the AI result null, and the pipeline runs on regex output. Confidence will typically
> be lower because fewer fields resolved, which may route the email to review — which is
> exactly the right degradation.

**Q: Tell me about the AI Core.**
> Four services were each independently building an OpenAI request, stripping markdown fences,
> parsing JSON, and deciding what to retry. The business logic differed; the plumbing was
> identical. So I factored it into `structuredCompletion<T>()` sitting on a provider interface,
> a JSON parser, a retry policy and a typed error hierarchy.
>
> The part I'd emphasise is that it was introduced **without changing any behaviour**. The two
> migrated callers pass a retry policy of `maxAttempts: 1`, which reproduces their previous
> single-attempt behaviour exactly. An abstraction that changes behaviour while it's being
> introduced can't be verified — you can't tell a refactoring bug from an intended improvement.
>
> And honestly, only two of the four are migrated. The other two still call OpenAI directly.

**Q: How do you decide what to retry?**
> Transient things only: malformed JSON, an empty response, and provider errors flagged
> retryable — which means a network error with no status, or 408, 429, or any 5xx. A 400 or
> 401 isn't retried, because an identical request won't fix a bad request or an auth failure.

---

## Matching

**Q: How do you decide two emails describe the same event?**
> Three tiers of decreasing evidential strength, stopping at the first sufficient answer.
> First, an exact identity key — company, round, date, joined into a string. If that hits,
> all three identity attributes agree and there's nothing to judge. Second, same company
> within ±3 days, with the candidates ranked by a similarity score. Third, same company *and*
> same round within 30 days, but **only if exactly one candidate exists** — because at that
> point the identity claim rests entirely on uniqueness.
>
> If all three miss, I create a new event. A duplicate is the failure I chose.

**Q: Why is a contradicting round a veto instead of a low score?**
> Because a weighted sum of non-negative terms is monotone — every term can only push the
> total up, so no term can veto. A mismatched round contributed zero, and zero in that
> function means "no support", not "evidence against". The date term alone was worth exactly
> the acceptance threshold, so same company plus same date with a *different* round was
> accepted.
>
> That's a representational problem, not a tuning problem. Identity is categorical — it holds
> or it doesn't — so it needs a categorical representation. Now admission returns one of
> AGREES, UNKNOWN or CONTRADICTS, and a contradiction removes the candidate before scoring
> ever runs. Similarity ranks the survivors and has no authority to admit anyone.

*Follow-up: why is UNKNOWN not a contradiction?*
> Because an email that didn't state a round has said nothing about identity. Reading silence
> as disagreement is the same mistake in the opposite direction — and it's the same rule as
> the venue handling: silence is not denial.

*Follow-up: what if both sides say "unknown"?*
> That's UNKNOWN, not AGREES. The literal string `"unknown"` is a sentinel meaning "not
> extracted" — it's not a round any company runs, so it must never compare equal to itself.
> `resolveRound` maps it to null before comparison.

**Q: Why 30 days for the loose tier?**
> That tier infers identity purely from uniqueness, and uniqueness is only meaningful inside a
> plausible range. Over unbounded time, "this company's first OA" is trivially unique — so the
> tier fired *most* confidently exactly where it had the *least* evidence, and merged rounds
> months apart into a single "reschedule". 30 days is wider than the soft tier's ±3 days, so
> it still catches real reschedules that moved a long way, but narrow enough to exclude
> cross-cycle collisions.

**Q: What if you match the wrong event?**
> That's the failure I care most about, and it's why the system is shaped the way it is. A
> **duplicate** is visible, embarrassing, and one delete away from fixed. A **false merge** is
> invisible, entirely plausible-looking, and destroys the information you'd need to undo it —
> there's no record the second round ever existed. So every threshold and every refusal fails
> toward the duplicate, and I tried to make that structural rather than arithmetic: bounded
> windows, a uniqueness requirement at the weakest tier, and a categorical veto. A threshold
> is a number a future retune quietly removes. A constraint isn't.

**Q: Would embeddings work better?**
> They'd help with the case I currently can't handle — "the meeting has been rescheduled" with
> no company name. But they'd have made the false-merge problem *worse*, not better, because
> semantic similarity is exactly the kind of continuous signal that can't express a veto. If I
> added them, they'd generate candidates and feed the ranking phase — they would not be
> allowed to admit anyone past the identity gate.

---

## Reliability

**Q: How do you prevent a low-quality email from corrupting data?**
> Four guards, in order. If the event is `confirmed` by a human, no automated update touches
> it at all. If the extraction's confidence is below the threshold, nothing existing is
> touched — a review event is created instead. If the new confidence is lower than the stored
> confidence, the update is skipped. And only fields that actually changed go into the update
> payload, so a field the email never mentioned can't be blanked.

**Q: Why is manual confirmation a status check and not a confidence check?**
> Because manual confirmation sets confidence to exactly 1.0 — and so does a maximally
> confident extraction. The numeric comparator literally can't tell "a person settled this"
> from "the extractor was very sure." Tightening it to `<=` would express the intent as a
> numeric coincidence *and* would break equal-confidence automated updates, which is
> unrelated behaviour. Authority is a kind, not a quantity.

**Q: Why the transaction?**
> The update is two writes: the audit rows and the event row. If the audit lands and the
> event fails, history claims a change that never happened. If the event lands and the audit
> fails, you have an event whose values moved with no record of why — an event that can't
> explain itself. They're one business action, so they get one transaction.

*Follow-up: what isolation level? What about two concurrent updates to the same event?*
> Postgres default, Read Committed, and there's no row lock or version check — so two
> concurrent updates could interleave. Last commit wins on the row, but **both** audit rows
> are still written, so the history stays complete even if the final value isn't the one
> you'd predict. In practice one email is processed at a time per event so it hasn't come up.
> The fix is `SELECT ... FOR UPDATE` inside the transaction, or an optimistic version column.

**Q: What happens if the same email is processed twice?**
> Nothing. Extraction is a pure function of the body, matching finds the same event by its
> exact key, `detectChanges` finds nothing different, and the service returns early without
> writing — so no update and no audit row. And ingestion-level duplicates are caught earlier
> by a unique constraint on the Gmail message id.

---

## Async Processing

**Q: Why two separate queues?**
> Different work with different failure characteristics. Email processing is fast, CPU-light,
> and it's what the user is waiting for. Attachment processing downloads potentially large
> files and parses PDFs. If they shared a queue, one 10 MB PDF would block emails behind it —
> and they'd share a retry policy that suits neither.

**Q: Why are attachments enqueued after the email is processed?**
> They used to be enqueued at sync time. So an email that failed extraction still downloaded
> its attachments — wasted API calls, wasted storage, jobs for emails that turned out to be
> irrelevant. Now `enqueueAttachmentJobs` is the last line of the email processor, after the
> rethrow point. The general rule: background jobs should only be triggered once their
> prerequisites have actually succeeded.

**Q: How do you avoid duplicate attachment jobs on a retry?**
> A deterministic job id — `attachment-<id>`. If BullMQ retries the upstream email job and it
> re-runs the fan-out, the same attachment isn't queued twice while a job with that id is
> waiting or active. And even if a duplicate job ran, `process()` returns immediately for an
> already-completed attachment.

**Q: Do you guarantee ordering?**
> No, and I don't need to. The confidence model exists precisely so order doesn't matter — a
> weak observation is rejected on its merits, not because it arrived late. A correction that
> gets processed before the announcement it corrects still ends in the right state, because
> the announcement can only overwrite it if it's at least as trustworthy.

**Q: Why does the queue payload only carry an id?**
> Because a queue isn't an authenticated channel — anything with Redis access can enqueue a
> job. A `userId` in the payload would be a *claim*, sitting next to the authoritative answer
> already in the database. So the worker loads the row and derives the owner from it. The
> email queue does carry a `userId`, but purely so a disagreement is *detectable*: if it
> doesn't match the row, the job fails permanently with `UnrecoverableError`, because no
> retry fixes a forged payload. The attachment queue carries nothing but the id, and there's
> a test that asserts that.

---

## Testing

**Q: What's your testing strategy?**
> Mostly unit tests, with every dependency below the layer under test mocked — no database,
> no Redis, no API key needed. About a dozen suites, concentrated where the judgement lives:
> matching, extraction, and the update decision. One HTTP-level test with supertest for the
> ingestion contract.

**Q: What's your best test?**
> The identity-gate regression suite. It doesn't replace the scorer — it *wraps* it with
> `jest.requireActual`, so the real scoring still runs but its call history becomes
> observable. Then it asserts the contradicting candidate was **never passed to the scorer at
> all**.
>
> That's the point: asserting only on the outcome can't distinguish "correctly vetoed" from
> "scored and happened to lose." The gate's contract is about control flow, so the assertion
> has to be about control flow. And it's a parametrized sweep across date deltas and
> confidence values, because the original bug was that *some* combination crossed the
> threshold — a regression test for a threshold bug has to cover the space, not a point.

**Q: Why mock the repository instead of testing through it?**
> Because it's a thin translation to Prisma; testing it against a mocked Prisma tests the
> mock. The exception is the attachment repository, where the claim being made is about tenant
> scoping — and an unscoped `update WHERE id` is indistinguishable from a scoped
> `updateMany WHERE id, userId` if you only inspect call arguments. So that suite uses an
> in-memory table that applies WHERE predicates for real, which makes "the other tenant's row
> didn't change" an observation instead of an assumption.

**Q: What's missing from your coverage?**
> No end-to-end test with a real database, no BullMQ integration test, no frontend tests. The
> gap I'd close first is the transaction rollback — "if the event update throws, no audit rows
> survive" is a guarantee the unit tests *structurally* cannot verify, because the mock has no
> rollback semantics. That needs a real Postgres.

---

## Security

**Q: How does authentication work?**
> Google OAuth only — no passwords. The callback verifies the ID token's signature, audience,
> expiry, issuer and `email_verified`, resolves the user by Google's `sub`, and creates a
> server-side session in Redis. The cookie is `httpOnly`, `Secure` in production,
> `SameSite=Lax`, and gets the `__Host-` prefix when no cookie domain is needed.

**Q: Why key identity on `sub` and not email?**
> Email is mutable — a Workspace admin can rename it or reassign it to a different person, so
> someone else can eventually inherit an account. `sub` is opaque and immutable. `User.email`
> deliberately has no unique constraint at all; it's display data.

**Q: Why server-side sessions and not JWTs?**
> Revocation. The session stores a `userId`, not a snapshot, and `requireAuth` re-reads the
> user from Postgres on every request — so disabling or deleting a user takes effect on their
> **next request**, not their next login. With a stateless JWT you're either waiting out the
> expiry or maintaining a blocklist, which is a session store with extra steps. It also keeps
> the credential out of JavaScript's reach entirely, which `localStorage` can't.

**Q: How is multi-tenancy enforced?**
> Three layers. A `TenantContext` type threaded as a required parameter — a service that takes
> one can't be called without it, whereas ambient state compiles and runs identically whether
> or not it was set, and that indistinguishability is what makes tenant bugs invisible. Then
> query shape: scoped `findFirst` and `updateMany` rather than `findUnique` and `update`, so a
> refused cross-tenant write returns `count: 0` and is observable. Then composite foreign keys
> in Postgres so a child row can't disagree with its parent's owner.

**Q: Why 404 and not 403 for someone else's event?**
> A 403 confirms the record exists. Event ids are sequential and trivially enumerable, so that
> leaks how many events other people have. Both cases answer 404 and the caller can't tell
> them apart.

**Q: What are the security gaps you know about?**
> The big one is the OAuth `state` parameter — it's missing. That was tolerable while the
> callback issued nothing, but now that it issues a session it's a live CSRF hole and it's my
> top fix. Refresh tokens are stored in plaintext and should be encrypted at rest — right now
> database access equals mailbox access. And there's no rate limiting anywhere.
>
> One I already fixed: I was logging the whole OAuth token object during debugging, which put
> long-lived refresh tokens into stdout. Removed, and logs are metadata only now.

---

## LLD / System Design Follow-ups

**Q: Design this system from scratch on a whiteboard.**
> Start with the domain, not the boxes. Three entities: the message (immutable evidence), the
> reading of a message (what was extracted, with a trust score), and the round (the mutable
> belief). Then three questions the system has to answer for each message — is this viable,
> which round is it about, and what am I allowed to write.
>
> Then the boxes: an ingestion adapter, a durable store, a queue, a worker that runs
> interpret → recognise → adjudicate, and exactly one write point. That last constraint is
> what makes it reviewable.

**Q: How would you handle an email describing three events?**
> Today it doesn't — one email produces at most one event, and both the regex and the prompt
> pick the highest-priority one. That's a deliberate MVP limit, and I'd rather say so than
> pretend.
>
> To do it properly: extraction returns an array; each element goes through the *existing*
> gate → match → decide path independently, one transaction per element; and
> `EmailExtraction` becomes one row per extracted event instead of one per email. I didn't do
> it because a partial failure — two of three matched — needs semantics I hadn't designed, and
> getting it wrong produces *more* false merges, which is the exact failure I engineered
> against.

**Q: How would you add notifications?**
> A repeatable BullMQ job scanning for events within a window, with a `Notification` table
> keyed on `(eventId, kind)` so the same reminder is never sent twice. The interesting
> constraint is that a reschedule has to invalidate pending notifications — which is
> straightforward, because `EventUpdate` already records exactly when a date changed.

**Q: How would you show *why* an event has its current values?**
> Most of it's already there. `EventUpdate` is a complete field-level history, and the matcher
> already produces a human-readable reason string like "Exact date match + Stage matched +
> Strong confidence alignment". What's missing is the link between an event and the emails
> that produced it — there's no foreign key for that. I'd add an `event_emails` join table
> recording `(eventId, emailId, matchType, score)`, which was in the original design and never
> got built.

**Q: What would you do differently if you started again?**
> Two things. I'd design the identity model before writing the matcher — the false merge came
> from letting a scoring function accumulate authority it was never meant to have, and writing
> down "which attributes individuate a round" first would have prevented it.
>
> And I'd make confidence a required field on the type from the start. It was optional, so
> when I forgot to thread it through one layer, TypeScript didn't complain and the entire
> confidence guard silently never fired. Optional fields hide integration bugs.

**Q: What's the weakest part of the system?**
> The confidence score itself. It's a hand-tuned heuristic, not a calibrated probability —
> 0.6 is a judgement, not a measurement. What it buys me is a single ordered scalar that makes
> "don't act" and "don't overwrite something better" expressible at all, and the alternative
> was acting on everything equally, which demonstrably destroyed data. But if I had usage
> data, the next step is logging every decision alongside the human's eventual correction and
> fitting the threshold to that.
