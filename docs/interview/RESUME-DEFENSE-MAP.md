# RESUME DEFENSE MAP

Every technical claim on the resume, audited against the source code.

**Confidence legend**

| Tag | Meaning |
|---|---|
| **CONFIRMED BY CODE** | Say it freely. The code proves it. |
| **PARTIALLY CONFIRMED** | Mostly true. Know the caveat before you say it. |
| **HISTORICAL** | Was true; the code has moved on. Say it in past tense. |
| **PLANNED** | Not built. **Never claim it.** |
| **AMBIGUOUS** | Can't be proven from the repo. Soften or avoid. |

---

# PART A — PLACEMENT INTELLIGENCE SYSTEM

---

## A1. "Reconciles fragmented placement announcements — a round announced, moved and re-venued across separate emails — into one authoritative record per real-world event."

### What it means
One placement round gets described across several emails. The system merges them into a
single row that always reflects the latest trustworthy information.

### Where it is implemented
- `backend/src/modules/email/email.service.ts` → `processEmail` (the orchestrator)
- `backend/src/modules/matching/matching.service.ts` → `matchEventV2` (recognition)
- `backend/src/modules/event/event.service.ts` → `updateEventService`, `detectChanges`
- `backend/prisma/schema.prisma` → `Event`, `EventUpdate`

### How it works
Each email becomes an `Email` row (evidence) and an `EmailExtraction` row (what was read).
The pipeline then asks *which* `Event` this describes, and *whether* it's allowed to write.
Matching goes exact key → ±3 days → ±30 days. If it matches, only the fields that actually
changed are written, guarded by confidence, inside a transaction with audit rows.

### Why I made this choice
Because the natural CRUD model — parse and insert — produced duplicates and, worse, wiped
correct fields when a partial email arrived. The durable entity had to be the real-world
round, not the message.

### Interview questions
1. What does "authoritative record" actually mean here?
2. What happens when two emails disagree?
3. What if an email arrives out of order?
4. How do you know it's the same round?
5. Can it ever produce two records for one round?
6. Show me the reconciliation code.

### Strong answer
> "The Event row is the authoritative record. Emails are evidence about it. When a new email
> arrives, the system decides two things: which round it's about, and whether it's allowed to
> write. Being 'authoritative' means every write is adjudicated — a field the email didn't
> mention isn't touched, and a weaker observation can't overwrite a stronger one. Every
> accepted change is written as an audit row in the same transaction, so the record can
> explain how it got its values."

### Deeper follow-up
*"So if two emails disagree, which one wins?"*
> "The one with higher confidence, not the later one. Confidence measures how the value was
> obtained — an exact date beats 'sometime next week'. If they're equal, the newer one wins.
> And if a human confirmed the event, no automated update touches it at all."

### Code I should know
`processEmail`, `matchEventV2`, `detectChanges`, `updateEventService`

### Confidence
**CONFIRMED BY CODE** — with one caveat: *"one record per real-world event"* is a design
goal, not a guarantee. When matching is ambiguous the system deliberately creates a duplicate
rather than risk a false merge. Say that if pushed; it's a strength, not a weakness.

---

## A2. "Connected mailboxes using Google OAuth 2.0"

### What it means
The user grants read access to their Gmail once; the server stores a refresh token and can
read the mailbox afterwards without them being present.

### Where it is implemented
- `backend/src/modules/gmail/gmail.service.ts` → `generateAuthUrl`, `getTokens`,
  `verifyGoogleIdToken`, `getGmailAddress`
- `backend/src/modules/gmail/gmail.controller.ts` → `gmailAuthController`, `gmailCallbackController`
- `backend/src/modules/gmail/gmail.repository.ts` → `connectGmailAccount`
- `backend/src/modules/gmail/gmail.route.ts`

### How it works
Authorization-code flow. `/gmail/auth` redirects to Google with `access_type: "offline"`,
`prompt: "consent"`, and scopes `openid`, `userinfo.email`, `userinfo.profile`,
`gmail.readonly`. `/gmail/callback` exchanges the code for tokens, verifies the ID token
(signature, `aud`, `exp`, issuer allowlist, `sub`, `email_verified`), upserts the `User` on
`googleSub`, stores the refresh token on `GmailAccount`, and establishes a session.

### Why I made this choice
`offline` because background sync has to work when nobody is logged in. `prompt: consent`
because Google only returns a refresh token on first authorization — re-authorizing silently
returns only an access token, and the connect then fails for a reason that looks like nothing
is wrong. `gmail.readonly` because the system never needs to send or modify mail.

### Interview questions
1. Which OAuth flow? Why not implicit or PKCE?
2. Why offline access?
3. What exactly do you store, and what do you deliberately not store?
4. What happens when the access token expires?
5. How do you verify the person is who they say they are?
6. What's the difference between authentication and authorization here?
7. Is there a CSRF risk in your callback?

### Strong answer
> "Authorization code flow, because the exchange happens server-to-server using the client
> secret and the token never touches the browser. I request offline access so Google returns
> a refresh token — that's what lets background sync run when the user isn't there. I store
> only the refresh token, never access tokens, because those expire in an hour and can always
> be re-minted. And I verify the ID token's signature, audience, expiry and issuer rather than
> just calling the userinfo endpoint — userinfo only proves *some* token is valid, not that
> the response is a signed statement about my client's user."

### Deeper follow-up
*"Is your callback protected against CSRF?"*
> **Answer honestly:** "No — the `state` parameter is missing. That was tolerable while the
> callback issued nothing, but now that it creates a session it's a real gap, and it's my top
> fix. The mitigation would be a signed, single-use `state` stored server-side and verified on
> return."

That honesty will score better than a bluff. The gap is documented in the code's own comments.

### Code I should know
`generateAuthUrl`, `verifyGoogleIdToken`, `gmailCallbackController`, `connectGmailAccount`

### Confidence
**CONFIRMED BY CODE.** The missing `state` parameter is a known gap — see
[DANGEROUS-RESUME-CLAIMS.md](DANGEROUS-RESUME-CLAIMS.md).

---

## A3. "built incremental Gmail synchronization"

### What it means
After the first sync, the system asks Gmail "what changed since last time?" instead of
re-listing the mailbox.

### Where it is implemented
- `backend/src/modules/gmail/gmail.service.ts` → `getLatestHistoryId`, `getHistoryChanges`,
  `getRecentMessages`
- `backend/src/modules/gmail/gmail.sync.service.ts` → `syncGmailAccount`, `syncSingleMessage`
- `backend/src/modules/gmail/gmail.scheduler.ts` → `startGmailScheduler`
- `GmailAccount.historyId` in `backend/prisma/schema.prisma`

### How it works
Each `GmailAccount` stores a `historyId` cursor.
- **No cursor** → full sync. Capture the watermark via `getLatestHistoryId` **before**
  listing, then list up to 100 messages.
- **Cursor present** → `users.history.list({ startHistoryId, historyTypes: ["messageAdded"] })`,
  paginated through `nextPageToken`, ids collected into a `Set`.
- **Cursor expired (404)** → `isHistoryIdExpired` detects it and falls back to full sync.
- Finally, write the new `historyId`.

### Why I made this choice
Re-listing the mailbox every two minutes is wasteful and hits quota. The cursor makes each run
proportional to what actually changed. And capturing the watermark *before* listing means the
failure mode is re-fetching a message (absorbed by dedupe) rather than skipping one (absorbed
by nothing). **Overlap is safe; gaps are not.**

### Interview questions
1. What's a `historyId`?
2. Why capture the watermark before listing rather than after?
3. What happens when the cursor expires?
4. How do you avoid processing the same message twice?
5. Why polling instead of push notifications?
6. What if the sync crashes halfway through?
7. Is there a limit on the first sync?

### Strong answer
> "Gmail gives each mailbox a `historyId`, which is a monotonic cursor. I store it per
> mailbox. On the next run I call the history API from that cursor and only get messages added
> since. If there's no cursor I do a full sync, and if Gmail rejects the cursor with a 404 —
> which happens because history is only retained for a window — I fall back to a full sync
> automatically.
>
> The detail I'd point out is that on a full sync I capture the watermark *before* listing. If
> you capture it after, a message that arrives during the listing gets a history id below the
> new cursor and is never seen again. Capturing first means it's re-fetched next run, and
> re-fetching is free because the unique constraint on `gmailMessageId` catches it."

### Deeper follow-up
*"Why not Gmail push notifications with Pub/Sub?"*
> "That's the right answer at scale and the sync logic wouldn't change — only what triggers
> it. I polled because it needs no cloud infrastructure and, for a single user checking every
> two minutes, the difference isn't observable. If I were running this for real users I'd move
> to `users.watch`."

*"What if the sync crashes halfway?"*
> "The `historyId` is written last, only after processing, so a crash leaves the old cursor in
> place and the next run redoes that window. Messages already saved are skipped by the unique
> constraint. Per-message failures are counted and the loop continues rather than aborting."

### Code I should know
`syncGmailAccount` (the full-vs-incremental decision + fallback), `getHistoryChanges`,
`syncSingleMessage` (the dedupe short-circuit)

### Confidence
**CONFIRMED BY CODE.** One caveat: full sync uses `maxResults: 100` with **no pagination**, so
a brand-new mailbox bootstraps from its most recent 100 messages, not its full history.
Incremental sync *is* fully paginated. Know this — it's an easy "gotcha" question.

---

## A4. "background processing using BullMQ"

### What it means
Email processing doesn't happen inside the HTTP request or inside the sync loop. Jobs go on a
Redis-backed queue and separate worker processes consume them.

### Where it is implemented
- `backend/src/infrastructure/queue/queues.ts`, `backend/src/infrastructure/redis/redis.ts`
- `backend/src/modules/email/email.producer.ts` → `enqueueEmailProcessing`
- `backend/src/workers/email.worker.ts`
- `backend/src/modules/attachment/attachment.queue.ts`, `attachment.worker.ts`
- `backend/src/shared/constants/queue.constants.ts`

### How it works
Two queues: `email-processing` (`{ emailId, userId }`) and `attachment-processing`
(`{ attachmentId }`). Both use `attempts: 3` with exponential backoff from 2 s,
`removeOnComplete: true`, `removeOnFail: false`. Attachment jobs additionally use a
deterministic `jobId` of `attachment-<id>`. Two dedicated worker entry points, run as separate
processes (`npm run worker:email`, `npm run worker:attachment`).

### Why I made this choice
Five reasons: the email is persisted before any risky work, so a crash loses a job and never
an email; retries with backoff come free; an LLM call takes seconds and shouldn't hold an HTTP
connection; a sync run produces up to 100 emails at once and the queue flattens that; and one
poisonous email fails its own job without affecting the other 99.

### Interview questions
1. Why a queue at all?
2. What happens if the worker crashes mid-job?
3. What if a job runs twice?
4. Do you guarantee exactly-once processing?
5. What if Redis goes down?
6. What happens after retries are exhausted?
7. Why two queues instead of one?
8. How do you prevent duplicate attachment jobs?

### Strong answer
> "The main reason is durability. The email row is written before anything risky starts, so
> the queue is only ever losing *work*, never *data* — the row is still there with its
> processing status. On top of that I get retries with backoff, I keep a multi-second LLM call
> out of the request path, and one bad email can't take down a batch."

### Deeper follow-up
*"Do you guarantee exactly-once processing?"*
> **The answer that matters most in this whole document:**
> "No. BullMQ is at-least-once — if a worker dies after doing the work but before acking, the
> job is redelivered. So instead of chasing exactly-once, I made processing idempotent.
> Extraction is a pure function of the email body, matching finds the same event by its
> identity key, and `detectChanges` returns an empty list when nothing differs — so the second
> run writes nothing and creates no audit row. The system is designed to tolerate duplicate
> processing rather than to prevent it."

Never say "exactly-once". It's wrong and an interviewer will catch it.

### Code I should know
`enqueueEmailProcessing` (job options), `email.worker.ts` (owner derivation + P2002 handling),
`enqueueAttachmentProcessing` (deterministic jobId), `processEmailJob`

### Confidence
**CONFIRMED BY CODE.**

---

## A5. "Designed a multi-stage event recognition pipeline combining exact matching, temporal matching, and ambiguity handling"

### What it means
Three tiers of decreasing evidence strength, stopping at the first sufficient answer — and
when none of them is confident, the system deliberately declines to match.

### Where it is implemented
`backend/src/modules/matching/matching.service.ts` → `matchEventV2`
`backend/src/modules/matching/matching.utils.ts` → `classifyRoundIdentity`, `passesIdentityGate`, `scoreEventMatch`
`backend/src/modules/event/event.repository.ts` → `findByEventKey`, `findNearbyEvents`, `findByCompanyAndStage`
`backend/src/shared/constants/config.ts` → `LOOSE_MATCH_WINDOW_DAYS`

### How it works — map each resume word to real code

| Resume word | Actual mechanism |
|---|---|
| **exact matching** | Tier 1: `eventKey = "company\|stage\|date"`, looked up with `findByEventKey`. Returns confidence 1.0. |
| **temporal matching** | Tier 2: `findNearbyEvents(company, ±3 days)`, then identity gate, then a date-weighted similarity score with a 0.5 floor. Tier 3: `findByCompanyAndStage(company, stage, ±30 days)`. Both tiers are *bounded by time*. |
| **ambiguity handling** | Three distinct behaviours: a `CONTRADICTS` candidate is vetoed before scoring; tier 3 requires `looseMatches.length === 1` and refuses when 2+ candidates are in range; and the whole pipeline returns `null` when nothing qualifies, which creates a new event rather than guessing. |

### Why I made this choice
Because "is this the same round?" has a cheap deterministic answer most of the time (tier 1)
and only needs judgement in the minority of cases. Tiering means the expensive, fallible logic
runs only when the cheap logic has already failed.

### Interview questions
1. Walk me through the three stages.
2. What makes tier 1 "exact"?
3. What does "temporal" mean — how wide is the window and why?
4. What does "ambiguity handling" actually do?
5. Why does tier 3 require exactly one candidate?
6. What happens if all three miss?
7. Why 3 days and 30 days?

### Strong answer
> "Tier one is an exact identity key — company, round, date joined into a string, with a unique
> index behind it. If that hits, all three identity attributes agree and there's nothing to
> judge.
>
> Tier two is temporal: same company within ±3 days, because a round often gets re-announced
> with a slightly different date. Candidates get ranked, not just filtered.
>
> Tier three is the weakest: same company and same round within 30 days, and it only matches
> if there is **exactly one** candidate — because at that point the entire identity claim rests
> on uniqueness.
>
> Ambiguity handling is the part I care about most. If two candidates are in range at tier
> three, it refuses. If a candidate's round contradicts the incoming round, it's vetoed before
> it's even scored. And if nothing qualifies, it returns nothing and a new event is created. A
> duplicate is visible and recoverable; a false merge isn't."

### Deeper follow-up
*"Why 30 days and not unbounded?"*
> "Because that tier's identity claim is 'there is exactly one candidate', and uniqueness is
> only meaningful inside a plausible range. Unbounded, a company's first OA is trivially
> unique — so the tier fired most confidently exactly where it had the least evidence, and
> merged rounds months apart into a single reschedule. 30 days is wider than the ±3-day tier,
> so it still catches real reschedules, but narrow enough to exclude cross-cycle collisions."

### Code I should know
`matchEventV2` end to end — you should be able to narrate all three tiers from memory.

### Confidence
**CONFIRMED BY CODE.**

---

## A6. "Replaced a weighted-similarity approach with a confidence-aware identity model that prevents contradictory event merges"

**This is the single most important line on the resume. Expect the deepest questioning here.**

### What it means
The old matcher decided identity with one weighted score. It couldn't express "this is a
different thing", so it merged distinct rounds. The new design separates a categorical
identity decision from a continuous ranking score.

### Where it is implemented
- `backend/src/modules/matching/matching.utils.ts` → `IdentityRelation`,
  `classifyRoundIdentity`, `passesIdentityGate`, `scoreEventMatch`
- `backend/src/modules/matching/matching.service.ts` → the gate loop before the ranking loop
- `docs/06_ADR/ADR-006_Identity_Precedes_Similarity.md`
- Regression tests: `backend/src/modules/matching/__tests__/matching.service.test.ts`

### How it works
```
score = 0.5·dateProximity + 0.3·roundAgreement + 0.2·confidenceAlignment,  accept if ≥ 0.5
```
That formula **still exists** — but its authority changed. It now runs only on candidates that
have already passed a categorical gate:

```ts
classifyRoundIdentity(candidate.stage, incoming.stage) → "AGREES" | "UNKNOWN" | "CONTRADICTS"
passesIdentityGate(relation) → relation !== "CONTRADICTS"
```

A `CONTRADICTS` candidate is dropped **before** `scoreEventMatch` is ever called.

**Be precise about this distinction.** If you say "I replaced the formula", an interviewer who
opens `matching.utils.ts` will find it and think you overstated. The correct phrasing is *"I
removed the formula's authority to establish identity."*

### Why I made this choice
Because the bug was representational, not a mis-tuned constant. The score is a sum of
non-negative terms, so it's monotone in each — the date term alone was worth exactly the
threshold, and no configuration of the other inputs could pull it back down. A mismatched
round contributed `0`, and `0` means *no support*, not *evidence against*. **A weighted sum of
corroboration cannot encode a veto.**

### Interview questions
1. What was the old approach, exactly?
2. Give me a concrete failure it produced.
3. Why not just raise the threshold?
4. What is "identity" versus "similarity"?
5. Which attributes establish identity? Which only rank?
6. Where does confidence enter?
7. Does the old formula still exist?
8. How do you know the fix works?

### Strong answer
> "The old matcher summed three weighted signals — date proximity, round agreement, confidence
> alignment — and accepted anything over 0.5. The date term alone was 0.5 times 1.0, which is
> exactly the threshold. So same company, same date, different round was accepted: a morning
> pre-placement talk and an afternoon online assessment merged into one record.
>
> Raising the threshold doesn't fix it, and that's the interesting part. The function is
> monotone in every term, so a mismatched round contributes zero — which means 'no support',
> not 'evidence against'. There's no threshold at which a contradiction can outvote a strong
> date match, because the contradiction was never expressible as a negative quantity in the
> first place.
>
> So I split it. Admission is categorical — AGREES, UNKNOWN, or CONTRADICTS — and runs to
> completion first. A contradiction vetoes the candidate outright. Only the survivors get
> scored, and the score now just ranks them. The formula still exists; what changed is that it
> no longer has the authority to establish identity."

### Deeper follow-up
*"Why is UNKNOWN not treated as a contradiction?"*
> "Because an email that didn't state a round has said nothing about identity. Reading silence
> as disagreement is the same mistake in the opposite direction. It's the same rule I apply on
> the update path — a missing venue doesn't mean 'no venue', it means 'this email didn't
> mention venue'."

*"How do you know the fix works?"*
> "There's a regression sweep that runs every combination of date delta and confidence with a
> contradicting round and asserts no match — and crucially, it asserts the scorer was **never
> called**. An assertion on the outcome alone can't distinguish 'correctly vetoed' from
> 'scored and happened to lose.' The gate's contract is about control flow, so the assertion
> has to be too."

### Code I should know
`classifyRoundIdentity` (including why the `"unknown"` sentinel maps to `null` and never
compares equal to itself), the gate loop in `matchEventV2`, `scoreEventMatch`

### Confidence
**CONFIRMED BY CODE** — with the phrasing caveat above. Say *"removed its authority"*, not
*"deleted the formula"*.

---

## A7. "preserves field-level history"

### What it means
Every accepted change is recorded as `field / oldValue / newValue / timestamp`, not just an
`updatedAt` on the row.

### Where it is implemented
- `backend/prisma/schema.prisma` → `EventUpdate`
- `backend/src/modules/event/event.service.ts` → `detectChanges`, and the `$transaction` block

### How it works
`detectChanges` returns a list of `{ field, oldValue, newValue }`. Inside a single
`prisma.$transaction`, one `EventUpdate` row is inserted per change and then the `Event` is
updated. Both, or neither.

### Why I made this choice
Because "the value changed" and "why the value changed" are both needed. An event whose values
moved with no record of why is an event that can't explain itself — and when debugging a wrong
merge, the history is the only thing that tells you what happened.

### Interview questions
1. What exactly do you store?
2. Why not just overwrite the row?
3. How do you reconstruct the timeline?
4. What if the audit insert succeeds but the event update fails?
5. Is it in a transaction? What's atomic?
6. Does the history record which email caused the change?

### Strong answer
> "Each accepted change becomes an `EventUpdate` row with the field name, old value, new value
> and timestamp, written inside the same transaction as the event update. So either the event
> moved and can explain itself, or nothing happened. Overwriting alone would give me an
> `updatedAt` and no way to answer 'when did this get rescheduled, and from what?'"

### Deeper follow-up
*"Can you tell which email caused a given change?"*
> **Be honest:** "No — there's no foreign key from `EventUpdate` back to the `Email`. The link
> is behavioural, not relational. I can correlate by timestamp against `EmailExtraction`, but
> that's inference, not a join. The fix is an `event_emails` join table recording the event,
> the email, the match type and the score — that was in my original design and I never built
> it."

### Code I should know
The `prisma.$transaction` block in `updateEventService`; the `EventUpdate` model.

### Confidence
**CONFIRMED BY CODE.** The missing email→event link is the caveat.

---

## A8. "Validated extraction and event matching on 50+ real placement emails using 120 automated tests"

**Two separate claims. They have different confidence levels. Know which is which.**

### Claim 8a — "120 automated tests"

**Where:** 11 suites under `backend/src/**/__tests__/`.

**The actual numbers, verified:**

| | Count |
|---|---|
| Explicit `it(...)` / `test(...)` declarations | **125** |
| Test cases at runtime (parametrized `.each` and loops expanded) | **~214** |
| Test suites | **11** |

Breakdown by suite (explicit → runtime):

| Suite | Explicit | Runtime |
|---|---|---|
| `matching.service.test.ts` | 37 | ~60 |
| `attachment.repository.test.ts` | 3 | ~42 |
| `parser.test.ts` | 18 | ~28 |
| `date-evidence.test.ts` | 20 | 20 |
| `event.service.test.ts` | 13 | ~20 |
| `document-processing.service.test.ts` | 15 | ~18 |
| `email.service.test.ts` | 7 | ~14 |
| `attachment.queue.test.ts` | 4 | 4 |
| `confidence.test.ts` | 3 | 3 |
| `gmail.service.test.ts` | 3 | 3 |
| `email.api.test.ts` | 2 | 2 |

**Verdict: CONFIRMED BY CODE, and conservative.** 120 sits safely below both 125 and 214. If
asked "is it exactly 120?" say: *"125 test declarations across 11 suites — more at runtime,
because several are parametrized. I rounded down."*

**Types:** almost entirely unit tests with dependencies mocked, plus one integration test
(`email.api.test.ts`, supertest against the real Express app with Prisma/queue/auth mocked).
No database, no Redis, no API key required to run them.

### Claim 8b — "50+ real placement emails"

**This one is PARTIALLY CONFIRMED. Know the caveat.**

**What the repo proves:**
- `backend/storage/attachments/` contains **11 real downloaded attachments** (8 PDF, 2 DOCX,
  1 XLSX) — direct evidence the pipeline ran end to end against a real mailbox.
- Test files contain ~52 distinct email-body string literals used as extraction inputs.
- The Notion export documents real emails verbatim (Auxia Software PPT + OA, the shortlist
  email, the Bajaj Auto reply chain) and the bugs each one exposed.

**What the repo does NOT prove:**
- There is **no fixtures directory**, no `.eml` files, no committed corpus of 50 emails.
- The real emails were validated **manually** — pasted through `POST /email` or synced from a
  live mailbox — and the *bugs they revealed* were then turned into unit tests.

**How to say it safely:**
> "I ran the pipeline against my own mailbox and a set of real TPO emails — around fifty over
> the course of development. That's where the interesting bugs came from: the quoted reply
> chain, the multi-event email, the 'PFA seating plan' venue. I didn't commit those as
> fixtures because they contain other students' names and registration numbers, so what's in
> the repo is the regression tests derived from them, plus the attachments the pipeline
> actually downloaded."

**Do NOT say:** "I have a corpus of 50 test emails in the repo." That's checkable and false.

The privacy reason is genuine and is a *good* answer — those emails contained student names,
registration numbers, and branches.

### Interview questions
1. What kinds of tests? Unit or integration?
2. What does a test actually assert?
3. What's your best test?
4. What bugs did testing uncover?
5. Where are the 50 emails?
6. What's your coverage?
7. What isn't tested?

### Strong answer (on bugs uncovered)
> "The tests came out of real failures, so each one pins a specific bug. The venue pair —
> 'explicit null clears' versus 'no mention preserves' — pins the intent-aware update design.
> The date-evidence suite exists because the model turned 'in 2027' into 2027-01-01. And the
> biggest one is a parametrized sweep across date deltas and confidence values asserting that
> a contradicting round can never match — that came from a real false merge where a PPT and an
> OA on the same day became one event."

### Deeper follow-up
*"What's your test coverage percentage?"*
> "I don't measure line coverage — it's not instrumented. I'd rather describe what's protected:
> matching, extraction and the update decision are covered densely because that's where the
> judgement lives. What isn't covered is anything needing a real database or a real queue. The
> gap I'd close first is a rollback test for the update transaction, because a mock has no
> rollback semantics — that's a guarantee my unit tests structurally cannot verify."

### Code I should know
`matching.service.test.ts` (the wrapped-scorer technique), `attachment.repository.test.ts`
(the in-memory fake table), `jest.config.cjs`

### Confidence
- "120 automated tests" → **CONFIRMED BY CODE**
- "50+ real placement emails" → **PARTIALLY CONFIRMED** (real, manual, not committed)

---

# PART B — PLACEMENT TRACKER TECHNOLOGY LIST

*"Technologies: Node.js, Express.js, TypeScript, PostgreSQL, Prisma ORM, Redis, BullMQ, Gmail
API, OAuth 2.0, OpenAI API, Jest, Docker."*

| Technology | Depth in the codebase | Confidence |
|---|---|---|
| **Node.js** | 3 processes, ESM/NodeNext, top-level await in `server.ts` | CONFIRMED |
| **Express.js** | v5, 4 route modules, session + CORS + trust-proxy middleware | CONFIRMED |
| **TypeScript** | `strict: true`, discriminated unions, type guards, generics (`structuredCompletion<T>`) | CONFIRMED |
| **PostgreSQL** | 7 models, 18 migrations, composite FKs, composite unique indexes | CONFIRMED |
| **Prisma ORM** | v7 + `@prisma/adapter-pg`, interactive transactions, nested creates, pooled/direct split | CONFIRMED |
| **Redis** | Two clients, two libraries, for two different purposes | CONFIRMED |
| **BullMQ** | 2 queues, 2 workers, retries, backoff, deterministic jobIds, `UnrecoverableError` | CONFIRMED |
| **Gmail API** | messages.list/get, history.list, getProfile, attachments.get, MIME walking | CONFIRMED |
| **OAuth 2.0** | Full authorization-code flow + ID-token verification | CONFIRMED (see `state` gap) |
| **OpenAI API** | `gpt-4o-mini`, behind a provider abstraction. **Off by default (`USE_AI=false`)** | **PARTIALLY CONFIRMED** — see below |
| **Jest** | 11 suites, manual mocks, `requireActual` wrapping, parametrized suites | CONFIRMED |
| **Docker** | **`docker-compose.yml` runs Postgres only.** No app Dockerfile. | **PARTIALLY CONFIRMED** — see below |

## B1. OpenAI — the caveat

`USE_AI` defaults to `false`. The system runs fully on deterministic patterns; the LLM is an
optional enhancement.

**Say it this way:**
> "The LLM path is behind a feature flag and it's off by default. That was deliberate — regex
> is the floor the system can always stand on, and the model is the ceiling for phrasings I
> didn't anticipate. It also means the whole test suite runs without an API key. When it's on,
> the results merge field by field and the AI's date is validated against the source text
> before it's accepted."

That's a *stronger* answer than "I use GPT for extraction." It shows you thought about
dependency risk.

## B2. Docker — the caveat

`backend/docker-compose.yml` defines **one service: `postgres:16`** on port 5435. There is no
`Dockerfile` for the backend, no containerised worker, no compose service for Redis.

**Say it this way:**
> "Docker Compose runs my local Postgres — that's it. The app isn't containerised; it deploys
> to Render from source. I'd list Docker as 'I use it for local infrastructure', not 'I
> containerised the application', because that's what's true."

**Do NOT** describe a multi-container setup or claim the app is containerised.

---

# PART C — CODESYNC

Source: `D:\Projects\arklyte\CodeSync` (Next.js 15, React 19, Convex, Clerk, Stream, Monaco,
Judge0). Full detail in [CODESYNC-INTERVIEW.md](CODESYNC-INTERVIEW.md).

## C1. "Remote technical interview platform pairing a live video call with an in-browser code editor and multi-language code execution."

**Where:** `src/components/MeetingRoom.tsx` (resizable split: video left, editor right),
`src/components/CodeEditor.tsx`, `convex/interviews.ts`.

**Confidence: CONFIRMED BY CODE.** Video (Stream) and editor (Monaco) genuinely share one
screen via `ResizablePanelGroup`, and the editor supports JavaScript, Python, Java and C++.

## C2. "Built collaborative interview platform integrating video conferencing, real-time code editing, and multi-language code execution."

### ⚠️ THE MOST DANGEROUS CLAIM ON YOUR ENTIRE RESUME

**"real-time code editing" is NOT implemented.**

In `src/components/CodeEditor.tsx`:
```ts
const [code, setCode] = useState(selectedQuestion.starterCode[language]);
```
The editor's content lives in **local React state**. There is no Convex document for it, no
Yjs, no CRDT, no operational transform, no WebSocket sync of editor content. **Each
participant sees their own editor. Typing is not shared.**

Convex *is* used for real-time sync — but of **interviews, users and comments**
(`convex/interviews.ts`, `convex/users.ts`, `convex/comments.ts`), not the code.

**Confidence: NOT FOUND** for collaborative editing. **CONFIRMED** for video + execution.

### How to handle it
**Best option — reword the bullet tonight** to something true, e.g.:
> "Built an interview platform pairing Stream video with an in-browser Monaco editor and
> Judge0-backed multi-language execution, with Convex real-time sync for interview scheduling,
> roles and feedback."

**If you can't reword it, and you're asked "how does the real-time editing work?":**
> "I should be precise there — the real-time layer is Convex, and it syncs the interview state:
> scheduling, participants, status transitions and interviewer feedback, all live via Convex
> subscriptions. The editor itself isn't collaboratively synced — each side has their own
> Monaco instance and they share it verbally over the call. Adding shared editing would mean a
> CRDT like Yjs, or storing the document in Convex and debouncing writes, and I'd go with Yjs
> because last-write-wins on a text field loses characters when two people type."

Answering that way turns an exposure into a design discussion. **Volunteering the correction
is far better than being caught.**

## C3. "Integrated Judge0 for sandboxed code execution and Convex for real-time synchronization."

**Judge0: CONFIRMED BY CODE** — `src/components/CodeEditor.tsx` → `runCode()` POSTs to
`judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true` with a language-id map
(JS 63, Python 71, Java 62, C++ 54), `cpu_time_limit: 5`, `memory_limit: 128000`, and `stdin`.
It checks `status.id === 3` for success.

**Two caveats you must know:**

1. **"Sandboxed" is Judge0's property, not yours.** Judge0 runs submissions in isolated
   containers with CPU and memory limits. You *consumed* that; you didn't build it. Say
   "Judge0 runs it sandboxed, which is exactly why I used a service instead of running
   untrusted code myself."

2. 🔴 **The RapidAPI key is hardcoded in the source file and the call is made from the
   browser.** So the key is committed to the repo *and* shipped to every visitor. If an
   interviewer opens the file, they will see it. **Rotate that key tonight** and, if you have
   time, move the call into a Next.js server action or route handler so the key stays
   server-side. Even if you can't fix it before tomorrow, know about it — being able to say
   *"the key is client-side, which is wrong; it belongs behind a server action"* is far better
   than being shown it.

**Convex: PARTIALLY CONFIRMED** — real-time sync is real, but for interview/user/comment data,
not the code editor. See C2.

## C4. "Clerk" (authentication)

**CONFIRMED.** `clerkMiddleware()` in `src/middleware.ts`, `ConvexClerkProvider`, and a
svix-verified Clerk webhook at `convex/http.ts` → `/clerk-webhook` that syncs `user.created`
into Convex via `users.syncUser`. Convex validates Clerk JWTs through `convex/auth.config.ts`.

**Two honest gaps to know:**
- `convex/interviews.ts` → `updateInterviewStatus` has **no `getUserIdentity()` check**, unlike
  every other mutation. Any authenticated caller could patch any interview's status.
- `convex/users.ts` → `getUsers` returns **all users** to any authenticated caller.

If asked "how is authorization enforced?", answer: *"Every Convex function checks
`ctx.auth.getUserIdentity()` — except `updateInterviewStatus`, which I noticed is missing it.
That's a real gap: it should verify the caller is an interviewer on that interview."* Owning it
reads as rigour.

---

# PART D — OTHER RESUME ITEMS

## D1. Skills list
Defended in [SKILLS-DEFENSE.md](SKILLS-DEFENSE.md). The two to be careful about:
- **"Distributed Systems"** under *Areas* — you have queues, workers, at-least-once delivery
  and idempotency. You do **not** have consensus, sharding, replication or partition
  tolerance. Frame it as *"the distributed-systems problems I actually hit were at-least-once
  delivery and idempotency"*.
- **JWT** — you use Clerk's JWTs in CodeSync (verified by Convex) and Google's ID token
  (a JWT) in Placement Tracker. You do **not** hand-roll JWT auth; Placement Tracker uses
  server-side sessions. Say *"I've verified JWTs — Google ID tokens and Clerk's — but for my
  own session layer I chose server-side sessions over JWTs, because revocation matters more
  to me than statelessness."*

## D2. LeetCode Biweekly Contest 185 — rank 1,588 / 39,261
Nothing to defend in code. Top ~4%. Expect a DSA question to follow it — see
[CS-FUNDAMENTALS-MAP.md](CS-FUNDAMENTALS-MAP.md).

---

# QUICK REFERENCE — the five sentences to have ready

1. **Reconciliation:** *"The Event is the authoritative record; emails are evidence; every
   write is adjudicated."*
2. **Identity model:** *"A weighted sum of non-negative terms cannot encode a veto, so identity
   had to become categorical."*
3. **BullMQ:** *"At-least-once delivery, so I made processing idempotent rather than claiming
   exactly-once."*
4. **Incremental sync:** *"Overlap is safe; gaps are not — so I capture the watermark before
   listing."*
5. **Tests:** *"125 declarations across 11 suites, about 214 at runtime; the real emails drove
   the bugs, and the bugs became the tests."*
