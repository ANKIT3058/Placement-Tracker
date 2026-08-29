# Interview Attack Tree

How a skeptical interviewer will drill down from the opening question. Every branch is real —
built from the actual source.

Format per node: **Q** → *ideal concise answer* → **↳** likely follow-up → `source file`

---

```
"Tell me about your Placement Intelligence System."
│
├── 1. THE PROBLEM
│   ├── Why not just CRUD?
│   ├── Why is this hard?
│   └── Who is it for?
│
├── 2. ARCHITECTURE
│   ├── Why a queue? ──► Why BullMQ? ──► Why Redis? ──► What if Redis dies?
│   ├── Why separate worker processes?
│   ├── Why a monolith?
│   └── How would it scale?
│
├── 3. GMAIL
│   ├── Which OAuth flow? ──► Why offline? ──► What do you store? ──► CSRF?
│   ├── Incremental sync? ──► historyId? ──► Cursor expiry? ──► Watermark ordering?
│   └── Duplicates? ──► Ownership?
│
├── 4. MATCHING  ◄── THE DEEPEST BRANCH
│   ├── Three tiers? ──► Exact? ──► Temporal? ──► Ambiguity?
│   ├── Old approach? ──► Why did it fail? ──► Why not raise the threshold?
│   ├── Identity vs similarity? ──► What establishes identity?
│   └── Where does confidence enter? ──► Why min() not average?
│
├── 5. AI
│   ├── Why an LLM? ──► Why not only an LLM? ──► Hallucination?
│   ├── Bad JSON? ──► Retry policy?
│   └── Unavailable? ──► Cost?
│
├── 6. DATABASE
│   ├── Why Postgres? ──► Why not Mongo? ──► Why Prisma?
│   ├── Schema? ──► Constraints? ──► Indexes? ──► Why userId first?
│   └── Transactions? ──► Isolation? ──► Locking?
│
├── 7. RELIABILITY
│   ├── Idempotency? ──► Exactly-once?
│   ├── Worker crash? ──► Retries exhausted?
│   ├── Concurrency? ──► Two workers, same event?
│   └── Multi-tenancy? ──► How is it enforced?
│
├── 8. TESTING
│   ├── 120 tests? ──► What kind? ──► Best test?
│   ├── 50 emails? ──► Where are they?
│   └── What isn't tested?
│
└── 9. REFLECTION
    ├── Weakest part?
    ├── What would you change?
    └── Hardest bug?
```

---

# Branch 1 — The problem

**Q: Why couldn't you just parse the email and insert a row?**
> Because a single email is a fragment. One round is described across four or five messages
> that arrive out of order and leave fields out. CRUD has one write behaviour — last write
> wins — and that's correct when a human typed the value. Here every write is an inference, and
> inferences vary in quality. Concretely: a partial email like "Amazon OA on 20th August" wiped
> the time and venue a previous email had correctly set.

**↳ "So what's the durable entity?"**
> The real-world round. Emails are evidence about it. That reframing is what drove every other
> decision.
`src/modules/email/email.service.ts`

**Q: Why is this a hard problem?**
> Four properties: emails are incremental, inconsistent, partial, and out-of-order. The third
> one is the nastiest — absence of a field is not a statement about that field, and most emails
> are partial.

---

# Branch 2 — Architecture

**Q: Why a queue?**
> Mainly durability. The email row is written before any risky work starts, so a crash loses a
> job, never data. On top of that: retries with backoff, keeping a multi-second LLM call off
> the request path, absorbing bursts of up to 100 emails from a sync run, and isolating one bad
> email from the rest.
`src/modules/email/email.producer.ts`

**↳ "Why BullMQ specifically?"**
> It's the mature Redis-backed queue for Node, and I already needed Redis for sessions. It
> gives me retries, exponential backoff, deterministic job ids for idempotent enqueue, and
> `UnrecoverableError` for failures that shouldn't be retried — all out of the box. The
> alternative at this scale was a database-backed job table, which is more code for less.

**↳ "Why Redis and not Postgres for the queue?"**
> Polling a database table for jobs means either latency or load. Redis gives blocking pops, so
> a worker wakes when there's work instead of asking. The honest counterpoint is that a
> `SELECT ... FOR UPDATE SKIP LOCKED` job table would have been one less piece of
> infrastructure — but I needed Redis for the session store anyway, so it wasn't an extra
> dependency.

**↳ "What if Redis dies?"**
> Three different consequences. Enqueue throws, so the email stays `pending` with no job —
> and that's the dual-write problem. A reconciler in the API process sweeps `pending` rows
> older than five minutes and re-enqueues them through the normal producer. Workers can't fetch, but
> jobs already in Redis survive. And sessions are on a separate client — the API refuses to
> start at all if the session store is unreachable, because a process that starts without one
> answers every sign-in with an opaque 500.
`src/infrastructure/redis/redis.ts`, `session-redis.ts`

**↳ "Why two Redis clients?"**
> Two reasons, one accidental and one structural. The accidental one: connect-redis v10 issues
> node-redis command signatures, and with ioredis the SET reached Redis as
> `SET key value [object Object]` and was rejected — the store silently never wrote a session.
> The structural one: BullMQ requires `maxmemory-policy noeviction`, because an evicted job key
> is a silently lost job, while a session store is commonly deployed with LRU. Applied to the
> queue instance, LRU destroys jobs.

**Q: Why separate worker processes?**
> So a slow external call — OpenAI, or downloading a 10 MB PDF — can't block HTTP. The API
> stays responsive regardless of pipeline load, and workers can be scaled independently.

**Q: Why a monolith?**
> The pipeline stages are tightly coupled by data and always run together for one email.
> Splitting them into services adds network hops and distributed failure for no benefit at this
> scale. What it needs is *process* separation, not *service* separation, and it has that.

**Q: How would you scale to 100k users?**
> Three things break first. The Gmail scheduler is in-process and does a global "all accounts"
> query — that becomes a repeatable BullMQ job partitioned across workers, and I'd move to
> Gmail push notifications instead of polling. The matcher's candidate queries need
> `(userId, company, date)` as a composite index. And attachment storage moves from local disk
> to S3, which the `StorageService` interface already allows as a one-line swap. The workers
> themselves scale horizontally as-is.

---

# Branch 3 — Gmail

**Q: Which OAuth flow, and why?**
> Authorization code. The exchange happens server-to-server with the client secret, so no token
> ever touches the browser. Implicit is deprecated and exposes tokens in the URL. PKCE is for
> public clients that can't hold a secret, which isn't my case — but I use it anyway, as
> defence in depth on the code itself: an intercepted code is useless without the verifier
> that never left my server.
`src/modules/gmail/gmail.service.ts`

**↳ "Why offline access?"**
> Without it Google returns an access token only, which expires in an hour. Background sync has
> to work when nobody is logged in, so I need a refresh token.

**↳ "What do you store?"**
> Only the refresh token, on `GmailAccount`. Never access tokens — they're re-mintable, so
> storing them is pure risk. And nothing derived from Google's tokens goes in the session; the
> session is an identity record, not a credential store.

**↳ "Is your OAuth callback CSRF-protected?"**
> **Yes.** A 32-byte random `state` is stored on the anonymous session and compared on the
> callback, with a 10-minute TTL independent of the session's own, and it's **consumed and
> persisted before the token exchange** so a replay arriving mid-exchange doesn't find it
> live. Every failure — missing, mismatched, expired, replayed — returns the same
> indistinguishable answer, because naming which one failed tells an attacker which half of
> their guess was right. PKCE with S256 sits on top of that.
>
> The attack it closes is specific: without `state`, the callback would establish a session
> from any valid authorization code — including one an attacker obtained for their *own*
> Google identity and then induced a victim to visit, handing the victim's browser a session
> for the attacker's tenant.

**Q: What does "incremental" mean concretely?**
> Each mailbox stores a `historyId` cursor from Gmail. On the next run I call `history.list`
> from that cursor and only get messages added since. No cursor → full sync. Expired cursor →
> Gmail answers 404 and I fall back to a full sync automatically.
`src/modules/gmail/gmail.sync.service.ts`

**↳ "Why capture the watermark before listing?"**
> If you capture it after, a message that arrives during the listing gets a history id below
> the new cursor and is never seen again. Capturing first means it's re-fetched next run, and
> re-fetching is free because dedupe catches it. Overlap is safe; gaps are not.

**↳ "Is the first sync complete?"**
> No — full sync uses `maxResults: 100` with no pagination, so a new mailbox bootstraps from
> its most recent 100 messages. Incremental sync *is* fully paginated. Deliberate for a
> bootstrap, and easy to extend.

**Q: How do you avoid processing the same message twice?**
> `gmailMessageId` is unique, and the sync looks it up before inserting. And even if a job ran
> twice, `detectChanges` finds nothing different so nothing is written.

**Q: How do you know which user owns an email?**
> Ownership flows from the mailbox: `syncSingleMessage` writes `userId: account.userId`. It's
> never inferred. The attachment worker used to guess with "whichever mailbox exists", which
> was correct with one user and silently wrong with two — that's why `Email.gmailAccountId`
> exists now.

---

# Branch 4 — Matching (expect the most time here)

**Q: How do you decide two emails describe the same round?**
> Three tiers of decreasing evidence, stopping at the first sufficient answer. An exact identity
> key of company-round-date. Then same company within ±3 days, with candidates ranked. Then
> same company and round within 30 days, but only if there's exactly one candidate. If all three
> miss, I create a new event.
`src/modules/matching/matching.service.ts`

**↳ "What makes tier 1 'exact'?"**
> `eventKey = "company|stage|date"` with a unique index on `(userId, eventKey)`. All three
> identity attributes agree, so there's nothing to judge — it returns immediately with
> confidence 1.0 and never runs the other tiers.

**↳ "What's 'temporal' about tier 2?"**
> The candidate query is a date range — ±3 days on the same company — and inside the scorer,
> date proximity is banded: same day 1.0, one day 0.7, up to three days 0.5, beyond that an
> early return of zero. So time is both the filter and the dominant ranking signal.

**↳ "And 'ambiguity handling'?"**
> Three distinct behaviours. A candidate whose round contradicts is vetoed before scoring. Tier
> 3 refuses when two or more candidates are in range, because uniqueness is its entire identity
> claim. And the whole pipeline returns null when nothing qualifies, which creates a duplicate
> rather than guessing.

**Q: Your resume says you replaced a weighted-similarity approach. What was it?**
> `0.5·dateProximity + 0.3·roundAgreement + 0.2·confidenceAlignment`, accept above 0.5. One
> scalar decided both whether a candidate was the same event and which one to pick.

**↳ "And what went wrong?"**
> The date term alone is 0.5 times 1.0 — exactly the threshold. So same company, same date,
> different round was accepted. A morning pre-placement talk and an afternoon online assessment
> merged into one record, and the merged row kept the PPT's label.

**↳ "Why not just raise the threshold?"** ← **the killer follow-up**
> Because the function is monotone in every term. A mismatched round contributes zero, and zero
> means "no support", not "evidence against". So the date term is a lower bound — no
> configuration of the other inputs can pull the total below it. Raise it to 0.6 and the case
> still passes at 0.64. Raise it to 0.7 and you start rejecting legitimate matches where the
> round simply wasn't extracted. There is no threshold that works, because a weighted sum of
> non-negative terms cannot encode a veto. It was a representational defect, not a tuning one.
`src/modules/matching/matching.utils.ts`, `docs/06_ADR/ADR-006_Identity_Precedes_Similarity.md`

**↳ "So what did you change it to?"**
> Two phases with separated authority. Admission is categorical — AGREES, UNKNOWN or
> CONTRADICTS — and runs to completion before any scoring. A contradiction vetoes the candidate
> outright. Only survivors get ranked, and ranking has no authority to admit.

**↳ "Does the old formula still exist?"**
> Yes, and I'd be precise about that: the formula is unchanged. What changed is its authority —
> it now ranks candidates that already passed the gate, instead of deciding which candidates are
> eligible.
> *(Say this. An interviewer who opens the file will find `scoreEventMatch` intact.)*

**↳ "Why is UNKNOWN not a contradiction?"**
> Because an email that didn't state a round has said nothing about identity. Reading silence as
> disagreement is the same mistake in the other direction. It's the same rule I use on the
> update path — a missing venue means "this email didn't mention venue", not "there is no
> venue".

**↳ "What if both sides are unknown?"**
> Still UNKNOWN, never AGREES. The literal string `"unknown"` is a sentinel for "not
> extracted", so `resolveRound` maps it to null and it never compares equal to itself. Two
> unknowns "agreeing" would assert identity from company plus date alone, which is exactly what
> the domain forbids.

**↳ "What establishes identity, and what only ranks?"**
> Company and round establish identity — company by filtering the candidate query at every
> tier, round categorically through the gate. Date does both: it's part of the identity key at
> tier 1, and the dominant ranking signal inside an already-bounded window at tier 2. Confidence
> only ranks — 20% of the score, and it can never admit a candidate. Time and venue are neither;
> they're payload, and they're only compared during the update, never during matching.

**↳ "Why `min(incoming, existing)` for confidence alignment?"**
> Because a match is only as trustworthy as its weaker side. Averaging lets one very confident
> record drag a shaky one over the line.

**↳ "Why 30 days for the loose tier?"**
> Because that tier infers identity purely from uniqueness, and uniqueness is only meaningful
> inside a plausible range. Unbounded, a company's first OA is trivially unique — so it fired
> most confidently exactly where it had the least evidence, and merged rounds months apart as a
> single reschedule. 30 days is wider than the ±3-day tier so it still catches real reschedules,
> but narrow enough to exclude cross-cycle collisions.

---

# Branch 5 — AI

**Q: Why use an LLM at all?**
> Because real emails don't follow patterns I can anticipate. Regex handles "Amazon OA on 20th
> Aug at 10 AM". It doesn't handle a paragraph of prose that mentions the company implicitly and
> says "tomorrow afternoon".
`src/modules/extraction/extraction.service.ts`

**↳ "Then why not use only the LLM?"**
> Because of *how* they fail. A regex that doesn't match returns null, which is honest. An LLM
> that doesn't know returns a confident-looking wrong answer. So regex is the floor the system
> can always stand on and the model is the ceiling. It also means the whole system runs with no
> API key — `USE_AI` is false by default and the entire test suite runs without one.

**↳ "How do you stop it hallucinating?"**
> For dates specifically, which is the field that matters most. The model returned `2027-01-01`
> for an email that only said "in 2027" — it invented the day and month to satisfy the output
> format, and validating the shape catches nothing because that's a perfectly well-formed date.
> So `validateAIDate` extracts every day-plus-month mention from the source and keeps the
> candidate only if one corroborates it. If not it's dropped, not replaced, so it falls back to
> the regex date like any other missing field.
`src/modules/extraction/extraction.utils.ts`

**↳ "Why not structured outputs or JSON schema mode?"**
> That guarantees the shape, which was never the problem — the model already returned valid
> JSON with a valid date string. The content was fabricated. A schema can't express "this date
> must appear in the input text."

**↳ "What if it returns invalid JSON?"**
> A typed `MalformedResponseError` carrying the raw text. In the extraction path retries are
> disabled, so it's caught and the pipeline goes regex-only. In the AI Core's default policy
> malformed JSON is treated as transient and retried up to three times with linear backoff.
`src/modules/ai/json-response-parser.ts`, `retry-policy.ts`

**↳ "What do you retry, and what don't you?"**
> Transient only: malformed JSON, empty responses, and provider errors flagged retryable — a
> network error with no status, 408, 429, or any 5xx. A 400 or 401 isn't retried, because an
> identical request won't fix a bad request or an auth failure.

**↳ "What about cost?"**
> `gpt-4o-mini` at temperature 0, one call per email, and off by default. At my volume it's
> negligible. If it mattered I'd gate the AI call on the regex result — only call the model when
> deterministic extraction left a required field empty.

---

# Branch 6 — Database

**Q: Why PostgreSQL?**
> The data is relational and the correctness of the system rests on constraints the database can
> enforce — a unique identity key per owner, composite foreign keys that make cross-tenant rows
> unrepresentable. And I need real transactions for the update-plus-audit pair.

**↳ "Why not MongoDB?"**
> Because almost everything keeping this correct is a constraint. `@@unique([userId, eventKey])`
> makes a duplicate event *impossible* rather than unlikely. In Mongo I'd enforce that in
> application code — which is the exact layer that already had the bug.
`backend/prisma/schema.prisma`

**↳ "Why Prisma?"**
> Type safety end to end, so a schema change becomes a compile error rather than a runtime one.
> Readable versioned migrations. Ergonomic interactive transactions. The trade-off I'd name is
> that I don't fully control the generated SQL — `findNearbyEvents` filters company in memory
> because there's no `(userId, company, date)` index yet.

**↳ "Walk me through the schema."**
> Seven models. User is the tenant root. GmailAccount is a mailbox with its refresh token and
> sync cursor. Email is the raw message. EmailExtraction is what was read from it. Event is the
> real-world round — the only truly mutable row. EventUpdate is the append-only audit. Attachment
> is file metadata plus download and parse state.

**↳ "What are the important constraints?"**
> `@@unique([userId, eventKey])` for identity per owner — it was global until the multi-user
> migration and that was a bug, because two students on the same mailing list produce the same
> key. And composite foreign keys on `(parentId, userId)`, so a child row that disagrees with
> its parent's owner is unrepresentable rather than just incorrect.

**↳ "Why do all your indexes start with userId?"**
> Because every query is already tenant-scoped. `WHERE userId = ? AND date BETWEEN ...` can't
> use an index on `date` alone efficiently — it'd scan across every tenant and filter.

**↳ "Do you use transactions?"**
> One explicit one: the event update plus its audit rows. They're one business action — an event
> whose values moved with no record of why is a state the domain forbids. Plus one implicit one:
> the nested create that writes an Email and all its Attachment rows.
`src/modules/event/event.service.ts`

**↳ "What isolation level?"**
> Postgres default — Read Committed. I didn't tune it.

**↳ "Do you use optimistic or pessimistic locking?"**
> **Neither.** Two concurrent updates to the same event could interleave — last commit wins on
> the row, though both audit rows are still written so the history stays complete. In practice
> one email is processed at a time per event so it hasn't come up. The fix is
> `SELECT ... FOR UPDATE` inside the transaction or a version column with a compare-and-set.
> *(Volunteer this. Claiming safety you don't have is the fastest way to lose credibility.)*

---

# Branch 7 — Reliability

**Q: Is your processing idempotent?**
> Yes, by construction rather than by a dedupe table. Extraction is a pure function of the body,
> matching finds the same event by key, and `detectChanges` returns an empty list when nothing
> differs — so a second run writes nothing and creates no audit row.
`src/modules/event/event.service.ts` → `detectChanges`

**↳ "Do you guarantee exactly-once processing?"** ← **the trap**
> **No.** BullMQ is at-least-once — if a worker dies after doing the work but before acking, the
> job is redelivered. You can't get exactly-once across a queue and a database without
> distributed transactions or an idempotency-key table. So instead I made processing idempotent.
> The system is designed to tolerate duplicate processing rather than to prevent it.

**Q: What if the worker crashes mid-job?**
> BullMQ marks it stalled and redelivers. The re-run recomputes from the raw body, finds the same
> event, detects no change, writes nothing. The email row may sit at `processing` until the
> re-run finishes.

**Q: What happens after retries are exhausted?**
> `markEmailFailed` has already written the status and the reason. The job lands in BullMQ's
> failed set and stays there — `removeOnFail: false` — so it can be inspected. There's no
> automatic dead-letter reprocessing.

**↳ "Are there failures you deliberately don't retry?"**
> Two. A unique-constraint violation — `P2002` — is swallowed and the job succeeds, because the
> desired end state already exists and retrying just reproduces it. And an ownership mismatch
> between the job payload and the persisted row throws `UnrecoverableError`, because it means a
> forged payload or a broken invariant and no retry fixes either.
`src/workers/email.worker.ts`

**Q: Two workers process emails for the same event concurrently. What happens?**
> If both try to create, one wins and the other gets P2002, which is swallowed. If both update,
> they interleave at Read Committed — last commit wins on the row, both audit rows written. No
> locking, as I said.

**Q: How is multi-tenancy enforced?**
> Three layers. A `TenantContext` type threaded as a *required* parameter — a service that takes
> one can't be called without it, whereas ambient state compiles and runs identically whether or
> not it was set, and that indistinguishability is what makes tenant bugs invisible. Then query
> shape: scoped `findFirst` and `updateMany` rather than `findUnique` and `update`, so a refused
> cross-tenant write returns `count: 0` and is observable. Then composite foreign keys in
> Postgres.
`src/modules/auth/tenant-context.ts`

**↳ "How does the worker know the tenant? There's no request."**
> It derives it from the persisted row — `getEmailById` and `getAttachmentById` are deliberately
> unscoped and documented as the ownership derivation roots. The queue payload's `userId` is a
> *claim*, carried only so a disagreement is detectable, and a mismatch fails the job
> permanently. A queue isn't an authenticated channel.

**↳ "Why 404 and not 403 for someone else's event?"**
> A 403 confirms the record exists, and event ids are sequential and trivially enumerable. Both
> cases answer 404 so the caller can't tell them apart.

---

# Branch 8 — Testing

**Q: You say 120 automated tests. What are they?**
> 1038 backend tests across 52 Jest suites, plus 331 client tests across 18 Vitest files —
> parametrized. Almost all unit tests with dependencies mocked — no database, no Redis, no API
> key needed — plus one integration test with supertest against the real Express app.

**↳ "What's your best test?"**
> The identity-gate regression suite. It doesn't replace the scorer, it *wraps* it with
> `requireActual`, so the real scoring still runs but its call history becomes observable. Then
> it asserts the contradicting candidate was never passed to the scorer at all. Asserting on the
> outcome alone can't distinguish "correctly vetoed" from "scored and happened to lose" — the
> gate's contract is about control flow, so the assertion has to be too. And it's a sweep across
> date deltas and confidence values, because the original bug was that *some* combination
> crossed the threshold.
`src/modules/matching/__tests__/matching.service.test.ts`

**↳ "Where are the 50 real emails?"**
> Not in the repo — they contain other students' names and registration numbers. What's in the
> repo is the regression tests derived from them, and `storage/attachments` has the eleven
> attachments the pipeline actually downloaded from real messages. The emails drove the bugs;
> the bugs became the tests.

**↳ "What's your coverage percentage?"**
> I don't measure line coverage. I'd rather describe what's protected: matching, extraction and
> the update decision, densely, because that's where the judgement lives.

**↳ "What isn't tested?"**
> No real-database test, no BullMQ integration test, no frontend tests. The gap I'd close first
> is a rollback test for the update transaction — a mock has no rollback semantics, so that's a
> guarantee my unit tests structurally cannot verify.

---

# Branch 9 — Reflection

**Q: What's the weakest part?**
> The confidence score itself. It's a hand-tuned heuristic, not a calibrated probability — 0.6 is
> a judgement, not a measurement. What it buys me is a single ordered scalar that makes "don't
> act" and "don't overwrite something better" expressible at all, and the alternative was acting
> on everything equally, which demonstrably destroyed data. With usage data I'd log every
> decision alongside the human's eventual correction and fit the threshold to that.

**Q: What's a limitation you'd fix next?**
> One email produces at most one event. A real email announced a PPT and an online test together
> and I only captured one. Fixing it means extraction returns an array and each element goes
> through the existing gate-match-decide path independently. I didn't do it because a partial
> failure — two of three matched — needs semantics I hadn't designed, and getting it wrong
> produces *more* false merges, which is exactly what I engineered against.

**Q: What was the hardest bug?**
> The false merge, because the hard part wasn't fixing it, it was recognising what kind of bug
> it was. It looks like a threshold that needs tuning. It's actually a representation that can't
> express the thing you need. I found it by writing the specification, not from a failing test —
> documenting the domain forced me to write down that three attributes individuate a round, and
> then I looked at what the matcher actually required and it was only using two.

**Q: What would you do differently starting again?**
> Two things. Design the identity model before writing the matcher — the false merge came from
> letting a scoring function accumulate authority it was never meant to have. And make confidence
> a required field on the type from the start; it was optional, so when I forgot to thread it
> through one layer, TypeScript didn't complain and the entire confidence guard silently never
> fired. Optional fields hide integration bugs.

---

# The four questions that decide the interview

If you nail only four, make them these:

| # | Question | The one-line core |
|---|---|---|
| 1 | Why not just raise the similarity threshold? | *A weighted sum of non-negative terms cannot encode a veto — it's representational, not a constant.* |
| 2 | Do you guarantee exactly-once processing? | *No. At-least-once, so I made processing idempotent.* |
| 3 | Why capture the sync watermark before listing? | *Overlap is safe; gaps are not.* |
| 4 | How is multi-tenancy enforced? | *Required parameter, scoped query shape, composite foreign keys — three layers, the last one in the database.* |
