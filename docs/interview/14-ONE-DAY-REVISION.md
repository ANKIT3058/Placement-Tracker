# 14 — One-Day Revision

The smallest and most important document. If you read one file, read this one.

---

## 30-second project explanation

> "A backend that connects to your Gmail, reads placement emails, and keeps one up-to-date list
> of your tests and interviews. The interesting part isn't parsing — it's deciding whether a new
> email is about an event I already have, and whether I should trust it enough to overwrite what's
> stored. Every extraction gets a confidence score, and low-confidence data goes to a review queue
> instead of into the database."

**The framing line:** *Inbox is the source of information. Event is the source of truth.
Confidence is permission to act.*

---

## 2-minute project explanation

> "Placement emails are incremental, inconsistent, partial and out-of-order. One round gets
> announced in one email, moved in another, given a venue in a third.
>
> That's why CRUD doesn't work. CRUD has one write behaviour — last write wins — and that's
> correct when a human typed the value. Here every write is an **inference**, and inferences vary
> in quality. A date from '16th August 2026' and a date from 'sometime next week' aren't equally
> good. Treating them equally means the second destroys the first — which happened.
>
> So: Gmail sync writes a raw Email row and enqueues a job. A BullMQ worker derives ownership from
> the persisted row rather than the payload, cleans the body — including cutting off the quoted
> reply chain, because those carry real dates belonging to other events — and extracts five fields
> with regex plus an optional LLM merged field by field. It scores confidence from *how* each
> field was obtained.
>
> Then a viability gate: no resolvable company or no complete date, and the email is abandoned.
> Then recognition — three tiers: an exact identity key of company-round-date, a ±3-day temporal
> match with a categorical identity gate in front of the scoring, and a ±30-day tier that only
> fires when there's exactly one candidate. Then the decision: low confidence creates a review
> entry and touches nothing existing; a match goes through four guards; no match creates a new
> event.
>
> The update is field-level, so a partial email can't blank a field it never mentioned, and it
> runs in a transaction with one audit row per change. It's multi-user, enforced with composite
> foreign keys in Postgres."

---

## Architecture in one diagram

```
Gmail ──OAuth──► scheduler (2 min) ──► save Email + attachment metadata
                                              │
                                    email-processing queue (BullMQ/Redis)
                                              │
                                    worker: derive owner FROM THE DB ROW
                                              │
              clean ──► extract (regex + optional AI) ──► confidence
                                              │
                    VIABILITY GATE ──► no company / no date → "ignored"
                                              │
              MATCH   exact  →  soft ±3d (identity gate)  →  loose ±30d (unique)
                                              │
              DECIDE  conf<0.6 → review │ matched → 4 guards → txn │ else → create
                                              │
                                        PostgreSQL
                                              │
                                    attachment queue → download · parse
```

**3 processes:** API (+ scheduler) · email worker · attachment worker.

---

## 5 core design decisions

1. **Identity before similarity.** A weighted sum of non-negative terms cannot encode a veto, so
   identity became categorical: AGREES / UNKNOWN / CONTRADICTS, run to completion before any
   scoring.
2. **Confidence-aware updates.** Highest trust wins, not last write — which buys
   order-independence for free.
3. **Field-level history in a transaction.** An event whose values moved with no record of why is
   a state the domain forbids.
4. **Idempotency by construction.** At-least-once delivery, so `detectChanges` returning `[]` is
   what makes a retry a no-op — not a flag.
5. **Ownership derived from the database.** A queue is not an authenticated channel.

---

## 5 strongest bugs/problems

| # | Problem | Resolution |
|---|---|---|
| 1 | PPT + OA same day merged into one event | Categorical identity gate before scoring |
| 2 | "Amazon OA on 20th Aug" wiped time and venue | Only *changed* fields enter the update payload |
| 3 | "venue: PFA seating plan" couldn't clear a stale venue | `VenueMeta { value, isExplicit }` carries intent |
| 4 | AI turned "in 2027" into `2027-01-01` | `validateAIDate` corroborates against source text |
| 5 | Production dashboard showed "No events yet" with 39 rows | OAuth callback terminated on the wrong origin — cookie stranded |

**Backups:** the quoted-reply-chain date · the "unknown" event that absorbed everything ·
confidence computed but never delivered.

---

## 10 dangerous resume claims

| Claim | The safe sentence |
|---|---|
| 🔴 "real-time code editing" (CodeSync) | **Not implemented.** *"The real-time layer syncs interview state, not the editor document."* |
| 🔴 Judge0 key | Hardcoded, client-side. **Rotate it.** *"It's in the client bundle — it belongs in a server action."* |
| 🔴 "50+ real placement emails" | *"Run manually against a real mailbox; not committed, they contain other students' personal data."* |
| 🔴 "Docker" | *"Compose runs my local Postgres; the app isn't containerised."* |
| 🟡 "Replaced a weighted-similarity approach" | *"The formula is unchanged — I replaced its authority."* |
| 🟡 "confidence-aware identity model" | Unpack it: identity = categorical fact; confidence = computed quantity; strictly ordered. |
| 🟡 "prevents contradictory merges" | *"Prevents the contradicted-round class; a same-round collision inside 30 days is still possible."* |
| 🟡 "OpenAI API" | *"Behind a flag, off by default — regex is the floor, the model is the ceiling."* |
| 🟡 "JWT" | *"I verify JWTs; I chose server-side sessions for my own auth, for revocation."* |
| 🟡 "Distributed Systems" | *"At-least-once and idempotency — not consensus or replication."* |

Full detail: [DANGEROUS-RESUME-CLAIMS.md](DANGEROUS-RESUME-CLAIMS.md)

---

## 15 likely questions

1. Why not just CRUD? → *incremental, inconsistent, partial, out-of-order; every write is an inference*
2. How do you know two emails describe the same round? → *exact key → ±3d gated → ±30d unique*
3. **Why not just raise the similarity threshold?** → *a monotone sum can't express evidence against*
4. Does the old formula still exist? → *yes — I replaced its authority, not the formula*
5. What establishes identity vs what ranks? → *company + round establish; date does both; confidence only ranks*
6. **Do you guarantee exactly-once?** → *No. At-least-once, so processing is idempotent*
7. What if the worker crashes mid-job? → *redelivered; re-run detects no change and writes nothing*
8. **You write to Postgres then enqueue to Redis — what if the enqueue fails?** → *dual-write problem; I have it; fix is a transactional outbox*
9. Why capture the sync watermark before listing? → *overlap is safe, gaps are not*
10. **Two workers update the same event — what happens?** → *no locking; they interleave; both audit rows still written*
11. Why Postgres over Mongo? → *the correctness rests on constraints the DB enforces*
12. Why does composite index order matter? → *leftmost-prefix rule; that's why every index leads with userId*
13. How is multi-tenancy enforced? → *required parameter + scoped query shape + composite FKs*
14. Is your OAuth callback CSRF-protected? → *Yes — `state` + PKCE S256, 10-min TTL, consumed before the token exchange. Writes also carry a double-submit CSRF token.*
15. Why sessions and not JWTs? → *revocation on the next request, not the next login*

---

## 10 technical facts I must remember

1. `CONFIDENCE_THRESHOLD = 0.6` · soft window **±3 days** · loose window **30 days** · match
   acceptance floor **0.5**
2. Confidence weights: **date 0.35 · company 0.25 · time 0.20 · stage 0.10 · venue 0.10**, +0.05
   completeness bonus
3. Match score: `0.5·date + 0.3·stage + 0.2·min(incomingConf, eventConf)`; date bands **1.0 / 0.7
   / 0.5**, >3 days → 0
4. Tier confidences returned: exact **1.0** · soft = the score · loose **0.6**
5. `eventKey = "company|stage|date"`, unique **per user** — `@@unique([userId, eventKey])`
6. Job options: `attempts: 3`, exponential backoff from **2000 ms**, `removeOnFail: false`;
   attachment jobs use `jobId: attachment-<id>`
7. Sessions: **7-day rolling idle**, **30-day absolute** ceiling
8. Gmail scheduler: **120000 ms**; **both** full sync and incremental sync are **paginated**
   on `nextPageToken` (`maxResults` is a per-page limit); email reconciler **60 s / 5 min**,
   attachment reconciler **60 s / 15 min / 100 rows**
9. Tests: backend **52 suites · 1038 tests** (Jest), client **18 files · 331 tests** (Vitest) — 1369 total, all passing
10. Model: **`gpt-4o-mini`, temperature 0**, `USE_AI=false` by default

---

## 6 things I must NEVER falsely claim

1. 🔴 **"Exactly-once processing."** It's at-least-once. Say idempotent instead.
2. 🔴 **"Collaborative real-time code editing in CodeSync."** Local React state. Correct it
   yourself, first.
3. 🔴 **"I have 50 test emails committed in the repo."** No fixtures directory exists.
4. 🔴 **"I deleted the similarity formula."** It's still in `matching.utils.ts`. You replaced its
   *authority*.
5. 🔴 **"Concurrent updates are safe / the transaction handles it."** No locking, no version
   column. A transaction gives atomicity, not mutual exclusion.
6. 🔴 **"The background worker runs in production."** It does not run *continuously*. Both
   workers are executed as **manually dispatched GitHub Actions drains**. Say: *"the queue
   architecture runs continuously and produces durable jobs; the consumer has no permanent
   host yet."* → [ch. 15](15-RUNTIME-AND-DEPLOYMENT.md)

**Also don't claim:** the app is containerised · refresh tokens are encrypted · the systemd
units are installed anywhere · Document Intelligence has ever run in production · you built
the Judge0 sandbox.

**And stop claiming these *gaps* — they were closed:** the OAuth callback has no `state`
(it has `state` + PKCE) · there is no sweeper for `pending` emails (there are two
reconcilers) · nothing consumes `attachment-processing` (a manual drain does).

---

## FINAL 15-MINUTE REVISION

Read only this, right before you walk in.

### 1. The pitch
> "Placement emails describe one round across four or five messages that arrive out of order and
> contradict each other. My system treats each email as *evidence about a round* rather than a row
> to insert, and adjudicates every write."

### 2. The pipeline
`Gmail sync → save Email → queue → clean → extract → confidence → viability gate → match →
decide → transaction → attachments`

### 3. The three tiers
`exact key` → `±3 days, identity-gated` → `±30 days, only if unique`

### 4. The four update guards
1. `status === "confirmed"` → stop *(authority is a kind, not a quantity)*
2. no changes → stop *(idempotency)*
3. lower confidence → stop *(highest trust wins)*
4. only changed fields written, then one transaction with the audit rows

### 5. The five numbers
`0.6` threshold · `±3` soft · `30` loose · `0.5` match floor · weights `.35/.25/.20/.10/.10`

### 6. The story to lead with
> "A morning PPT and an afternoon test on the same day got merged into one event. The matcher used
> a weighted sum, and a weighted sum of non-negative terms can express 'no support' but never
> 'evidence against' — a contradicted round contributed zero and the date term alone already met
> the threshold. So I split recognition into categorical admission followed by continuous ranking.
> A constraint is a rule; a threshold is a coincidence a future retune removes."

### 7. Six lines to say verbatim
- *"A weighted sum of non-negative terms cannot encode a veto."*
- *"Silence is not denial."*
- *"Highest trust wins, not last write."*
- *"Authority is a kind, not a quantity."*
- *"Overlap is safe; gaps are not."*
- *"A duplicate is visible and recoverable. A false merge is silent and destroys the information
  you'd need to undo it."*

### 8. Three honest answers, ready to go
- **Exactly-once?** *"No — at-least-once, so I made processing idempotent."*
- **Locking?** *"Neither optimistic nor pessimistic. Here's exactly what that means..."*
- **CodeSync real-time editing?** *"One thing I'd correct on my own resume..."*

### 9. If you don't know something
Say *"I'd have to check."* It costs nothing and beats a guess every time.

### 10. Breathe
You built this. The bugs are real, you found them, and you understood *why* they happened. That
last part is the whole thing.
