# Mock Interview

40 questions in realistic order, built only from your resume. **Practise speaking, not reading.**

For each: what a strong answer contains, the follow-up, and what not to say.

---

# OPENING (Q1–3)

## Q1
### Interviewer
"Tell me about yourself."

### What a strong answer should contain
- 30 seconds max, ending on the thing you want them to ask about
- Final-year student · backend focus · two projects · one sentence on each
- Land on: *"the one I'd most like to talk about is the placement tracker, because the
  interesting problem there wasn't parsing emails, it was deciding when the system is allowed to
  trust what it just read"*

### Follow-up
"Tell me about that one."

### What I should NOT say
Your whole academic history. Anything before "I'm a final-year student". A list of every
technology you've touched.

---

## Q2
### Interviewer
"Tell me about the Placement Intelligence System."

### What a strong answer should contain
The two-minute version from [PLACEMENT-TRACKER-DEEP-DIVE.md §2](PLACEMENT-TRACKER-DEEP-DIVE.md).
Beats: the problem (one round, several emails, out of order) → why CRUD fails (every write is an
inference) → the pipeline (Gmail → queue → extract → gate → match → decide) → the two hard parts
(identity and trust).

### Follow-up
"Why couldn't you just parse and insert?"

### What I should NOT say
Start with the tech stack. Start with "so I used Node and Postgres and Redis". Lead with tools
instead of the problem.

---

## Q3
### Interviewer
"Why couldn't you just parse the email and insert a row?"

### What a strong answer should contain
- A single email is a fragment; absence of a field isn't a statement about that field
- Emails arrive out of order, so "last write wins" is wrong — every write is an *inference*
- **The concrete failure:** "Amazon OA on 20th August" wiped the time and venue a previous email
  had correctly set

### Follow-up
"So what's the durable entity?"
→ *"The real-world round. Emails are evidence about it."*

### What I should NOT say
Abstractions without the concrete example. The wiped-fields story is what makes it land.

---

# ARCHITECTURE (Q4–8)

## Q4
### Interviewer
"Walk me through the architecture."

### What a strong answer should contain
Three processes: API (plus the sync scheduler), email worker, attachment worker. Then the flow
in one breath: sync writes a raw Email row and enqueues → worker derives ownership from the row →
clean → extract → confidence → viability gate → match → decide → transaction → fan out
attachments.

### Follow-up
"Why a queue?"

### What I should NOT say
Enumerate every file. Keep it to boxes and arrows.

---

## Q5
### Interviewer
"Why a queue instead of doing it in the request?"

### What a strong answer should contain
Durability first — the email row is written before anything risky, so a crash loses work, never
data. Then: retries with backoff, keeping a multi-second LLM call off the request path, absorbing
a burst of 100 emails from one sync run, isolating one bad email.

### Follow-up
"What if the worker crashes mid-job?"

### What I should NOT say
"Because queues are better for scalability." Give the specific reasons.

---

## Q6
### Interviewer
"What if the worker crashes halfway through a job?"

### What a strong answer should contain
BullMQ marks it stalled and redelivers. The re-run recomputes from the raw body, finds the same
event by its identity key, `detectChanges` returns an empty list, nothing is written. **Idempotent
by construction, not by a flag.**

### Follow-up
"Do you guarantee exactly-once processing?"

### What I should NOT say
"It's fine because of retries." That doesn't answer what happens to a half-done job.

---

## Q7
### Interviewer
"Do you guarantee exactly-once processing?"

### What a strong answer should contain
**No.** BullMQ is at-least-once. You can't get exactly-once across a queue and a database without
distributed transactions. So the operation is idempotent — the system tolerates duplicate
processing rather than preventing it.

### Follow-up
"How exactly is it idempotent?"
→ Pure extraction from the body, same event found by key, `detectChanges` returns `[]`.

### What I should NOT say
🔴 **"Yes."** This is the single fastest way to lose a backend interviewer.

---

## Q8
### Interviewer
"How would you scale this to a hundred thousand users?"

### What a strong answer should contain
Name what breaks first, in order: the in-process scheduler with its global account query becomes
a partitioned repeatable job, and polling becomes Gmail push via Pub/Sub; the matcher needs a
`(userId, company, date)` index; attachment storage moves to S3, which the `StorageService`
interface already allows. Workers scale horizontally as-is.

### Follow-up
"What's the actual bottleneck — CPU, database, or the external APIs?"
→ *"Gmail quota and OpenAI rate limits, before anything of mine."*

### What I should NOT say
"Add more servers." "Use Kubernetes." Name *your* bottlenecks.

---

# GMAIL & OAUTH (Q9–13)

## Q9
### Interviewer
"How does the Gmail connection work?"

### What a strong answer should contain
Authorization code flow with `access_type: offline` and `prompt: consent`. Verify the ID token
(signature, audience, expiry, issuer allowlist, `email_verified`). Store only the refresh token.
Scope is `gmail.readonly`.

### Follow-up
"Why offline access?"
→ Background sync must work when nobody is logged in.

### What I should NOT say
"I use the Gmail API with OAuth" and stop. Name the flow.

---

## Q10
### Interviewer
"Why the authorization code flow and not implicit or PKCE?"

### What a strong answer should contain
Code flow keeps the exchange server-to-server with the client secret, so no token touches the
browser. Implicit is deprecated and leaks tokens through the URL fragment. PKCE is for public
clients that can't hold a secret — a SPA or a mobile app — and I have a backend.

### Follow-up
"Is your callback protected against CSRF?"

### What I should NOT say
Guess at PKCE's purpose. If unsure, say "PKCE is for clients that can't keep a secret" and stop.

---

## Q11
### Interviewer
"Is your OAuth callback protected against CSRF?"

### What a strong answer should contain
**Be honest.** "No — the `state` parameter is missing. It was tolerable while the callback issued
nothing, but it now creates a session, so it's a live gap and it's my top fix. The mitigation is a
signed single-use `state` tied to the session and verified on return."

### Follow-up
"What would you use for the state value?"
→ A CSPRNG random value stored server-side against the session, compared on return, then
discarded.

### What I should NOT say
🔴 "Yes it is." It's checkable in ten seconds, and the code's own comments say otherwise.

---

## Q12
### Interviewer
"Your resume says 'incremental Gmail synchronization'. What does incremental mean here?"

### What a strong answer should contain
A `historyId` cursor per mailbox. `history.list` from that cursor returns only messages added
since. No cursor → full sync. Expired cursor → Gmail answers 404 and I fall back to full sync
automatically.

### Follow-up
"What happens if a message arrives while you're syncing?"

### What I should NOT say
"I check which emails I already have." That's deduplication, not incremental sync.

---

## Q13
### Interviewer
"What happens if a message arrives while you're syncing?"

### What a strong answer should contain
On a full sync I capture the watermark **before** listing. Capturing it after means that message
gets a history id below the new cursor and is never seen again. Capturing first means it's
re-fetched next run — free, because `gmailMessageId` is unique.

> **"Overlap is safe; gaps are not."**

### Follow-up
"So you could process the same email twice?"
→ The unique constraint prevents a second Email row, and even if a job ran twice, `detectChanges`
finds nothing different.

### What I should NOT say
Nothing to avoid — this is one of your strongest answers. Deliver the one-liner.

---

# MATCHING (Q14–20) — the core

## Q14
### Interviewer
"How do you decide two emails describe the same event?"

### What a strong answer should contain
Three tiers of decreasing evidence, stopping at the first sufficient answer. Exact identity key
(company, round, date). Same company within ±3 days, ranked. Same company *and* round within 30
days, **only if there's exactly one candidate.** All three miss → create a new event.

### Follow-up
"What's the identity key exactly?"
→ `"company|stage|date"`, with a unique index on `(userId, eventKey)`.

### What I should NOT say
Jump straight into the scoring formula. Lead with the tiers.

---

## Q15
### Interviewer
"Your resume says you replaced a weighted-similarity approach. What was it, and why did you
replace it?"

### What a strong answer should contain
The formula: `0.5·date + 0.3·round + 0.2·confidence`, accept ≥ 0.5. The date term alone is
exactly the threshold. So same company, same date, **different round** was accepted — a morning
PPT and an afternoon OA merged into one record.

### Follow-up
"Why not just raise the threshold?" ← **the real question**

### What I should NOT say
Describe the fix before the failure. The concrete merge is what makes the fix meaningful.

---

## Q16
### Interviewer
"Why not just raise the threshold?"

### What a strong answer should contain
**The most important answer in your preparation.**

The function is a sum of non-negative terms, so it's monotone in each — the date term is a *lower
bound* and nothing can pull the total below it. A mismatched round contributed `0`, and `0` means
"no support", not "evidence against". Raise it to 0.6 and the case still passes at 0.64. Raise it
to 0.7 and you reject legitimate matches where the round simply wasn't extracted.

> **A weighted sum of corroboration cannot encode a veto. It was representational, not a
> mis-tuned constant.**

### Follow-up
"So what did you replace it with?"
→ Categorical admission — AGREES / UNKNOWN / CONTRADICTS — run to completion before any scoring.
Only survivors get ranked.

### What I should NOT say
"I tuned the weights." That's the answer that makes the whole bullet collapse.

---

## Q17
### Interviewer
"Does the old formula still exist in your code?"

### What a strong answer should contain
**Yes, and be precise.** "The formula is unchanged. What I replaced is its *authority* — it used
to decide both whether a candidate was the same event and which one to pick. Now identity is
decided categorically before it runs, and the score only ranks candidates that already
qualified."

### Follow-up
"Show me."
→ `matching.service.ts` — two separate loops: the gate loop, then the ranking loop.

### What I should NOT say
🔴 "No, I deleted it." They can open the file.

---

## Q18
### Interviewer
"What establishes identity, and what only ranks?"

### What a strong answer should contain
Company and round establish identity — company by filtering the candidate query at every tier,
round categorically through the gate. **Date does both:** part of the identity key at tier 1, the
dominant ranking signal within an already-bounded window at tier 2. Confidence **only** ranks —
20% of the score, and it can never admit a candidate. Time and venue are neither.

### Follow-up
"Why is 'unknown' round not treated as agreement?"
→ It's a sentinel for "not extracted", so `resolveRound` maps it to null and it never compares
equal to itself. Two unknowns "agreeing" would assert identity from company plus date alone —
exactly what the domain forbids.

### What I should NOT say
"Date establishes identity" flatly. The nuance *is* the bug.

---

## Q19
### Interviewer
"What happens when two candidates are equally plausible?"

### What a strong answer should contain
Depends on the tier. At tier 2 both are scored and the highest wins; ties keep the first, because
the comparison is strictly greater-than. At tier 3, two candidates in range means **no match at
all** — uniqueness is that tier's entire identity claim. And if nothing qualifies anywhere, a new
event is created.

### Follow-up
"Isn't creating a duplicate bad?"

### What I should NOT say
"It picks the closest one." Be specific about which tier.

---

## Q20
### Interviewer
"Isn't creating a duplicate bad?"

### What a strong answer should contain
It's the *better* failure, and the whole system is shaped around that asymmetry. A duplicate is
visible, embarrassing and one delete away. A false merge is invisible, entirely plausible, and
destroys the information you'd need to undo it — there's no record the second round ever existed.
So every threshold fails toward the duplicate, and I tried to make that structural rather than
arithmetic: bounded windows, a uniqueness requirement at the weakest tier, a categorical veto.

### Follow-up
"How do users deal with the duplicates?"
→ Honest: "They'd delete one. There's no merge UI — that's a gap."

### What I should NOT say
Be defensive. Owning the trade-off *is* the answer.

---

# CONFIDENCE (Q21–23)

## Q21
### Interviewer
"Explain 'confidence-aware identity model'."

### What a strong answer should contain
Break the phrase apart. Identity is a fact about the world — categorical, holds or doesn't,
determined by company + round + date where any two are insufficient. Confidence is a quantity I
compute from *how* each field was obtained. They're different kinds of thing, and conflating them
caused the bug. So they're strictly ordered: identity decides eligibility with confidence having
no say; confidence is 20% of the ranking among the eligible; then confidence alone decides whether
to act and whether to overwrite.

### Follow-up
"How is confidence computed?"
→ Weighted: date 0.35, company 0.25, time 0.20, stage 0.10, venue 0.10, plus a completeness
bonus, minus penalties for missing fields. Scorers grade provenance — an exact date beats "next
week", an explicit venue beats an inferred one.

### What I should NOT say
Recite the formula first. Explain the *distinction* first.

---

## Q22
### Interviewer
"What if the new data has lower confidence but is actually correct?"

### What a strong answer should contain
It's rejected and the event goes stale — which is visible, and the user can fix it manually,
which sets confidence to 1.0 and locks it against further automated updates. That's the accepted
trade: staleness is recoverable, corruption isn't.

### Follow-up
"How do you know 0.6 is the right threshold?"
→ "I don't — it's a hand-tuned heuristic, not calibrated. With usage data I'd log every decision
alongside the human's eventual correction and fit it."

### What I should NOT say
Claim the threshold is principled. Owning that it's a heuristic is stronger.

---

## Q23
### Interviewer
"A human confirms an event. Then a very confident email arrives about it. What happens?"

### What a strong answer should contain
Nothing — the update is refused outright. The guard is on **status**, not confidence, and that's
the interesting part: manual confirmation sets confidence to exactly 1.0 and so does a maximally
confident extraction, so the numeric comparator literally can't tell "a person settled this" from
"the extractor was very sure."

> **Authority is a kind, not a quantity.**

### Follow-up
"Why not just use `<=` in the comparison?"
→ It would express a categorical intent as a numeric coincidence, *and* it would reject
equal-confidence automated updates between two inferences, which is unrelated behaviour.

### What I should NOT say
"Higher confidence wins." That's the general rule and this is the exception.

---

# DATABASE (Q24–28)

## Q24
### Interviewer
"Walk me through your schema."

### What a strong answer should contain
Seven models. User is the tenant root. GmailAccount is a mailbox with its refresh token and sync
cursor. Email is the raw message. EmailExtraction is what was read from it. Event is the
real-world round — the only truly mutable row. EventUpdate is the append-only audit. Attachment
is metadata plus download and parse state.

### Follow-up
"Why separate Email, EmailExtraction and Event?"
→ Three different facts with different failure modes. Keeping them separate is what lets me tell
an extraction bug from a decision bug.

### What I should NOT say
List columns. Explain roles.

---

## Q25
### Interviewer
"Why PostgreSQL and not MongoDB?"

### What a strong answer should contain
Almost everything keeping this system correct is a *constraint*. `@@unique([userId, eventKey])`
makes a duplicate event impossible rather than unlikely; composite foreign keys make a
cross-tenant row unrepresentable. In Mongo I'd enforce those in application code — the exact layer
that already had the bug. And the update-plus-audit pair needs a real transaction.

### Follow-up
"What about schema flexibility?"
→ The shape genuinely is fixed — five extracted fields. Where I need flexibility,
`Attachment.parsedData` is a JSON column. Postgres gives me document storage where I want it
without giving up constraints where I need them.

### What I should NOT say
"Mongo is bad." Argue from your requirements.

---

## Q26
### Interviewer
"Tell me about your indexes."

### What a strong answer should contain
Every composite index leads with `userId`, because every query is already tenant-scoped —
`WHERE userId = ? AND date BETWEEN ...`. An index on `date` alone would be scanned across every
tenant and filtered. `(userId, date)` serves the matcher's window queries and the dashboard sort;
`(userId, status)` serves the review queue.

Then volunteer the gap: **there's no `(userId, company, date)`**, so `findNearbyEvents` filters
company in memory. Irrelevant at this volume; I'd add it at scale.

### Follow-up
"Why does column order matter in a composite index?"
→ Leftmost-prefix rule — it's sorted by the first column, then the second within that.

### What I should NOT say
"I indexed the columns I query." Show you understand *order*.

---

## Q27
### Interviewer
"You said you use a transaction. What's in it, and what isolation level?"

### What a strong answer should contain
The audit rows and the event update — one business action. Without it you could have history
claiming a change that didn't happen, or worse, an event whose values moved with no record of
why. Isolation is Postgres's default, Read Committed. I didn't tune it.

### Follow-up
"What could go wrong at Read Committed?"

### What I should NOT say
Guess an isolation level. If you're unsure, "the Postgres default" is both true and safe.

---

## Q28
### Interviewer
"Two workers update the same event concurrently. What happens?"

### What a strong answer should contain
**Be honest.** "I use neither optimistic nor pessimistic locking. They'd interleave — last commit
wins on the row, though both audit rows are still written, so the history stays complete even if
the final value isn't the one you'd predict. In practice one email is processed at a time per
event so it hasn't come up. The fix is `SELECT ... FOR UPDATE` inside the transaction, or a
version column with a compare-and-set."

### Follow-up
"Which would you pick?"
→ Optimistic — contention is rare here, so paying a lock cost on every update to handle a case
that almost never happens is the wrong trade.

### What I should NOT say
🔴 "The transaction handles it." A transaction gives atomicity, not mutual exclusion.

---

# RELIABILITY & SECURITY (Q29–32)

## Q29
### Interviewer
"How do you prevent one user seeing another user's data?"

### What a strong answer should contain
Three layers. A `TenantContext` threaded as a *required* parameter — a service that takes one
can't be called without it, whereas ambient state compiles identically whether or not it was set,
and that indistinguishability is what makes tenant bugs invisible. Then query shape: scoped
`findFirst` and `updateMany`, so a refused cross-tenant write returns `count: 0` and is
observable. Then composite foreign keys in Postgres.

### Follow-up
"How does a background worker know the tenant? There's no request."
→ It derives it from the persisted row. The queue payload's `userId` is a claim, carried only so
a disagreement is detectable, and a mismatch fails the job permanently. A queue isn't an
authenticated channel.

### What I should NOT say
"I check `userId` in every query." Layers, and especially the database layer.

---

## Q30
### Interviewer
"You write to Postgres and then enqueue to Redis. What if the enqueue fails?"

### What a strong answer should contain
**They will find this. Own it.** "Then the email row exists at `pending` and no job exists —
that's the dual-write problem and I have it. There's no sweeper picking those up. The clean fix
is a transactional outbox: write the job into an outbox table in the *same* transaction as the
email, and have a relay process move outbox rows to Redis. Then the worst case is delayed
delivery instead of lost work."

### Follow-up
"Why didn't you build that?"
→ "Redis being down at exactly that moment hasn't happened, and I'd rather name the gap than
build for it prematurely. `getPendingEmails` already exists, tenant-scoped, unused — that's the
hook."

### What I should NOT say
"That can't happen."

---

## Q31
### Interviewer
"Where do you store the Gmail refresh token, and is that safe?"

### What a strong answer should contain
On `GmailAccount`, as a plaintext column. **And that's a gap** — it should be encrypted at rest
with a key from a secret manager, because right now database access equals mailbox access. What I
do get right: I never store access tokens, the token object is deliberately never logged, and
nothing derived from Google's tokens goes in the session.

### Follow-up
"Have you ever leaked one?"
→ "Early on I was `console.log`-ing the whole token object while debugging, which put refresh
tokens into stdout. I removed it and there's a comment on that function now saying why it's never
logged."

### What I should NOT say
Claim it's encrypted.

---

## Q32
### Interviewer
"Why sessions instead of JWTs?"

### What a strong answer should contain
Revocation. The session stores a user id, not a snapshot, and `requireAuth` re-reads the user from
Postgres on every request — so disabling or deleting a user takes effect on their **next
request**, not their next login. With a stateless JWT you're either waiting out the expiry or
maintaining a blocklist, which is a session store with extra steps. It also keeps the credential
out of JavaScript's reach entirely, which `localStorage` can't.

### Follow-up
"What's the cost?"
→ A database read per authenticated request, and Redis becomes a hard dependency. Both acceptable
for what it buys.

### What I should NOT say
"JWTs are insecure." They're a different trade-off.

---

# AI & TESTING (Q33–36)

## Q33
### Interviewer
"You list the OpenAI API. Where do you use it, and why not just regex?"

### What a strong answer should contain
One place in the live pipeline: extracting five fields from the email body. And it's **off by
default** — `USE_AI=false`. The argument is about *how they fail*: a regex that doesn't match
returns null, which is honest; an LLM that doesn't know returns a confident-looking wrong answer.
So regex is the floor the system can always stand on and the model is the ceiling.

### Follow-up
"So how do you stop it being confidently wrong?"

### What I should NOT say
Oversell the AI. The flag-off-by-default framing is *stronger*.

---

## Q34
### Interviewer
"How do you stop the model hallucinating?"

### What a strong answer should contain
For dates, which matter most. It returned `2027-01-01` for an email that only said "in 2027" — it
invented the day and month to satisfy the format, and shape validation catches nothing because
that's a perfectly well-formed date. So `validateAIDate` extracts every day+month mention from
the source and keeps the candidate only if one corroborates it. If not, it's **dropped, not
replaced**, so it falls back to the regex date.

> A prompt is a request; a check is a guarantee.

### Follow-up
"Why not use JSON schema mode?"
→ That guarantees shape, which was never the problem. A schema can't express "this date must
appear in the input text."

### What I should NOT say
"I improved the prompt." That's a mitigation, not a fix.

---

## Q35
### Interviewer
"Your resume says 120 automated tests on 50+ real emails. Tell me about that."

### What a strong answer should contain
125 test declarations across 11 suites, about 214 at runtime because several are parametrized.
Almost all unit tests with mocked dependencies plus one supertest integration test — no database,
Redis or API key needed.

Then the emails, **honestly**: "I ran it against my own mailbox and a set of real TPO emails —
around fifty over development. That's where the interesting bugs came from. I didn't commit them
as fixtures because they contain other students' names and registration numbers, so what's in the
repo is the regression tests derived from them."

### Follow-up
"What's your best test?"

### What I should NOT say
🔴 "I have 50 test emails in the repo." Checkable and false.

---

## Q36
### Interviewer
"What's your best test?"

### What a strong answer should contain
The identity-gate regression suite. It doesn't replace the scorer — it *wraps* it with
`requireActual`, so real scoring still runs but its call history becomes observable. Then it
asserts the contradicting candidate was **never passed to the scorer at all.** Asserting on the
outcome alone can't distinguish "correctly vetoed" from "scored and happened to lose" — the
gate's contract is about control flow, so the assertion has to be too. And it's a sweep across
date deltas and confidence values, because the original bug was that *some* combination crossed
the threshold.

### Follow-up
"What can't you test?"
→ Transaction rollback. A mock has no rollback semantics, so that's a guarantee my unit tests
structurally cannot verify. Needs a real Postgres.

### What I should NOT say
"I test everything." Naming what you can't test is the stronger answer.

---

# CODESYNC (Q37–38)

## Q37
### Interviewer
"Tell me about CodeSync."

### What a strong answer should contain
An interview platform: video call and a Monaco editor side by side, four languages, run against
stdin, execution via Judge0 in an isolated container so I'm never running untrusted code on my own
infrastructure. Clerk for auth, Convex for the interview data with real-time subscriptions.

**Then pre-empt:** "One thing I'd correct on my own resume — the real-time layer is Convex and it
syncs interview state: scheduling, participants, status and feedback. The editor itself isn't
collaboratively synced; each side has its own Monaco instance."

### Follow-up
"How would you add collaborative editing?"
→ Yjs. A CRDT, not last-write-wins on a text field, because LWW loses characters when two people
type at once. Plus awareness for cursors.

### What I should NOT say
🔴 Claim real-time collaborative editing works. **Volunteer the correction.**

---

## Q38
### Interviewer
"How does code execution work, and is it safe?"

### What a strong answer should contain
The client POSTs to Judge0 with a language id, the source, stdin, and CPU and memory limits —
5 seconds and 128 MB. `wait=true` makes it synchronous. Judge0 runs it in an isolated container.
To be precise: that isolation is **Judge0's**, not mine — and using a service instead of running
untrusted code myself is exactly the decision.

**Then pre-empt:** "One thing that's wrong in that file: the RapidAPI key is hardcoded and the
call is made from the browser, so it's in the client bundle. It should be a server action with
the key in an environment variable, which also gives me somewhere to rate-limit. I've rotated it."

### Follow-up
"What if Judge0 is down?"
→ The fetch throws, it's caught, the output box shows an error, and video and the editor keep
working. Execution is a feature, not a dependency.

### What I should NOT say
🔴 Let them find the key. Say it first.

---

# CLOSING (Q39–40)

## Q39
### Interviewer
"What's the weakest part of your system?"

### What a strong answer should contain
Pick **one** and go deep. Best choice: the confidence score. "It's a hand-tuned heuristic, not a
calibrated probability — 0.6 is a judgement. What it buys me is a single ordered scalar that makes
'don't act' and 'don't overwrite something better' expressible at all, and the alternative was
acting on everything equally, which demonstrably destroyed data. With usage data I'd log every
decision alongside the human's eventual correction and fit it."

Alternatives: one email produces at most one event; the missing OAuth `state`; no locking.

### Follow-up
"What would you build next?"
→ The sweeper for orphaned pending emails, and multi-event extraction.

### What I should NOT say
"Nothing really." Or list ten weaknesses — pick one and be specific.

---

## Q40
### Interviewer
"Do you have any questions for me?"

### What a strong answer should contain
Two or three, specific, showing you thought about *their* system:
- "How do you handle background jobs — is there a standard queue across teams, or per service?"
- "When something like my false-merge bug happens in production here, what does the process look
  like — is there a postmortem culture?"
- "How much of a new engineer's first months is feature work versus understanding the existing
  system?"

### Follow-up
Whatever they say — ask one honest follow-up. It shows you were listening.

### What I should NOT say
"No, I'm good." Or salary/leave in a technical round.

---

# The five answers to rehearse out loud tonight

Time yourself. None should exceed 90 seconds.

| # | Question | The core line |
|---|---|---|
| **1** | Q16 — Why not just raise the threshold? | *"A weighted sum of non-negative terms cannot encode a veto."* |
| **2** | Q7 — Exactly-once? | *"No. At-least-once, so I made processing idempotent."* |
| **3** | Q2 — Tell me about the project | Problem → why CRUD fails → pipeline → the two hard parts |
| **4** | Q28 — Concurrent updates | *"Neither optimistic nor pessimistic locking — here's exactly what that means."* |
| **5** | Q37 — CodeSync real-time | *"One thing I'd correct on my own resume..."* |
