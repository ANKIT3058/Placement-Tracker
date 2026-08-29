# 01 — The Project as a Story

This is the narrative version. If you can tell this well, most follow-up questions answer
themselves.

---

## Problem

During placement season, everything happens over email.

The placement cell sends one email announcing a company's Pre-Placement Talk. Two days
later another email moves the online test. A third email finally says where it is. A fourth
attaches the shortlist as a PDF. Multiply that by 10–30 companies running at once.

No single email contains the truth. The truth is what you get after reading all of them in
order and mentally merging them. Every student does that merge by hand, in their head.

And the failure mode is not "I never got the email." It's **"I read the email, and I was
working from the version that got superseded."**

---

## Why normal CRUD was not enough

A CRUD app would be: parse email → insert row. That breaks immediately, for four reasons.

**1. Emails are incremental.** Any one email is a fragment. "Venue: TPO" is a complete
message and describes nothing on its own.

**2. Emails are inconsistent.** The same round is written differently by different senders
on different days. Deciding two emails describe *one* real round is a judgement, not a
lookup.

**3. Emails are partial — and absence is not a statement.** An email correcting the venue
says nothing about the time. If you write the whole extracted object to the row, `time =
null` silently destroys a time that was correct. Most emails are partial, so this happens
constantly.

**4. Emails arrive out of order.** A correction can be processed before the announcement it
corrects. So "last write wins" is wrong: the last write is not the best write.

That last point is the core of it. In a normal CRUD app a human typed the value, so the
newest value is the most correct one. Here **every write is an inference**, and inferences
vary in quality. A date read from "Interview on 16 August 2026" and a date read from
"sometime next week" are not equally good. Treating them equally means the bad one destroys
the good one.

So the durable thing in the system is not the email. It's the **real-world round**. Emails
are evidence about it.

---

## Initial design (🕘 Historical)

The first version was as simple as it sounds:

```
POST /email  →  regex extraction  →  INSERT into events
```

Synchronous. One request, one insert. Regex only. No matching, no confidence, no updates —
a new email always produced a new row.

It worked on the three test emails I wrote myself.

---

## Problems discovered on real emails

Then I pasted actual TPO emails in, and everything broke at once:

| What happened | Why |
|---|---|
| Duplicate events everywhere | Nothing checked whether the round already existed |
| Time and venue silently wiped | Partial email → `null` → written straight to the row |
| A morning PPT and an afternoon test merged into one row | Matching used company + date and ignored the round |
| "16th August 2025" stored as 2026 | Regex didn't capture the year; a "bump into the future" rule fired |
| Venue came out as `"pfa seating plan"` | Greedy regex swallowed the rest of the sentence |
| Company came out as `"for"`, `"list"`, `"unknown"` | No validation on the extracted string |
| Confidence stayed high for `company = "unknown"` | The scorer only checked string length |
| An event landed on a date that appeared nowhere in the email | The date was read out of the quoted reply chain below it |
| The AI turned "in 2027" into `2027-01-01` | It invented the missing day and month |

None of these are parsing bugs you fix with a better regex. They are all the same shape:
**the system was acting on information it had no right to trust.**

---

## Architecture evolution

Each step below is: what existed → what broke → what changed → what that bought.

### Step 1 — From "insert" to "recognise, then decide"

```
Initial   POST /email → regex → INSERT
Problem   Every email created a duplicate event
Change    Introduced eventKey = company|stage|date, and a matching step
          before any write
Gained    Deduplication, and the ability to UPDATE an existing round
```
✅ Current. `src/modules/event/event.utils.ts`, `src/modules/matching/matching.service.ts`

### Step 2 — From "write the object" to "write only what changed"

```
Initial   Update wrote every extracted field to the row
Problem   "Amazon OA on 20th Aug" → time=null, venue=null → wiped good data
Change    detectChanges() compares field by field; only changed, non-null
          fields go into the update payload
Gained    Partial emails became safe. Updates became idempotent.
```
✅ Current. `src/modules/event/event.service.ts` → `detectChanges`

### Step 3 — From "value" to "value + intent"

```
Initial   extractVenue returned string | null
Problem   "venue: will be shared after the PPT" and "no venue mentioned"
          both produced null, so the first one could never CLEAR a stale venue
Change    VenueMeta = { value, isExplicit }. isExplicit=true with value=null
          means "the email spoke about venue, and there isn't one"
Gained    The system can distinguish silence from denial
```
✅ Current. `src/modules/email/email.parser.ts` → `VenueMeta`

### Step 4 — From "trust everything" to "quantify trust"

```
Initial   All extracted data treated equally
Problem   A vague "evening" overwrote an exact "17:00"
Change    Confidence scoring: a weighted 0–1 score per extraction, based on
          HOW each field was obtained, not what it says
Gained    Three new abilities: refuse weak updates, route weak extractions
          to human review, and rank match candidates
```
✅ Current. `src/modules/extraction/confidence.utils.ts`

### Step 5 — From "first match wins" to "best match wins"

```
Initial   if (candidates.length === 1) use it
Problem   Multiple nearby candidates → arbitrary pick
Change    Score every candidate on date proximity, round agreement and
          confidence alignment; take the best above a 0.5 floor; return a
          human-readable reason string with it
Gained    Deterministic selection + explainability for debugging
```
✅ Current. `src/modules/matching/matching.utils.ts` → `scoreEventMatch`

### Step 6 — From "similarity decides identity" to "identity gates similarity" (ADR-006)

```
Initial   One weighted score decided BOTH whether a candidate was the same
          event AND which candidate to pick
Problem   The date term alone (0.5 × 1.0) exactly met the 0.5 threshold, so
          same company + same date + DIFFERENT round was accepted. A weighted
          sum of non-negative terms cannot express "evidence against".
Change    Two phases with separated authority. Admission is categorical:
          AGREES / UNKNOWN / CONTRADICTS. A contradiction vetoes the candidate
          before it is ever scored. Only survivors get ranked.
Gained    The system can now DISAGREE with itself. Failure moved from "silent
          merge" to "visible duplicate".
```
✅ Current. `src/modules/matching/matching.utils.ts`, `docs/06_ADR/ADR-006_Identity_Precedes_Similarity.md`

### Step 7 — From "synchronous request" to "queue + workers"

```
Initial   POST /email did the whole pipeline inside the request
Problem   An LLM call inside an HTTP request; a failure lost the email; no
          retries; and Gmail sync produces 100 emails at once, not one
Change    Persist the email first, enqueue a job, return 202. A separate
          worker process runs extraction/matching/decision with BullMQ retries
Gained    Durability, retries with backoff, and ingestion decoupled from
          processing
```
✅ Current. `src/modules/email/email.producer.ts`, `src/workers/email.worker.ts`

### Step 8 — From "paste an email" to "connect a mailbox"

```
Initial   Manual paste only (POST /email)
Problem   Nobody pastes 30 emails a day
Change    Google OAuth with offline access → store the refresh token →
          background scheduler syncs every 2 minutes using Gmail's history
          API as a cursor
Gained    Unattended ingestion, incremental instead of re-listing everything
```
✅ Current. `src/modules/gmail/`

### Step 9 — From "one user" to "multi-tenant" (RFC-001)

```
Initial   No login. One implicit user. Every query global.
Problem   The moment two mailboxes exist, one user's events become another's
          match candidates
Change    Google identity → server-side sessions in Redis → TenantContext
          threaded as an explicit parameter into every service → every
          repository query scoped by userId → composite foreign keys in
          Postgres so a child row cannot disagree with its parent's owner
Gained    Real multi-user isolation, enforced at the database, not just in code
```
✅ Current. `src/modules/auth/`, `backend/prisma/migrations/20260802*`

---

## Current system (✅ what actually runs)

Three processes:

1. **API server** (`src/server.ts`) — Express 5, sessions, auth, event/email/gmail routes,
   plus the in-process Gmail sync scheduler.
2. **Email worker** (`src/workers/email.worker.ts`) — consumes `email-processing`.
3. **Attachment worker** (`src/modules/attachment/attachment.worker.ts`) — consumes
   `attachment-processing`.

And the pipeline for one email:

```
Gmail sync (or manual POST /email)
   → save Email row (+ attachment metadata) in one implicit transaction
   → enqueue { emailId, userId }
   → worker re-derives the owner from the saved row
   → clean the body (drop quoted reply chains)
   → extract: regex + optional LLM, merged field by field
   → score confidence
   → save an EmailExtraction row (always — this is the audit of what was read)
   → VIABILITY GATE: no real company or no full date → mark email "ignored", stop
   → MATCH: exact key → soft (±3 days, identity-gated) → loose (±30 days, unique)
   → DECIDE:
        confidence < 0.6      → create an event with status "review"
        matched               → safe update + EventUpdate rows, in one transaction
        no match              → create a new event
   → enqueue attachment jobs (only after the email succeeded)
```

Storage: PostgreSQL via Prisma 7 (pg adapter), Redis for BullMQ **and** for sessions (two
separate clients, deliberately — see [ch. 06](06-ASYNC-JOBS-ATTACHMENTS-AND-AI.md)).

---

## What I personally learned

Only things this project actually forced:

1. **"Null" is not one thing.** Missing, unknown, and explicitly-none are three different
   facts, and collapsing them into one value causes silent data loss. That realisation
   produced `VenueMeta`, and later the `AGREES / UNKNOWN / CONTRADICTS` identity model —
   the same lesson in two places.

2. **A weighted score cannot encode a constraint.** A sum of non-negative terms is monotone:
   every term can only push the total up. So no term can veto. When the thing you're
   deciding is categorical, the representation has to be categorical too.

3. **Pick which failure you want.** Duplicates and false merges are not symmetric. A
   duplicate is visible and you can delete it. A false merge is invisible and destroys the
   information you'd need to undo it. Every threshold in the matcher is set to fail toward
   the duplicate.

4. **Recency is a bad proxy for correctness** when every write is an inference. Replacing
   "last write wins" with "highest trust wins" also gave order-independence for free.

5. **A tool's config is part of your system.** Prisma 7 dropping `url` from the schema,
   ESM vs CommonJS, ioredis's `maxRetriesPerRequest: null` for BullMQ, connect-redis v10
   requiring node-redis rather than ioredis — several days went into these, and none of it
   is business logic.

6. **The origin that terminates the OAuth callback owns the session cookie.** Learned the
   expensive way in production.

---

## 2-minute interview answer (say it like this)

> "It started because placement season runs entirely on email, and one round gets described
> across four or five emails that arrive out of order and contradict each other. I was
> tracking maybe fifteen companies by hand and I kept working off stale information.
>
> The first version was just regex plus an insert. That fell apart on real emails —
> duplicates everywhere, and worse, a partial email like 'Amazon OA on 20th August' would
> wipe the time and venue that a previous email had correctly set.
>
> So the design changed shape. Instead of 'parse and store', the durable thing became the
> real-world round, and each email became evidence about it. That gave me three problems to
> solve: is this email about a round I already know, how much should I trust what I read,
> and what am I allowed to write.
>
> For the first one there's an identity key — company, round, date — plus fuzzy tiers for
> near-date matches. And an identity gate: if the stored round contradicts the incoming
> round, the candidate is vetoed before scoring even runs. That came from a bug where a
> morning PPT and an afternoon test got merged, because a weighted score can express 'no
> support' but not 'this is a different thing'.
>
> For the second, every extraction gets a confidence score based on how the value was
> obtained — an exact date scores higher than 'next week', an explicit venue higher than an
> inferred one. Below the threshold, the system doesn't touch anything; it creates a review
> entry for a human.
>
> And for the third, updates are field-level and confidence-guarded: a weaker observation
> can't overwrite a stronger one, and a field the email didn't mention is never touched.
> Every accepted change is written as an audit row in the same transaction.
>
> Around that: Gmail OAuth with a background incremental sync, BullMQ for processing, a
> second queue for attachments, and multi-user isolation enforced with composite foreign
> keys in Postgres.
>
> On deployment, the honest version: the frontend is on Vercel and the API on Render, and
> the API runs continuously — it polls Gmail and runs two reconcilers that repair anything
> persisted but never queued. The queue **workers** have no permanent host yet; I drain each
> queue by dispatching a GitHub Actions workflow by hand. That's a cost decision, and it's
> one environment variable away from being a continuously running worker — the same compiled
> entrypoint runs both ways."
