# Dangerous Resume Claims

Words on your resume that invite deep questioning. Each one is a promise an interviewer can
cash in.

**Risk levels:** 🔴 exposure risk — you could be caught · 🟡 needs a precise answer ·
🟢 safe, but expect depth

---

# 🔴 RED — fix or pre-empt these

## 1. "real-time code editing" (CodeSync)

**Why it's dangerous:** it is **not implemented.** `CodeEditor.tsx` holds the code in local
React state (`useState`). There is no Convex document for it, no Yjs, no CRDT, no shared
editor. Each participant types into their own Monaco instance.

**What the interviewer expects:** conflict resolution, operational transforms or CRDTs,
presence, cursor sharing, debounced persistence.

**What to do — best option:** reword the bullet tonight:
> "Built an interview platform pairing Stream video with an in-browser Monaco editor and
> Judge0-backed multi-language execution, with Convex real-time sync for scheduling, roles and
> interviewer feedback."

**If you can't reword it, and you're asked:**
> "I should be precise there — the real-time layer is Convex, and it syncs interview state:
> scheduling, participants, status transitions and feedback, all live through Convex
> subscriptions. The editor itself isn't collaboratively synced; each side has its own Monaco
> instance. To add shared editing I'd use a CRDT like Yjs rather than storing the document in
> Convex, because last-write-wins on a text field loses characters when two people type at
> once."

Volunteering the correction turns an exposure into a design discussion. Being caught does not.

---

## 2. Hardcoded Judge0 API key (CodeSync)

**Why it's dangerous:** `src/components/CodeEditor.tsx` contains a literal RapidAPI key
(`"X-RapidAPI-Key": "7a238ee83..."`), committed to the repo, and the `fetch` runs **in the
browser** — so the key ships to every visitor. If the interviewer opens that file, they see it
immediately.

**Do tonight:** rotate the key on RapidAPI. If you have 20 minutes, move `runCode` into a
Next.js server action or route handler so the key stays server-side.

**If asked, or if you spot them reading it:**
> "That's a real mistake — the key is in the client bundle, so it's public. Judge0 should be
> called from a server action with the key in an environment variable, which also gives me a
> place to rate-limit. I've rotated it."

Owning it costs one sentence. Being shown it costs the interview's tone.

---

## 3. "50+ real placement emails"

**Why it's dangerous:** it implies a committed test corpus. There isn't one — no fixtures
directory, no `.eml` files.

**What's actually true:** you ran the pipeline against a live mailbox. `backend/storage/attachments/`
holds 11 real downloaded attachments (8 PDF, 2 DOCX, 1 XLSX). ~52 email-body strings appear
inline in tests, derived from real messages. The Notion log documents specific real emails and
the bug each one exposed.

**Safe answer:**
> "I ran it against my own mailbox and a set of real TPO emails — around fifty over the course
> of development. That's where the interesting bugs came from: the quoted reply chain, the
> multi-event email, the 'PFA seating plan' venue. I didn't commit them as fixtures because they
> contain other students' names and registration numbers, so what's in the repo is the
> regression tests derived from them."

**Never say:** "I have 50 test emails in the repo."

---

## 4. "Docker" (skills list)

**Why it's dangerous:** it reads as "I containerised my application." `docker-compose.yml`
defines **one service: `postgres:16`**. There is no backend Dockerfile, no containerised worker,
no Redis service.

**Safe answer:**
> "I use Docker Compose to run my local Postgres. The app itself isn't containerised — it
> deploys to Render from source. So it's 'Docker for local infrastructure', not 'I containerised
> the application'."

**Do NOT** describe multi-stage builds, a container network, or a compose file you don't have.

---

# 🟡 AMBER — precise answers required

## 5. "incremental"

**Expects:** a cursor, a delta API, and an answer for what happens when the cursor is invalid.

**Short answer:**
> "Each mailbox stores Gmail's `historyId` as a cursor. Next run I call `history.list` from it
> and only get messages added since. No cursor means full sync; an expired cursor returns 404
> and I fall back to full sync automatically. On a full sync I capture the watermark *before*
> listing, so a message arriving mid-run is re-fetched next time rather than lost — overlap is
> safe, gaps are not."

**Caveat to know:** full sync uses `maxResults: 100` with **no pagination**. Incremental *is*
paginated.

## 6. "background processing"

**Expects:** where the boundary is, what's durable across it, and what happens on crash.

**Short answer:**
> "The email row is persisted first, then a job goes on a BullMQ queue, then a separate worker
> process runs extraction, matching and the decision. The API returns 202 immediately. A crash
> loses a job, never an email — the row is still there with its processing status."

## 7. "multi-stage"

**Expects:** you can name the stages, their order, and why they're ordered that way.

**Short answer:**
> "Three recognition tiers of decreasing evidence: an exact identity key, a ±3-day temporal
> match with candidates ranked, and a ±30-day tier that only fires when there's exactly one
> candidate. It stops at the first sufficient answer, so the cheap deterministic check handles
> the common case and the fallible logic only runs when that's already failed."

## 8. "exact matching"

**Expects:** exact on *what*, and enforced *how*.

**Short answer:**
> "`eventKey = company|stage|date`, with a unique index on `(userId, eventKey)`. So it's an
> indexed lookup, and the database enforces that a duplicate is impossible rather than
> unlikely."

**Follow-up to be ready for:** *"What if the company name is spelled differently?"*
> "Then it's not an exact match and it falls to the temporal tier. Company matching is exact and
> case-sensitive in the query, which works because extraction lowercases the whole body first —
> but 'Amazon' versus 'Amazon India' would miss. Normalising company names is the thing I'd add
> next, and I deliberately didn't build a companies table because canonicalisation is its own
> subproblem."

## 9. "temporal matching"

**Expects:** window sizes, and *why those sizes*.

**Short answer:**
> "±3 days at tier 2, because a round often gets re-announced with a slightly shifted date, and
> within that window date proximity is banded — same day 1.0, one day 0.7, three days 0.5.
> ±30 days at tier 3, because that tier infers identity from uniqueness alone and uniqueness is
> only meaningful inside a plausible range."

## 10. "ambiguity handling"

**Expects:** a concrete behaviour, not a vibe.

**Short answer:**
> "Three things. A candidate whose round contradicts the incoming round is vetoed before it's
> scored. Tier three refuses when two or more candidates are in range, because uniqueness is its
> whole identity claim. And when nothing qualifies it returns nothing, which creates a duplicate
> — deliberately, because a duplicate is visible and recoverable and a false merge isn't."

## 11. "weighted-similarity" / "Replaced"

**Why it's dangerous:** the formula **still exists** in `matching.utils.ts`. "Replaced" reads as
"deleted". An interviewer who opens the file will find `scoreEventMatch` intact.

**Say it precisely:**
> "The formula is unchanged. What I replaced is its *authority* — it used to decide both whether
> a candidate was the same event and which candidate to pick. Now identity is decided
> categorically before it runs, and the score only ranks candidates that already qualified."

**Then the killer follow-up will come:** *"Why not just raise the threshold?"* — see #12.

## 12. "confidence-aware identity model"

**Why it's dangerous:** it's the most abstract phrase on your resume. If you can't unpack it in
30 seconds it sounds like buzzwords.

**Unpack it word by word:**
> "Identity is a fact about the world — is this the same round? It's categorical; it holds or it
> doesn't, and it's determined by company, round and date, where any two of the three are
> insufficient. Confidence is a quantity I compute — how much should I trust what I just read,
> based on *how* each field was obtained. They're different kinds of thing, and conflating them
> is what caused the bug. So they're strictly ordered: identity decides who's eligible and
> confidence has no say; then confidence contributes 20% of the ranking among the eligible; then
> confidence alone decides whether to act and whether to overwrite."

**And the killer follow-up:** *"Why not just raise the similarity threshold?"*
> "Because the score is a sum of non-negative terms, so it's monotone in each — the date term is
> a lower bound and nothing can pull the total below it. A mismatched round contributed zero,
> which means 'no support', not 'evidence against'. There's no threshold at which a
> contradiction outvotes a strong date match, because contradiction was never expressible as a
> negative quantity. It's a representational defect, not a mis-tuned constant."

**This is the single highest-value answer in your preparation. Rehearse it out loud.**

## 13. "prevents contradictory event merges"

**Why it's dangerous:** "prevents" is absolute. It doesn't prevent *all* bad merges.

**Precise answer:**
> "It prevents the whole class of contradicted-round merges — a candidate whose round disagrees
> is vetoed before scoring, and there's a parametrized regression suite asserting that across
> every date delta and confidence value. What it doesn't prevent is two genuinely distinct
> rounds *of the same type* for the same company within 30 days; the weakest tier can still
> match those. That's bounded to 30 days precisely to keep the residual risk small, and it's a
> trade-off I chose."

## 14. "field-level history"

**Expects:** the exact stored shape, and atomicity.

**Short answer:**
> "One `EventUpdate` row per changed field — field name, old value, new value, timestamp —
> written in the same transaction as the event update. So either the event moved and can explain
> itself, or nothing happened."

**Follow-up to pre-empt:** *"Can you tell which email caused a change?"*
> "No — there's no foreign key from EventUpdate back to Email. I can correlate by timestamp
> against EmailExtraction, but that's inference. The fix is an `event_emails` join table
> recording the event, the email, the match type and the score."

## 15. "120 automated tests"

**Expects:** a real number, real types, and knowing what they assert.

**Short answer:**
> "125 test declarations across 11 suites, about 214 at runtime because several are
> parametrized. Almost all unit tests with dependencies mocked, plus one integration test with
> supertest. No database or Redis needed to run them."

The number is defensible — 120 is conservative against both counts. Just don't say "exactly 120"
without the caveat.

## 16. "sandboxed" (CodeSync)

**Why it's dangerous:** it implies *you* built the sandbox. You didn't — Judge0 did.

**Short answer:**
> "Judge0 runs each submission in an isolated container with CPU and memory limits — I send
> `cpu_time_limit: 5` and `memory_limit: 128000`. That isolation is exactly why I used a service
> instead of executing untrusted code myself: running arbitrary C++ on my own server is a
> problem I have no business solving for an interview platform."

## 17. "Distributed Systems" (Areas)

**Why it's dangerous:** it invites CAP, consensus, replication, sharding — none of which you
built.

**Short answer:**
> "The distributed-systems problems I actually hit were at-least-once delivery and idempotency —
> a queue and a database are two systems, and you can't get an atomic write across them without
> distributed transactions, so I made the work idempotent instead. I haven't built consensus or
> replication; that's the direction I'm learning toward, not something I'd claim to have
> shipped."

Naming the boundary yourself is far stronger than being walked past it.

## 18. "JWT" (skills list)

**Why it's dangerous:** Placement Tracker uses **server-side sessions, not JWTs.**

**Short answer:**
> "I've worked with JWTs on the verification side — Google's ID token is a JWT and I verify its
> signature, audience, expiry and issuer, and CodeSync uses Clerk's JWTs validated by Convex.
> But for my own session layer I deliberately chose server-side sessions over JWTs, because
> revocation matters more to me than statelessness — the session stores a user id, not a
> snapshot, so disabling a user takes effect on their next request instead of their next login."

That's a *better* answer than "yes I use JWT."

---

# 🟢 GREEN — safe, but expect depth

## 19. "OAuth 2.0"
Fully implemented. **One gap to pre-empt: the `state` parameter is missing.** If asked about
CSRF on the callback, say so — it's documented in the code's own comments, and owning it reads
as rigour.

## 20. "BullMQ" / "Redis"
Genuinely used. **The trap is "exactly-once".** Never claim it. See
[INTERVIEW-ATTACK-TREE.md](INTERVIEW-ATTACK-TREE.md) branch 7.

## 21. "PostgreSQL" / "Prisma ORM"
Deeply used — composite FKs, composite uniques, interactive transactions, an
expand/backfill/contract migration. **The trap is locking:** you have none. Say so before
you're asked.

## 22. "OpenAI API"
Real, but `USE_AI=false` by default. Frame the flag as a *design decision*: regex is the floor,
the model is the ceiling, and the system never hard-depends on a third party.

## 23. "Jest"
Real and unusually thoughtful — `requireActual` wrapping to assert on control flow, an
in-memory fake table for tenant-scoping claims, parametrized regression sweeps. This is a
strength; lead with it if testing comes up.

---

# The five sentences that save you

Memorise these. Each defuses a specific exposure.

1. **On the formula:** *"The formula is unchanged — what I replaced is its authority."*
2. **On the queue:** *"No, it's at-least-once. I made processing idempotent instead."*
3. **On locking:** *"I don't use optimistic or pessimistic locking, and here's what that means
   concretely."*
4. **On CodeSync:** *"I should be precise — the real-time layer syncs interview state, not the
   editor document."*
5. **On the emails:** *"Not committed as fixtures — they contain other students' personal data.
   The regression tests derived from them are."*

---

# Tonight's checklist

- [ ] **Rotate the Judge0 RapidAPI key.**
- [ ] Consider rewording the CodeSync "real-time code editing" bullet.
- [ ] Rehearse #12 (confidence-aware identity) out loud, twice.
- [ ] Rehearse the "why not raise the threshold?" answer out loud, twice.
- [ ] Read the five sentences above until they're automatic.
