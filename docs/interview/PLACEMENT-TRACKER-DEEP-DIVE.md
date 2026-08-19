# Placement Intelligence System — Deep Dive

Written for one purpose: to survive a skeptical backend interviewer who has your resume open.

---

# 1. One-minute explanation

> "Placement season runs entirely on email. One round — say an Amazon online assessment — gets
> announced in one email, moved to a different date in another, and given a venue in a third.
> Students track that by hand across fifteen or twenty companies, and the usual failure isn't
> missing an email, it's working from the version that got superseded.
>
> So I built a backend that connects to Gmail once with OAuth, syncs new mail incrementally in
> the background, and processes each email through a queue. For each email it extracts the
> company, round, date, time and venue, then does two things that make it more than a parser:
> it decides whether that email describes a round it already knows, and it decides whether the
> new information is trustworthy enough to write.
>
> The recognition part is the interesting bit. It's three tiers, and there's a categorical
> identity check that vetoes a candidate whose round contradicts the incoming one before any
> scoring happens. And every extraction carries a confidence score, so a weaker observation
> can never overwrite a stronger one — below a threshold it doesn't touch anything at all, it
> parks the email for human review."

---

# 2. Two-minute explanation

> "The problem is that placement emails are incremental, inconsistent, partial and
> out-of-order. Any single message is a fragment. Absence of a field isn't a statement about
> that field. And a correction can be processed before the announcement it corrects.
>
> That's why CRUD doesn't work. CRUD has one write behaviour — last write wins — and that's
> correct when a human typed the value. Here every write is an *inference*, and inferences vary
> in quality. A date read from '16th August 2026' and a date read from 'sometime next week'
> are not equally good, and treating them as equal means the second destroys the first. That
> happened.
>
> So the architecture is: Gmail sync writes a raw Email row and enqueues a job. A BullMQ worker
> picks it up, derives ownership from the persisted row rather than the payload, cleans the
> body — which includes cutting off the quoted reply chain, because those carry real dates
> belonging to other events — and extracts five fields using regex plus an optional LLM merged
> field by field. It computes a confidence score from *how* each field was obtained, and it
> writes an extraction record regardless of what happens next.
>
> Then there's a viability gate: no resolvable company or no complete date, and the email is
> abandoned. Then recognition, three tiers — an exact identity key of company-round-date, a
> ±3-day temporal match with an identity gate in front of the scoring, and a ±30-day tier that
> only fires when there's exactly one candidate. Then the decision: low confidence creates a
> review entry and touches nothing existing; a match goes through four guards before any write;
> no match creates a new event.
>
> The update itself is field-level — only fields that actually changed are written, so a
> partial email can't blank a field it never mentioned — and it runs in a transaction with one
> audit row per change, so the event can always explain how it got its values. Attachments fan
> out to a second queue after the email succeeds.
>
> It's multi-user. Every query is scoped by owner, and that's enforced with composite foreign
> keys in Postgres so a child row can't disagree with its parent's owner."

---

# 3. Architecture — the actual current flow

Verified against the source. Every box below exists.

```
   Google ──────┐
                │ OAuth 2.0 (authorization code, offline access)
                ▼
      ┌─────────────────────────┐
      │  GmailAccount           │  refreshToken · historyId · userId
      └───────────┬─────────────┘
                  │
                  ▼
      ┌─────────────────────────┐        every 120s, sequential, overlap-guarded
      │  Gmail sync scheduler   │        gmail.scheduler.ts
      └───────────┬─────────────┘
                  │  full sync  (no cursor / expired cursor)
                  │  incremental (history.list from cursor)
                  ▼
      ┌─────────────────────────┐
      │  parseMessage (MIME)    │  body: text/plain → text/html → snippet
      │                         │  + attachment metadata
      └───────────┬─────────────┘
                  │  gmailMessageId already exists? ──► skip
                  ▼
      ┌─────────────────────────┐
      │  Email row + Attachment │  ONE nested Prisma create = one transaction
      │  rows  (PostgreSQL)     │
      └───────────┬─────────────┘
                  │
                  ▼
      ┌─────────────────────────┐
      │ email-processing queue  │  BullMQ / Redis (ioredis)
      │ { emailId, userId }     │  attempts 3 · exp backoff 2s
      └───────────┬─────────────┘
                  ▼
      ┌─────────────────────────────────────────────────────────────┐
      │ EMAIL WORKER  (separate process)                            │
      │                                                             │
      │  read Email by id → OWNER = email.userId (from the DB)      │
      │  payload userId disagrees? → UnrecoverableError (no retry)  │
      │                                                             │
      │  status = "processing"                                      │
      │    ├─ cleanEmail  → cut quoted chain, collapse whitespace   │
      │    ├─ extract     → regex + optional AI, merged per field   │
      │    │                 AI date validated against source text  │
      │    ├─ confidence  → weighted score − penalties              │
      │    ├─ createExtraction   (always)                           │
      │    ├─ VIABILITY GATE → abandon → status "ignored" ■         │
      │    ├─ matchEventV2 → exact | soft | loose | null            │
      │    └─ DECIDE → create review | guarded update | create      │
      │  status = "completed"   (or "failed" + failureReason)       │
      └───────────┬─────────────────────────────────────────────────┘
                  │  on success only
                  ▼
      ┌─────────────────────────┐
      │ attachment-processing   │  { attachmentId }  ·  jobId attachment-<id>
      └───────────┬─────────────┘
                  ▼
      ┌─────────────────────────────────────────────┐
      │ ATTACHMENT WORKER (separate process)        │
      │  download → store (UUID key) → markCompleted│
      │  → parser registry → parse → persist        │
      └─────────────────────────────────────────────┘

   Writes land in: Email · EmailExtraction · Event · EventUpdate · Attachment
```

---

# 4. Every arrow explained

### Google → GmailAccount (OAuth)
- **What:** `/gmail/auth` redirects to Google. `/gmail/callback` exchanges the code, verifies
  the ID token, upserts the `User` on `googleSub`, stores the refresh token, creates a session.
- **Why:** offline access is what lets sync run when nobody is logged in.
- **Can fail:** no `code` → 400. No `id_token` or no `refresh_token` → 500. Unverified email or
  disabled account → 403. Token exchange failure → 500, and **nothing is written** — every
  write happens after all validation.
- **Persisted:** `User`, `GmailAccount.refreshToken`, the Redis session.
- **Async:** no. Fully synchronous inside the request.

### Scheduler → sync
- **What:** `setInterval(GMAIL_SYNC_INTERVAL_MS)` — 120 s default. Fires one cycle immediately
  at startup, then on the interval.
- **Why:** unattended ingestion. An `isRunning` flag prevents overlapping runs when a cycle
  outlasts the interval.
- **Can fail:** the account fetch itself throws → caught, logged, the interval survives. One
  account throws → caught, counted, the loop continues to the next.
- **Persisted:** nothing directly.
- **Async:** it's a timer inside the API process, not a queue job. Two API instances would mean
  two schedulers — a known limitation.

### Sync → Gmail API → parseMessage
- **What:** full or incremental listing, then `messages.get` per id, then a recursive MIME walk
  for the body and attachment metadata.
- **Why:** the first version only read `payload.body.data`, which is empty for any multipart
  message — i.e. for basically every real email.
- **Can fail:** a 404 on the cursor → automatic full-sync fallback. Any other API error on a
  message → that message counted as failed, loop continues.
- **Persisted:** nothing yet.

### parseMessage → Email row
- **What:** `getEmailByGmailMessageId` short-circuits duplicates. Otherwise `createEmail` writes
  the Email and all its Attachment rows in **one nested Prisma create** — a single implicit
  transaction.
- **Why:** the email must be durable before any risky processing starts.
- **Can fail:** a database error aborts everything atomically. No half-written email with
  orphan attachments.
- **Persisted:** `Email` + `Attachment` rows, status `pending`.

### Email row → queue
- **What:** `enqueueEmailProcessing({ emailId, userId })`.
- **Why:** decouples ingestion from processing.
- **Can fail:** ⚠️ **if Redis is down the enqueue throws**, that message is counted failed, and
  the Email sits at `pending` forever. There is no sweeper. Honest known gap.
- **Async:** this is the async boundary.

### Queue → worker → owner derivation
- **What:** read the Email by id, take `userId` off the row, compare it against the payload's
  claim.
- **Why:** a queue is not an authenticated channel — anything with Redis access can enqueue.
  The payload's `userId` is a claim, and claims get checked.
- **Can fail:** mismatch → `UnrecoverableError`, permanently failed, **no retry**, because no
  retry fixes a forged payload or a broken invariant.

### Worker → clean → extract → confidence
- **What:** `cleanEmail` cuts at the first quote boundary and collapses whitespace; `extract`
  runs regex and (if `USE_AI=true`) the LLM, validates the AI's date against the source, merges
  field by field, and computes confidence.
- **Why:** quoted history is *a different document* carrying real dates for other events.
- **Can fail:** an AI error is caught and logged; `aiData` stays null and the pipeline proceeds
  on regex output alone. **The LLM is never a hard dependency.**
- **Persisted:** an `EmailExtraction` row, **always** — including for emails that get abandoned
  a few lines later.

### Extraction → viability gate
- **What:** `!isResolvedCompany(company) || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)` →
  status `ignored`, return.
- **Why:** an observation with no identity anchor cannot be reasoned about. And `"unknown"` is
  the literal placeholder extraction substitutes — which is *truthy*, so it once passed a
  truthiness check and created an event named "unknown" that then absorbed every later
  unresolved email.
- **Persisted:** `Email.processingStatus = "ignored"`. Nothing reaches the Event table.

### Gate → matching
- **What:** `matchEventV2(owner, data)` — three tiers, every candidate query scoped by owner.
- **Why:** recognition is a verdict, not a write. The matcher never mutates anything.
- **Can fail:** returns `null` — which is not a failure, it's an answer.

### Matching → decision → Event
- **What:** low confidence → create with `status: "review"`. Match → `updateEventService`. No
  match → create.
- **Can fail:** unique violation on `(userId, eventKey)` → Prisma `P2002` → the worker catches
  it, logs "Duplicate event detected", and **returns successfully** without retrying.

### Update → transaction → Event + EventUpdate
- **What:** one `prisma.$transaction` containing N `EventUpdate` inserts and one `Event` update.
- **Why:** an event whose values moved with no record of why is a state the domain forbids.
- **Can fail:** any step throws → full rollback → no partial write, no orphan audit row.

### Worker success → attachment queue
- **What:** `enqueueAttachmentJobs(emailId)` as the **last line** of `processEmailJob`.
- **Why:** it used to run at sync time, so failed emails still downloaded attachments. Now the
  rethrow on failure returns before this line is ever reached.

---

# 5. Database

Seven models. Detail in [07-DATABASE-DESIGN.md](07-DATABASE-DESIGN.md); here is what you must
be able to say from memory.

| Model | Role | Mutable? |
|---|---|---|
| `User` | Tenant root, keyed on `googleSub` | profile refreshed on login |
| `GmailAccount` | Mailbox + refreshToken + historyId | token, cursor |
| `Email` | Raw message + processing lifecycle | status only |
| `EmailExtraction` | What was *read*, + confidence + rawText | append-only |
| **`Event`** | The real-world round | **the only truly mutable row** |
| `EventUpdate` | field / oldValue / newValue / timestamp | append-only |
| `Attachment` | File metadata + download state + parse output | lifecycle columns |

**The five constraints to know cold:**
1. `@@unique([userId, eventKey])` — identity, **per owner**. It was global until the
   multi-user migration; that was a bug, because two students on the same mailing list produce
   the same key.
2. Composite FKs `(parentId, userId) → Parent(id, userId)` on `EventUpdate`, `Attachment`,
   `EmailExtraction`, `Email` — a child that disagrees with its parent's owner is
   **unrepresentable**, not merely incorrect.
3. `Email.gmailMessageId @unique` — ingestion dedupe.
4. `User.googleSub @unique` — the auth key. `User.email` has **no** unique constraint, because
   email is mutable and reassignable.
5. Indexes all lead with `userId` — because every query is already tenant-scoped.

**No FK exists between Email/EmailExtraction and Event.** The link is behavioural. Volunteer
that.

---

# 6. Matching — the chapter to know cold

## 6.1 The old approach

```
score = 0.5·dateProximity + 0.3·roundAgreement + 0.2·confidenceAlignment
accept if score >= 0.5
```

One scalar decided **both** *whether* any candidate was the same event **and** *which* candidate
it was.

## 6.2 Why it failed

The date term alone is `0.5 × 1.0 = 0.5` — **exactly the acceptance threshold.** An exact date
satisfied the bar with zero contribution from anything else.

## 6.3 Concrete failure examples

**The one that actually happened:**
```
Stored:   Auxia Software | PPT | 15 Aug | 15:45 | NLHC 1
Incoming: Auxia Software | OA  | 15 Aug | (venue to be shared)

dateProximity = 1.0  → 0.50
roundAgreement = 0   → 0.00     ("no support", NOT "evidence against")
confidenceAlign = ~0.7 → 0.14
                        ─────
                        0.64  ≥ 0.5  →  ACCEPTED
```
The OA was merged into the PPT. The PPT kept its label. The OA ceased to exist as a distinct
record, and nothing anywhere recorded that a contradicted attribute had been accepted.

**Two more of the same shape:**
- Same company running an Interview in the morning and a second Interview slot for a different
  batch the same day — merged.
- A well-established wrong-round event **out-ranking** the correct one, because confidence
  alignment competed on the same scale as round agreement. So even when the right candidate was
  present, the engine could pick the wrong one.

## 6.4 Why raising the threshold isn't enough

**This is the question that separates a good answer from a great one.**

The score is a sum of non-negative terms, so it is **monotone in each term**. That makes the
date term a *lower bound* on the total — no configuration of the other inputs can pull the
score back below it.

So:
- Raise the threshold to 0.6 → the exact-date-plus-decent-confidence case still passes (0.64).
- Raise it to 0.7 → you now reject *legitimate* matches where the round wasn't extracted, which
  is common.
- There is **no threshold** at which a contradiction outvotes a strong date match, because a
  contradiction was never expressible as a negative quantity. It was encoded as `0`, and `0`
  means *"no support"*.

> **A weighted sum of corroboration cannot encode a veto.** The engine was structurally
> incapable of disagreeing with itself.

That's a representational defect. You don't fix it by moving a constant.

## 6.5 The categorical identity gate

```ts
export type IdentityRelation = "AGREES" | "UNKNOWN" | "CONTRADICTS";

classifyRoundIdentity(candidateStage, incomingStage): IdentityRelation
passesIdentityGate(relation): boolean   // relation !== "CONTRADICTS"
```

Three outcomes, never a number. `resolveRound` normalises to lowercase and maps the `"unknown"`
sentinel, empty strings and whitespace to `null` — **so the sentinel never compares equal to
itself.** It marks "not extracted", not a round any company runs.

In `matchEventV2` the gate runs as a **complete pass** over all candidates before the ranking
loop starts. A vetoed candidate is logged with `outcome: "vetoed-before-similarity"` and never
reaches `scoreEventMatch`.

Note also: the tier-2 candidate query **deliberately does not filter on stage**. The engine has
to *see* the contradicting candidate in order to refuse it — and to be able to say that it did.

## 6.6 What establishes identity vs what merely ranks

| Attribute | Role |
|---|---|
| **company** | Establishes identity. It's the candidate query's filter at every tier — a different company is simply never a candidate. |
| **round / stage** | Establishes identity. Categorical, three-valued, vetoes. |
| **date** | **Both.** At tier 1 it's part of the identity key. At tier 2 it's the dominant *ranking* signal (weight 0.5) within an already-bounded window. At tier 3 it bounds the window. |
| **confidence** | **Only ranks.** Weight 0.2, as `min(incoming, existing)`. It can never admit a candidate. |
| **time, venue** | Neither. They're payload, not identity. They're never compared during matching — only during `detectChanges`. |

Be precise about date. Saying "date establishes identity" is right at tier 1 and wrong at
tier 2, and that nuance is exactly what the bug was about.

## 6.7 Where temporal matching happens

- **Tier 2:** `findNearbyEvents(owner, { company, date, windowDays: 3 })` — a Postgres
  `BETWEEN` on `date`. Then `scoreEventMatch` bands the proximity: 0 days → 1.0, ≤1 → 0.7,
  ≤3 → 0.5, >3 → early return with `score: 0, reason: "Date too far"`.
- **Tier 3:** `findByCompanyAndStage(owner, { company, stage, date, windowDays: 30 })` —
  `LOOSE_MATCH_WINDOW_DAYS`.

The bound is part of the repository **signature**, not a default — so a caller can't
reintroduce the unbounded query by omission. That's deliberate.

## 6.8 Where confidence enters matching

Exactly one place: `confidenceScore = min(incoming.confidence, event.confidence)`, weight 0.2,
inside `scoreEventMatch` — which only runs on candidates that already passed the gate.

**Why `min` and not average?** Because a match is only as trustworthy as its weaker side.
Averaging lets one very confident record drag a shaky one over the line.

## 6.9 What happens when things are ambiguous

| Situation | Behaviour |
|---|---|
| Round contradicts | Candidate vetoed before scoring. Logged. |
| Round unknown on either side | Candidate stays eligible — **silence is not denial**. |
| Two candidates both pass the gate | Both scored; highest wins; ties keep the first (`>` not `>=`). |
| Best score < 0.5 | No match at tier 2 → fall through to tier 3. |
| Tier 3 finds 2+ candidates | **No match.** Uniqueness is the entire identity claim there. |
| Tier 3 finds 0 candidates | No match. |
| Nothing matches anywhere | Return `null` → a new Event is created. |
| Extraction itself is unusable | Never reaches matching — the viability gate abandoned it. |
| Confidence below threshold | Match result is computed but **discarded**; a review event is created and nothing existing is touched. |

That last row is worth knowing precisely: `matchEventV2` is called *before* the low-confidence
check, so on the review path three candidate queries run and their result is thrown away.
Harmless, slightly wasteful, and exactly the kind of thing to volunteer as "something I'd tidy
up."

---

# 7. "Confidence-aware identity model" — word by word

Break the phrase apart when asked. It's the phrase most likely to be probed.

### "Identity"
*Is this the same real-world round?* It's a **fact about the world** the system tries to
**recognise**. It holds or it doesn't. It's determined by company + round + date, and the
domain model says **any two of the three are insufficient**.

### "Confidence"
*How much should I trust what I just read?* It's a **quantity the system computes**, from *how*
each field was obtained — not from what it says. An exact date scores higher than "next week",
an explicit venue higher than one inferred from an "at ..." phrase.

### Why they are different
Identity is **categorical and about the world**. Confidence is **continuous and about our
knowledge**. Conflating them is what caused the bug: a scoring function ended up making a
categorical judgement it couldn't represent.

### How they interact
Strictly ordered, with separated authority:
```
1. IDENTITY  (categorical)  — decides who is even eligible.        Confidence has no say.
2. SIMILARITY (continuous)  — ranks the eligible.                  Confidence is 20% of it.
3. DECISION   (threshold)   — decides whether to act at all.       Confidence decides alone.
4. UPDATE     (comparison)  — decides whether to overwrite.        Confidence decides alone.
```
So confidence never admits a candidate. It only ranks, and then it governs writing.

### When confidence is low (< 0.6)
Nothing existing is touched. A **new** Event is created with `status: "review"` and a
`reviewReason`. The reasoning: updating is risky, ignoring loses data, so surface it to a human.

### When new confidence < existing confidence
`return existing` — the update is skipped entirely. No fields written, no audit rows.

**Strictly less-than**, so equal confidence *does* update: two automated inferences of equal
quality should let the newer one through. Only *worse* information is refused.

### When information is contradictory
Two different mechanisms for two different layers:
- **On identity:** `CONTRADICTS` → veto, before scoring.
- **On values:** if the round agrees but the date differs, that's not a contradiction — it's a
  **reschedule**. Status becomes `rescheduled` and the `eventKey` is regenerated.

### When information is simply missing
Nothing happens to that field. `detectChanges` only reports a change when the incoming value
is neither `undefined` nor `null` and actually differs — and only reported fields make it into
the update payload. **A field the email didn't mention has no code path that can write it.**

The exception is intent: `venueMeta.isExplicit === true` with `value === null` means the email
*did* speak about the venue and there isn't one → **clear it**.

---

# 8. Contradictory merges — five concrete cases and the exact defence

The resume says the model *"prevents contradictory event merges"*. Here is what that means,
case by case.

### Case 1 — Different round, same company, same day
```
Stored:   auxia | PPT | 15 Aug
Incoming: auxia | OA  | 15 Aug
```
**Old:** 0.64 ≥ 0.5 → merged.
**Now:** `classifyRoundIdentity("PPT", "OA") → "CONTRADICTS"` → vetoed before `scoreEventMatch`
is called. Falls through to tier 3, which filters on `stage` in the query so the PPT isn't a
candidate there either. Result: a **new OA event**.
**Code:** `matching.utils.ts` → `classifyRoundIdentity`; the gate loop in `matching.service.ts`.

### Case 2 — A wrong-round candidate out-ranking the right one
```
Candidates: [ Interview @ 20 Aug, conf 0.95 ]   ← wrong round, very confident
            [ OA        @ 21 Aug, conf 0.55 ]   ← right round, 1 day off
Incoming:     OA        @ 20 Aug, conf 0.8
```
**Old:** Interview scored `0.5 + 0 + 0.2·0.8 = 0.66`; OA scored `0.35 + 0.3 + 0.2·0.55 = 0.76`
— close enough that a small change in confidence flips it. The engine could pick the wrong one.
**Now:** the Interview is vetoed and never scored, so the OA can't lose to it.
**Test:** `"selects the correct round even when the wrong round scores higher"`.

### Case 3 — Two rounds months apart merged as a "reschedule"
```
Stored:   amazon | OA | 12 March   (last cycle)
Incoming: amazon | OA | 18 September
```
**Old:** tier 3 was unbounded — same company, same stage, exactly one candidate → matched →
the update path saw a date change and marked it **rescheduled**, silently moving a March event
to September and destroying the March record.
**Now:** `LOOSE_MATCH_WINDOW_DAYS = 30` bounds the query, so the March event isn't a candidate.
Result: a new September event.
**Tests:** `"does not match a sole candidate from an earlier cycle (March vs September)"`,
plus boundary tests at exactly ±30 and ±31 days.

### Case 4 — The "unknown" event absorbing everything
```
Email with no resolvable company → extraction returns the literal string "unknown"
```
**Old:** `"unknown"` is truthy, so it passed the check, created an Event named `"unknown"`, and
that event then became a tier-3 candidate for **every** later unresolved email — collapsing
unrelated announcements into one row.
**Now:** the viability gate uses `isResolvedCompany()`, a type guard, and abandons the
observation before the key is generated, before any candidate query, before any write. The
email is marked `ignored`.
**Code:** `email.service.ts` viability gate; `email.parser.ts` → `isResolvedCompany`.

### Case 5 — Both sides unresolved, treated as agreement
```
Stored:   amazon | "unknown" | 20 Aug   (round never extracted)
Incoming: amazon | "unknown" | 20 Aug
```
A naive `candidate.stage === incoming.stage` returns `true` — two *unknowns* would "agree" and
assert identity from company + date alone, which is the exact thing the domain forbids.
**Now:** `resolveRound` maps the sentinel to `null`, and either side being `null` yields
`UNKNOWN`, never `AGREES`. The candidate stays eligible (silence isn't denial) but identity is
**not asserted** — it must then win on similarity like anything else.
**Test:** `"treats an unresolved round on the STORED event as UNKNOWN, not agreement"`.

### And one the system deliberately does NOT prevent
Two genuinely distinct rounds of the **same type** for the same company, 5 days apart, where
one was never seen before — tier 3 will match them within 30 days and mark it a reschedule.
That's the accepted residual risk of the weakest tier, bounded to 30 days precisely to keep it
small. **Say this if asked "so it's impossible now?"** — the honest answer is *"the whole class
of contradicted-round merges is impossible; a same-round temporal collision inside 30 days is
still possible, and that's the trade-off I chose."*

---

# 9. Field-level history

### What is stored
```prisma
model EventUpdate {
  id        Int
  userId    Int
  eventId   Int
  field     String     // "date" | "time" | "venue"
  oldValue  String
  newValue  String
  updatedAt DateTime @default(now())
}
```
One row **per changed field**, not one per update. So an email that moves the date and the venue
writes two rows.

Values are stringified — `null` becomes the literal `"null"` — so the column type stays simple
and "was cleared" is representable.

### Why not just overwrite the Event row?
Overwriting gives you `updatedAt` and nothing else. You can't answer:
- "When did this get rescheduled, and from what date?"
- "Did the venue ever get cleared, or was it never set?"
- "Which change ran when the event went wrong?"

And there's a domain reason: **an event whose values moved without a record of why is an event
that cannot explain itself.** For a system whose entire premise is adjudicated writes, that's
not an acceptable state.

### How I reconstruct what happened
```sql
SELECT field, "oldValue", "newValue", "updatedAt"
FROM "EventUpdate"
WHERE "eventId" = $1 AND "userId" = $2
ORDER BY "updatedAt";
```
Backed by the `(userId, eventId)` index. Replaying that from the creation values reproduces
the current state — which is also how you'd verify the audit is complete.

### What if EventUpdate succeeds but the Event update fails?
**It can't.** Both run inside one `prisma.$transaction`:

```ts
return prisma.$transaction(async (tx) => {
  for (const change of changes) {
    await tx.eventUpdate.create({ data: { eventId, userId: owner.userId, ...change } });
  }
  return tx.event.update({
    where: { id: eventId },
    data: { ...updateData, confidence: newConfidence },
  });
});
```

### What exactly is atomic
- ✅ All `EventUpdate` inserts + the `Event` update — **one atomic unit**.
- ✅ `createEmail`'s nested Attachment creates — one implicit transaction.
- ❌ `createExtraction` — a separate, independent write earlier in the pipeline.
- ❌ The OAuth callback's two writes (upsert User, link mailbox) — deliberately not
  transactional, because both are idempotent and the only observable interleaving is "a user
  with no mailbox", which is a legitimate state anyway.

### The honest concurrency caveat
Read Committed (Postgres default). **No row lock, no optimistic version column.** Two
concurrent updates to the same event could interleave — last commit wins on the row, but
**both** audit rows are still written, so the history stays complete even if the final value
isn't the one you'd predict.

In practice one email is processed at a time per event, so it hasn't occurred. The fix would be
`SELECT ... FOR UPDATE` inside the transaction, or a `version` column with an optimistic check.
**Say this proactively** — claiming concurrency safety you don't have is the fastest way to
lose credibility.

---

# 10. Gmail synchronization

### Full sync vs incremental

| | Full | Incremental |
|---|---|---|
| **When** | No `historyId`, or the stored one expired | `historyId` present and valid |
| **API** | `messages.list({ maxResults: 100 })` | `history.list({ startHistoryId, historyTypes: ["messageAdded"] })` |
| **Pagination** | ❌ none — capped at 100 | ✅ full, via `nextPageToken` |
| **Watermark** | `getLatestHistoryId()` **before** listing | taken from the history response |

### The cursor mechanism
`GmailAccount.historyId` — a per-mailbox monotonic cursor from Gmail. Stored per account, so
mailboxes sync independently. Written **last**, only after processing, so a crash leaves the old
cursor and the next run redoes that window.

### Why capture the watermark before listing
If you capture it after, a message that arrives *during* the listing gets a history id below the
new cursor and is never seen again. Capturing first means it's re-fetched next run, and
re-fetching is free because dedupe catches it.

> **Overlap is safe; gaps are not.**

### Cursor expiry
Gmail retains history for a limited window. Too old → `404`. `isHistoryIdExpired` checks
`code`, `status` and `response.status` for 404 and falls back to a full sync. Any other error is
rethrown.

### Duplicate emails
Three layers:
1. `getEmailByGmailMessageId` short-circuits before insert.
2. `Email.gmailMessageId @unique` is the actual guarantee.
3. `getHistoryChanges` collects ids into a `Set` — the history API can report the same message
   more than once.

### Ownership
`syncSingleMessage` writes `userId: account.userId` onto every Email. Ownership flows from the
mailbox that produced the observation. Never inferred, never taken from a request body.

🕘 The attachment worker used to call `getFirstGmailAccount()` — "whichever mailbox happens to
exist". Correct with one user, silently wrong with two. Fixed by putting `gmailAccountId` on
Email so the worker resolves `Attachment → Email → GmailAccount → refreshToken`.

### Access token vs refresh token
- **Access token:** ~1 hour. **Never stored.** Every helper calls
  `oauth2Client.setCredentials({ refresh_token })` and `googleapis` mints a fresh one on demand.
- **Refresh token:** long-lived, stored on `GmailAccount`. Deliberately never logged.

**Store renewable credentials, not temporary ones.**

### OAuth consent
`access_type: "offline"` + `prompt: "consent"`. Google issues a refresh token only on first
authorization; re-authorizing an already-approved account silently returns just an access
token, and `if (!tokens.refresh_token) throw` then fires. Forcing the consent screen makes it
reliable.

Also: during development, Google returned `403 access_denied` because the OAuth consent screen
was in Testing mode — an unverified app only admits explicitly-added test users. That's a
platform-configuration failure, not a code failure, and it's a good thing to be able to say.

### Failure handling summary
| Failure | Behaviour |
|---|---|
| One message fails | Counted in `stats.failed`, loop continues |
| One mailbox fails | Caught, logged, other mailboxes still sync; cursor **not** advanced |
| Account fetch fails | Caught; the interval survives |
| Cursor expired | Automatic full-sync fallback |
| Run overruns the interval | `isRunning` flag skips the next tick |
| Redis down at enqueue | ⚠️ Email stays `pending`, no job, **no sweeper** — known gap |

---

# 11. BullMQ

### Why a queue?
1. **Durability** — the email is persisted before any risky work; a crash loses a job, never an
   email.
2. **Retries** — 3 attempts, exponential backoff from 2 s, free.
3. **Latency** — an LLM call takes seconds; no HTTP connection should be held for that.
4. **Burst** — a sync run yields up to 100 emails at once.
5. **Isolation** — one poisonous email fails its own job.

### Why not synchronously?
It *was* synchronous originally. `POST /email` ran extraction, matching and the write inside the
request. A failure lost the email entirely — there was nowhere to retry from. And Gmail sync
produces batches, not single requests.

### What the producer does
`enqueueEmailProcessing({ emailId, userId })` with `attempts: 3`, exponential backoff from
2000 ms, `removeOnComplete: true`, `removeOnFail: false`. The `userId` is carried **only so a
disagreement is detectable** — it authorizes nothing.

### What the worker does
Reads the Email → derives the owner from the row → cross-checks the claim → runs the pipeline →
sets terminal status → fans out attachment jobs.

### If a worker crashes mid-job
BullMQ marks it stalled and re-delivers. The re-run recomputes everything from the raw body,
finds the same event by key, `detectChanges` returns `[]`, and nothing is written. The email row
may be left at `processing` until the re-run completes.

### If a job runs twice
Nothing happens the second time. See idempotency below.

### If Redis goes down
- **Enqueue** throws → the Email stays `pending` with no job. **No sweeper exists.** Honest gap;
  `getPendingEmails` / `getFailedEmails` exist in the repository, unused, for exactly this.
- **Workers** can't fetch jobs; jobs already in Redis are still there when it returns.
- **Sessions** are on a *separate* client — the API refuses to start at all if the session store
  is unreachable, because a process that starts without one answers every sign-in with an
  opaque 500.

### If OpenAI fails
Nothing visible. `extract()` catches it, logs `"AI failed: ..."`, and runs regex-only.
Confidence is typically lower (fewer fields resolved), which may route the email to review —
which is the correct degradation.

### After retries are exhausted
`markEmailFailed(reason)` has already written `processingStatus = "failed"` and
`failureReason`. The job lands in BullMQ's failed set and stays there (`removeOnFail: false`) so
it can be inspected. **There is no automatic dead-letter reprocessing.**

### Two failures deliberately NOT retried
| Case | Handling | Why |
|---|---|---|
| `P2002` unique violation | Swallowed, job succeeds | The desired end state — one event — already exists |
| Ownership mismatch | `UnrecoverableError` | Forged payload or broken invariant; no retry fixes either |

### How is processing idempotent?
By **construction**, not by a dedupe table:
- extraction is a pure function of the email body
- matching finds the same event by exact `eventKey`
- `detectChanges` returns `[]` when nothing differs → early return, no write, no audit row

The one non-idempotent write is `createExtraction` — a re-run appends a second row. Deliberate:
it's a log of "the extractor ran and produced this", and a second run genuinely is a second
event worth recording.

### ⚠️ Exactly-once?

> **"No. BullMQ is at-least-once. If a worker dies after doing the work but before
> acknowledging, the job is redelivered. So rather than chasing exactly-once — which you can't
> get across a queue and a database without distributed transactions or an idempotency-key
> table — I made processing idempotent. The system is designed to tolerate duplicate processing
> rather than to prevent it."**

Memorise that. Claiming exactly-once is the fastest way to lose a backend interviewer.

---

# 12. PostgreSQL / Prisma

### Why PostgreSQL?
The data is **relational and constraint-heavy.** Events belong to users, audit rows belong to
events, attachments belong to emails — and the correctness of the whole system rests on
constraints the database can enforce: a unique identity key per owner, composite foreign keys
that make cross-tenant rows unrepresentable. I also needed real transactions for the
update-plus-audit pair.

### Why not MongoDB?
> "Almost everything that keeps this system correct is a constraint. `@@unique([userId,
> eventKey])` is what makes a duplicate event *impossible* rather than merely unlikely, and the
> composite foreign keys are what make a cross-tenant row unrepresentable. In Mongo I'd be
> enforcing those in application code — which is exactly the layer that already had the bug.
> And the update-plus-audit pair needs a real multi-document transaction. Mongo can do that
> now, but it's the exception there and the default here."

If pushed on schema flexibility: *"the shape genuinely is fixed — five extracted fields — and
where I do need flexibility, `Attachment.parsedData` is a `Json` column. Postgres gives me
document storage where I want it without giving up constraints where I need them."*

### Why Prisma?
Type safety end to end — the generated client types flow into services, so a schema change
becomes a compile error rather than a runtime one. Migrations are versioned SQL I can read.
Interactive transactions (`$transaction(async tx => ...)`) are ergonomic.

**The trade-off I'd name:** Prisma generates queries I don't fully control. `findNearbyEvents`
does an exact company match plus a date range, and Postgres will use the `(userId, date)` index
and filter company in memory — with a hand-written query I'd have controlled that. At this data
volume it's irrelevant; at scale I'd add `(userId, company, date)` or drop to raw SQL for that
one query.

### Important models, relationships, constraints, indexes
See §5 above and [07-DATABASE-DESIGN.md](07-DATABASE-DESIGN.md).

**Why those indexes:** every index leads with `userId` because every query is already
tenant-scoped. `(userId, date)` serves both the matcher's window queries and the dashboard's
date sort. `(userId, status)` serves the review queue.

### Concurrent updates
Read Committed. **No optimistic locking. No row locking.**
- Two workers creating the same event → one wins, the other gets `P2002`, which is swallowed.
- Two workers updating the same event → they interleave; last commit wins on the row; both
  audit rows are written.

**Say it explicitly:** *"I don't use optimistic or pessimistic locking. Adding a `version`
column with a compare-and-set, or a `SELECT ... FOR UPDATE` inside the transaction, is what
I'd do if concurrent updates to one event became real."*

### The pooled/direct split (a good detail to drop)
Two connection strings:
- `DATABASE_URL` (**pooled**) → the Prisma Client at runtime, via `@prisma/adapter-pg`.
- `DIRECT_DATABASE_URL` (**unpooled**) → `prisma migrate`, via `prisma.config.ts`.

Migrate takes a **session-level advisory lock** to serialise concurrent deploys, and a
transaction pooler like PgBouncer can't hold one — it's acquired on one backend and released to
another. Running DDL through a transaction pooler is unsafe for the same reason.

Prisma 7 removed `url`/`directUrl` from the schema file entirely, so the split isn't in the
schema at all — it's expressed by which side reads which variable.

---

# 13. AI extraction

### Why use AI?
Because real emails don't follow patterns you can anticipate. Regex handles `"Amazon OA on 20th
Aug at 10 AM"`. It does not handle `"The pre-placement talk for Auxia Software will be held
tomorrow afternoon in the new lecture hall complex, followed immediately by the assessment."`

### Why not regex only?
Coverage. Every unanticipated phrasing is a silent miss.

### Why not AI only?
**The failure modes are different, and that's the whole argument.**

| | Regex | LLM |
|---|---|---|
| Deterministic | ✅ | ❌ |
| Handles unseen phrasing | ❌ | ✅ |
| Cost / latency | free, instant | paid, seconds |
| Works with no API key | ✅ | ❌ |
| **How it fails** | **returns nothing** | **returns something plausible and wrong** |

A regex that doesn't match gives you `null`, which is honest. An LLM that doesn't know gives you
a confident-looking wrong answer.

### What each handles
- **Regex:** structured announcements, explicit `venue:` lines, known platforms, day+month
  dates, AM/PM times, relative dates. It is the **floor**.
- **AI:** prose, unusual phrasing, implicit company names, vague times. It is the **ceiling**.

### Validation
Four layers, in order:
1. **Shape** — the AI Core's `JsonResponseParser` strips markdown fences and `JSON.parse`s,
   throwing a typed `MalformedResponseError` on failure.
2. **Evidence** — `validateAIDate` corroborates the candidate date against day+month mentions
   in the source text (run through `cleanEmail` first, so a date in the quoted thread can't
   authorise it). An unsupported date is **dropped, not replaced**, so the regex date is used.
3. **Merge** — field by field. The AI never returns a whole object that replaces the regex
   result.
4. **Confidence + gate** — bad extraction lowers confidence, and the viability gate abandons
   anything with no company or no full date.

### Invalid JSON
`MalformedResponseError` (carrying the raw text) → in the extraction path retries are disabled
(`maxAttempts: 1`) → caught by `extract()` → regex-only. In the AI Core's default policy,
malformed JSON *is* considered transient and retried up to 3 times with linear backoff.

### Garbage that parses
That's the interesting case, and it's why `validateAIDate` exists. Shape validation can't catch
`"2027-01-01"` for an email that only said "in 2027" — it's a perfectly well-formed date. The
evidence check can.

### Unavailable
Caught, logged, regex-only. `USE_AI` is `false` by default anyway, so this is the normal path.

### How confidence is assigned
Weighted sum over field scorers, then penalties:
```
date 0.35 · company 0.25 · time 0.20 · stage 0.10 · venue 0.10
+ 0.05 completeness bonus (company && date && stage)
− 0.10 company "unknown" · − 0.15 no venue · − 0.10 no time
clamp [0,1]
```
Scorers grade *how* a value was obtained: exact date 1.0, "tomorrow" 0.8, "next week" 0.5;
estimated time ×0.6; explicit venue 0.9, inferred 0.5, explicitly-invalid 0.3.

**Note:** confidence doesn't distinguish an AI-sourced field from a regex-sourced one. It grades
the *value's provenance in the text*, not which extractor produced it. Know that — it's a fair
question and the honest answer is "that would be a reasonable extra signal and I don't use it."

### How bad extraction is prevented from corrupting existing events
Five layers:
1. `validateAIDate` — an uncorroborated date never enters.
2. Viability gate — no company or no date → abandoned entirely.
3. Confidence < 0.6 → nothing existing is touched; a review entry is created.
4. `newConfidence < existingConfidence` → update skipped.
5. Field-level writes — only changed fields are in the payload, so an unmentioned field can't be
   blanked.

---

# 14. "50+ real emails / 120 automated tests"

Fully audited in [RESUME-DEFENSE-MAP.md §A8](RESUME-DEFENSE-MAP.md). Summary:

### The 120 tests — CONFIRMED, and conservative
- **125** explicit `it()` / `test()` declarations
- **~214** test cases at runtime (parametrized `.each` and loops expand)
- **11** suites

Almost all unit tests with mocked dependencies; one integration test (`email.api.test.ts`,
supertest against the real Express app). No database, Redis or API key needed.

If asked "exactly 120?": *"125 declarations across 11 suites, more at runtime because several
are parametrized. I rounded down."*

### The 50+ real emails — PARTIALLY CONFIRMED
- **Not** committed as fixtures. There is no fixtures directory and no `.eml` files.
- **Real** in the sense that the pipeline ran against a live mailbox:
  `backend/storage/attachments/` holds **11 real downloaded attachments** (8 PDF, 2 DOCX,
  1 XLSX), and `/storage` is gitignored.
- The Notion log documents specific real emails verbatim — the Auxia Software PPT+OA message,
  the shortlist email, the Bajaj Auto reply chain — and the bug each one exposed.
- ~52 distinct email-body string literals appear inline in the test files, derived from those
  real messages.

**Safe phrasing:**
> "I ran it against my own mailbox and a set of real TPO emails — around fifty over the course
> of development. That's where the interesting bugs came from. I didn't commit them as fixtures
> because they contain other students' names and registration numbers, so what's in the repo is
> the regression tests derived from them."

The privacy reason is genuine and lands well.

### Bugs this testing uncovered (all real, all in the suite)
1. A PPT and an OA on the same day merged into one event.
2. A partial email wiping time and venue.
3. `"venue: PFA seating plan"` unable to clear a stale venue.
4. The AI turning `"in 2027"` into `2027-01-01`.
5. A date read out of a quoted reply chain.
6. `"16th August 2025"` stored as 2026.
7. `"unknown"` scoring full confidence for company.
8. A sole candidate from a previous cycle matched as a reschedule.
9. Both sides `"unknown"` treated as round agreement.
10. An already-completed attachment reprocessed on retry.

### What is NOT covered
No real-database test, no BullMQ integration test, no frontend tests, and the two
document-intelligence extractors that bypass the AI Core. The first gap to close is a rollback
test for the update transaction — a mock has no rollback semantics, so that's a guarantee the
unit tests structurally cannot verify.
