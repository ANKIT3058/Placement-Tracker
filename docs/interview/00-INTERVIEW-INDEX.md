# Placement Tracker — Interview Index

> These are personal revision notes. Everything marked **Current** is provable from the
> source code in this repo. Read the legend once, then trust the tags.

---

## ⚡ INTERVIEW DEFENSE DOCUMENTS — read these first

These are audited **against the resume**, not just against the code.

| File | Read it for |
|---|---|
| **[14-ONE-DAY-REVISION.md](14-ONE-DAY-REVISION.md)** | **The night-before sheet. Start and end here.** |
| **[CODE-VS-RESUME-CHECK.md](CODE-VS-RESUME-CHECK.md)** | **What you can safely claim, and what you can't.** Read this second. |
| [DANGEROUS-RESUME-CLAIMS.md](DANGEROUS-RESUME-CLAIMS.md) | The words on your resume that invite deep questioning |
| [RESUME-DEFENSE-MAP.md](RESUME-DEFENSE-MAP.md) | Every resume bullet → code → questions → answers |
| [PLACEMENT-TRACKER-DEEP-DIVE.md](PLACEMENT-TRACKER-DEEP-DIVE.md) | The full defence of your #1 project |
| [INTERVIEW-ATTACK-TREE.md](INTERVIEW-ATTACK-TREE.md) | How the questioning will actually branch |
| [MOCK-INTERVIEW.md](MOCK-INTERVIEW.md) | 40 questions — practise out loud |
| [CODE-WALKTHROUGH-MAP.md](CODE-WALKTHROUGH-MAP.md) | For *"open the code and show me"* |
| [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md) | 10 decisions: problem → naive → failure → fix → trade-off |
| [CODESYNC-INTERVIEW.md](CODESYNC-INTERVIEW.md) | Second project — **contains two things to fix tonight** |
| [SKILLS-DEFENSE.md](SKILLS-DEFENSE.md) | Minimum depth per technology on your resume |
| [CS-FUNDAMENTALS-MAP.md](CS-FUNDAMENTALS-MAP.md) | Where the interviewer can take the conversation |

### 🔴 Three things to do tonight
1. **Rotate the Judge0 RapidAPI key** — it's hardcoded in `CodeSync/src/components/CodeEditor.tsx`
   and shipped to every browser.
2. **Consider rewording the CodeSync "real-time code editing" bullet** — it isn't implemented.
3. **Drop "SQLite" from the skills list** unless it's from work outside these two repos.

### The five things you must never falsely claim
Exactly-once processing · collaborative real-time editing in CodeSync · 50 committed test emails ·
that you deleted the similarity formula · that concurrent updates are safe.

---

## Chapters (project documentation)

**Status legend used in every chapter**

| Tag | Meaning |
|---|---|
| ✅ **Current** | The code does this today. Safe to claim in an interview. |
| 🕘 **Historical** | It worked this way earlier. The code has since changed. |
| 🚧 **Partial** | Built and tested, but not wired into the running pipeline. |
| 💭 **Future idea** | Only discussed. **Never claim you built this.** |
| ❓ **Uncertain** | Code doesn't prove it either way. Don't assert it. |

---

## What this project is

Placement Tracker reads a student's placement emails from Gmail and turns them into a
single, reconciled list of real events — "Amazon OA, 20 Aug, 10:00, HackerRank". The hard
part is not parsing. It is that one round is described across four or five emails that
arrive out of order, contradict each other, and leave fields out. So the system treats each
email as *evidence about a round*, not as a row to insert. Every write is adjudicated: it
decides whether this email is about a round it already knows, and whether the new
information is trustworthy enough to overwrite what it already believes.

---

## 30-second explanation

> "It's a backend that connects to your Gmail, reads placement emails, and keeps one
> up-to-date list of your tests and interviews. The interesting part isn't the parsing —
> it's deciding whether a new email is about an event I already have, and whether I should
> trust it enough to overwrite what's stored. So every extraction gets a confidence score,
> and low-confidence data goes to a review queue instead of into the database."

---

## 2-minute explanation ("tell me about your project")

> "Placement emails are a mess. One round gets announced in one email, moved in another,
> the venue arrives in a third. Students track this by hand across 10–30 companies.
>
> So I built a backend that connects to Gmail once with OAuth, syncs new mail in the
> background, and processes each email through a queue. For each email it extracts company,
> round, date, time and venue — using regex patterns, with an optional LLM path that merges
> in field by field.
>
> Then two things happen that make it more than a parser.
>
> First, **recognition**: it has to decide whether this email describes a round it already
> stores. That's three tiers — an exact identity key of company + round + date, then a
> near-date match within ±3 days, then a sole-candidate match within 30 days. And before
> any scoring runs, there's an identity gate: if the candidate's round *contradicts* the
> incoming round, it's vetoed outright. That came from a real bug where a morning PPT and
> an afternoon test got merged into one event, because the scoring function could express
> 'no support' but had no way to express 'this is a different thing'.
>
> Second, **trust**: every extraction carries a confidence score. If it's below the
> threshold, the system doesn't touch existing data at all — it creates a review entry for
> a human. And a lower-confidence observation can never overwrite a higher-confidence one,
> so a vague 'sometime next week' can't destroy an exact date that arrived earlier.
>
> Updates are field-level and written in a transaction with an audit row, so an event can
> always explain how it got its current values. Attachments are downloaded and parsed on a
> second queue after the email succeeds. It's deployed on Vercel plus Render with Neon and
> Redis, and it's multi-user — every query is scoped by owner, enforced with composite
> foreign keys in Postgres."

---

## Architecture to remember

```
Gmail ──OAuth──► Gmail Sync (scheduler, every 2 min)
                      │  saves Email + attachment metadata
                      ▼
              email-processing queue (BullMQ / Redis)
                      │
                      ▼
              email worker  ──► derive owner from the DB row
                      │
                      ▼
    clean → extract (regex + optional AI) → confidence
                      │
                      ▼
              VIABILITY GATE   no company / no date ──► abandon (status = ignored)
                      │
                      ▼
              MATCH  exact → soft(±3d, identity gate) → loose(±30d, unique)
                      │
                      ▼
              DECIDE  low confidence ──► create review event
                      │  matched ──► safe update  (+ EventUpdate, in one transaction)
                      │  no match ──► create event
                      ▼
                  PostgreSQL
                      │
                      └──► attachment-processing queue ──► download · parse · persist
```

---

## Five most important technical ideas

All five are ✅ **Current**.

1. **Event identity via `eventKey` = `company|stage|date`.** A deterministic string that
   makes "is this the same round?" a lookup instead of a guess. Unique **per user**, not
   globally. → [ch. 02](02-DOMAIN-AND-DATA-MODEL.md), [ch. 05](05-EXTRACTION-MATCHING-DECISION-ENGINE.md)

2. **Identity gate before similarity (ADR-006).** A contradicted round vetoes a candidate
   *before* it is ever scored. A weighted sum of positive terms cannot express a veto.
   → [ch. 05](05-EXTRACTION-MATCHING-DECISION-ENGINE.md), [ch. 09 story #1](09-PROBLEMS-AND-DESIGN-DECISIONS.md)

3. **Confidence as permission to act.** One 0–1 number derived from *how* a field was
   obtained. Below 0.6 → don't touch anything, park for review. Lower than the incumbent →
   refuse the update. → [ch. 05](05-EXTRACTION-MATCHING-DECISION-ENGINE.md)

4. **Intent-aware nulls (`VenueMeta`).** "The email said nothing about venue" and "the
   email explicitly said the venue is not decided" are different facts and produce
   different writes. → [ch. 05](05-EXTRACTION-MATCHING-DECISION-ENGINE.md)

5. **Ownership is derived from the database, never from the request or the queue.** The job
   payload's `userId` is a hint that gets cross-checked; the authoritative owner comes off
   the persisted row. → [ch. 08](08-RELIABILITY-IDEMPOTENCY-AND-TRANSACTIONS.md), [ch. 11](11-SECURITY-DEPLOYMENT-AND-OPERATIONS.md)

---

## Five strongest engineering stories

Full versions in [ch. 09](09-PROBLEMS-AND-DESIGN-DECISIONS.md).

| # | Story | Why it lands |
|---|---|---|
| 1 | **The false merge (D-1)** — PPT and OA on the same day merged into one event | A representational bug, not a tuning bug. Shows you can tell those apart. |
| 2 | **Partial updates destroying good data** — "Amazon OA on 20th Aug" wiped time and venue | Classic real-world data-integrity problem with a clean fix. |
| 3 | **Explicit-null vs missing (`VenueMeta`)** | Shows you think about *intent*, not just values. Rare in student projects. |
| 4 | **The AI invented a date** — "in 2027" became `2027-01-01` | LLM reliability with a deterministic guard, not "I added a better prompt". |
| 5 | **Split-origin session cookie in production** — dashboard showed "No events yet" with 39 rows in the DB | Real production debugging, two bugs where one masked the other. |

Backups if one of these lands badly: **the quoted-reply-chain date bug** (a Bajaj email put
an event on a date that appeared nowhere in the message anyone actually sent), and the
**AI Core extraction** (four services duplicating the same OpenAI plumbing).

---

## Questions I MUST be able to answer

**Project & design**
1. Why is CRUD not enough here? → [ch. 01](01-PROJECT-STORY.md)
2. What is an "event" in your system, and what makes two events the same event? → [ch. 02](02-DOMAIN-AND-DATA-MODEL.md)
3. Why did you split `Email`, `EmailExtraction` and `Event` into three tables? → [ch. 02](02-DOMAIN-AND-DATA-MODEL.md)
4. Walk me through one email end to end. → [ch. 03](03-SYSTEM-ARCHITECTURE.md)

**Extraction & AI**
5. Why hybrid regex + LLM, and which one wins on a conflict? → [ch. 05](05-EXTRACTION-MATCHING-DECISION-ENGINE.md)
6. What is confidence, how is it computed, and where is it used? → [ch. 05](05-EXTRACTION-MATCHING-DECISION-ENGINE.md)
7. How do you stop the LLM from inventing a date? → [ch. 05](05-EXTRACTION-MATCHING-DECISION-ENGINE.md), [ch. 09](09-PROBLEMS-AND-DESIGN-DECISIONS.md)
8. What happens when OpenAI is down? → [ch. 06](06-ASYNC-JOBS-ATTACHMENTS-AND-AI.md)

**Matching**
9. How do you decide two emails describe the same round? → [ch. 05](05-EXTRACTION-MATCHING-DECISION-ENGINE.md)
10. Why is a contradicted round a veto instead of a score of 0? → [ch. 05](05-EXTRACTION-MATCHING-DECISION-ENGINE.md)
11. What happens when you match the *wrong* event? Which failure do you prefer? → [ch. 09](09-PROBLEMS-AND-DESIGN-DECISIONS.md)

**Reliability**
12. What happens if the same email is processed twice? → [ch. 08](08-RELIABILITY-IDEMPOTENCY-AND-TRANSACTIONS.md)
13. Why a transaction around the update? What breaks without it? → [ch. 08](08-RELIABILITY-IDEMPOTENCY-AND-TRANSACTIONS.md)
14. What happens if the worker crashes mid-job? → [ch. 06](06-ASYNC-JOBS-ATTACHMENTS-AND-AI.md)
15. How do you avoid a low-quality email overwriting good data? → [ch. 05](05-EXTRACTION-MATCHING-DECISION-ENGINE.md)

**Async / infrastructure**
16. Why a queue at all? Why not just process it in the request? → [ch. 06](06-ASYNC-JOBS-ATTACHMENTS-AND-AI.md)
17. Why are attachments enqueued *after* the email is processed? → [ch. 06](06-ASYNC-JOBS-ATTACHMENTS-AND-AI.md)
18. Why two Redis clients? → [ch. 06](06-ASYNC-JOBS-ATTACHMENTS-AND-AI.md), [ch. 11](11-SECURITY-DEPLOYMENT-AND-OPERATIONS.md)

**Database**
19. Why is `eventKey` unique per user and not globally? → [ch. 07](07-DATABASE-DESIGN.md)
20. What are the composite foreign keys for? → [ch. 07](07-DATABASE-DESIGN.md)
21. Why do you store dates as UTC midnight but compare them in IST? → [ch. 07](07-DATABASE-DESIGN.md), [ch. 09](09-PROBLEMS-AND-DESIGN-DECISIONS.md)

**Gmail / OAuth**
22. Why a refresh token and offline access? What do you store? → [ch. 04](04-EMAIL-AND-GMAIL-PIPELINE.md)
23. How does incremental sync work, and what if the cursor expires? → [ch. 04](04-EMAIL-AND-GMAIL-PIPELINE.md)
24. How do you know which user owns an email? → [ch. 04](04-EMAIL-AND-GMAIL-PIPELINE.md), [ch. 11](11-SECURITY-DEPLOYMENT-AND-OPERATIONS.md)

**Testing & security**
25. How would you test extraction / duplicate emails / confidence updates? → [ch. 10](10-TESTING.md)
26. Where does multi-tenancy get enforced, and how do you know it can't be bypassed? → [ch. 11](11-SECURITY-DEPLOYMENT-AND-OPERATIONS.md)

Model answers for all of these (plus follow-ups) are in [ch. 12](12-INTERVIEW-QA.md).

---

## Night-before revision order

**If you have 3–4 hours** — read in this order:

1. `14-ONE-DAY-REVISION.md` (skim first, so you know the shape)
2. `01-PROJECT-STORY.md` — this is the narrative you'll actually speak
3. `05-EXTRACTION-MATCHING-DECISION-ENGINE.md` — **the most important chapter**
4. `03-SYSTEM-ARCHITECTURE.md`
5. `09-PROBLEMS-AND-DESIGN-DECISIONS.md` — pick 5 stories, learn those cold
6. `02-DOMAIN-AND-DATA-MODEL.md` + `07-DATABASE-DESIGN.md`
7. `08-RELIABILITY-IDEMPOTENCY-AND-TRANSACTIONS.md`
8. `12-INTERVIEW-QA.md` — read out loud

**If you have 1 hour:** `14-ONE-DAY-REVISION.md` → ch. 05 → 5 stories from ch. 09 → the
diagrams in ch. 13.

**If you have 15 minutes:** the last section of `14-ONE-DAY-REVISION.md`. Nothing else.

**Safe to skip when short on time:**
- `06` sections on document-intelligence (it's built but not wired — you only need to know
  *that*, not the internals)
- `10-TESTING.md` beyond the "tests I should mention" list
- `11` deployment detail beyond the one-line "why the OAuth callback must terminate on the
  frontend origin"
