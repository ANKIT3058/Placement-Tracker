# 05 — Extraction, Matching, and the Decision Engine

**The most important chapter.** All ✅ **Current** unless tagged.

Files: `src/modules/email/email.parser.ts`, `src/modules/extraction/*`,
`src/modules/matching/*`, `src/modules/event/event.service.ts`.

---

# Part 1 — Extraction

## What gets extracted

Five fields, and nothing else: **company, stage, date, time, venue.**

Plus two pieces of metadata that travel alongside:
- `venueMeta: { value, isExplicit }` — the *intent* behind the venue value
- `isTimeEstimated: boolean` — whether the time was inferred ("evening" → 18:00)

## Step 0 — Cleaning (this matters more than it sounds)

`cleanEmail(text)` in `email.parser.ts` does two things, **in this order**:

1. **Cut the quoted history off.** A reply carries the whole thread below it, and that
   thread is full of real, well-formed dates belonging to *other* events. The regex
   `QUOTE_BOUNDARY` finds the first of:
   - Gmail/Apple Mail attribution: `^On [\s\S]{0,300}?\bwrote:` — spans newlines because
     the line wraps in practice; lazy and length-bounded so it can't run away
   - `---------- Forwarded message ---------`
   - `-----Original Message-----`
   - an Outlook header block: `From:` followed within 3 lines by `Sent:`/`Date:`
   - any quoted line `^>`, or the RFC 3676 signature delimiter `^-- $`

   **Fallback:** if cutting leaves nothing (a bare forward with no covering note), keep the
   full text. Never return less than nothing useful.

2. **Collapse whitespace.** `\n → space`, then squash runs of spaces.

Order matters: every boundary pattern is line-anchored, so flattening newlines first would
destroy the structure it needs.

> **Real bug this fixed:** a Bajaj Auto reply whose only explicit year lived in its quoted
> header (`On Tue, Jul 29, 2025 at 2:30 PM ... wrote:`) produced an Interview event on
> 2025-07-29 — a date that appears nowhere in the message anyone actually sent.

**Exception — with a caveat worth knowing.** Inside `extractData`, every other field reads
the cleaned text but `extractVenue` is deliberately handed the *un-re-cleaned* argument,
because its `venue:\s*([^\n\r.]+)` pattern uses newlines to know where the value stops.

**But in the live pipeline that intent is already defeated:** `email.service` runs
`cleanEmail(body).toLowerCase()` *before* calling `extract`, so by the time `extractData`
runs, the newlines are gone. The pattern still stops at a period, and what actually does the
work is the clause splitting inside `extractVenue` (`note|time|date|timing|register`, then
`,` / `;`) plus the length cap. The "raw text" path only genuinely preserves newlines when
`extractData` is called directly — which is what the unit tests do.

Worth being able to say: *"the comment describes the design intent, and the intent holds in
the tests but not on the live path, because an outer layer pre-cleans. It works anyway
because of the clause splitting — but it's a latent inconsistency I'd fix by pushing
`cleanEmail` down into `extractData` and passing the raw body through."*

## Step 1 — Deterministic (regex) extraction

`extractData(text)` in `email.parser.ts`:

| Field | How |
|---|---|
| **date** | `EXACT_DATE_PATTERN` = day + month-name + optional 4-digit year. Falls back to relative (`tomorrow`, `next week`). Built as `Date.UTC(...)`. |
| **company** | Four patterns tried in order: `at <X>`, `<drive\|test\|interview\|ppt\|conducted\|organized\|hosted> by <X>`, `<X> is visiting`, `<X> is conducting/organizing/hosting`. Then trimmed at stop-words (`date`, `time`, `venue`, `note`, `for`, `on`, `the`) and run through `isValidCompany`. Unresolved → the literal `"unknown"`. |
| **stage** | Keyword priority: `interview` → `online test\|test` (→ `OA`) → `ppt\|pre-placement talk` → `register\|deadline` (→ `Registration`). Unresolved → `"unknown"`. |
| **time** | 4 patterns: AM/PM (`at 10 AM`), `at 5 in the evening`, `5 in the evening`, then bare `morning`/`afternoon`/`evening` → 10:00 / 14:00 / 18:00. Returns 24-hour `"HH:MM"`. |
| **venue** | Priority: explicit `venue:` line → known platforms (hackerrank, zoom, teams, online, campus…) → `at <X>` → known physical locations (tpo, auditorium, seminar hall…). |

The date pattern is worth calling out: **day + month name is the minimum shape.** A bare
year or "August 2027" can never match it, so it can never be mistaken for an exact date.

## Step 2 — AI extraction (optional)

Enabled only when `USE_AI === "true"` (default **false**). `extractWithAI` calls the AI Core
with a system prompt that specifies:
- convert `"20th Aug"` → `"YYYY-MM-DD"`
- **use the explicit year from the email if present**; assume the current year *only* if none
- **return `null` for incomplete dates** — a standalone year is not a date, a month+year is
  not a date, never invent a missing day or month
- vague times → best guess (`morning` → `10:00`), never null
- platform as venue
- if multiple events: pick one, prefer Interview > Test > PPT

Model: `gpt-4o-mini`, `temperature: 0`, **one attempt, no retry** (`new RetryPolicy({
maxAttempts: 1 })`) — matching the behaviour before the AI Core existed.

**If the AI call fails for any reason, it's caught and logged, and the pipeline continues
regex-only.** The LLM is an enhancement, never a dependency.

## Step 3 — Validating the AI's date against the source

`validateAIDate(candidate, sourceText)` in `extraction.utils.ts`.

**The problem:** syntactic validity proves nothing. `"2027-01-01"` is a well-formed date
whether or not January 1st was ever mentioned. Given "we'll be hiring in 2027," the model
happily returns `2027-01-01`.

**The fix:** the AI's specific candidate must be *corroborated* by the source. It runs
`findDateEvidence(cleanEmail(sourceText))` — every day+month(+year) mention in the text — and
keeps the candidate only if some mention has the same day and month, and either the same
year or no year at all (in which case the candidate must be the current year, the same
default the regex extractor would apply).

Three details that matter:
- it checks **every** mention, not just the first, so a legitimate second date in a
  multi-date email is still accepted
- it runs `cleanEmail` first, so a date living only in a quoted thread cannot authorize a
  candidate for the current message
- an unsupported date is **dropped**, not replaced — so `mergeExtraction` falls back to the
  deterministic date exactly as it would for any other missing AI field

## Step 4 — Merging

`mergeExtraction(ai, regex)`:

```ts
company: ai.company || regex.company
stage:   ai.stage   || regex.stage
date:    ai.date    || regex.date
time:    ai.time   ??  regex.time
venue:   venueMeta.value
venueMeta: ai.venue != null
             ? { value: ai.venue, isExplicit: true }
             : regex.venue                    // the regex layer's VenueMeta
```

**Field-wise, not whole-object.** The AI wins per field when it produced something; the
regex fills every gap. Note `time` uses `??` (nullish) rather than `||`, so an AI-returned
empty string would still be preferred — a small deliberate difference.

**Why hybrid at all?**

| | Regex | LLM |
|---|---|---|
| Deterministic | ✅ same input → same output | ❌ |
| Handles unseen phrasing | ❌ brittle | ✅ |
| Cost / latency | free, instant | paid, seconds |
| Works offline | ✅ | ❌ |
| Fails how? | returns nothing | returns something *plausible* |

That last row is the real argument. A regex that doesn't match gives you `null`, which is
honest. An LLM that doesn't know gives you a confident-looking wrong answer. So the design
is: **regex as the floor the system can always stand on, LLM as the ceiling** — plus
`validateAIDate` as a deterministic check on the LLM's most dangerous output.

It also means the whole system runs with `USE_AI=false` and no API key. That's why the test
suite needs neither.

---

# Part 2 — Confidence

## What confidence means

**How much the system should trust this extraction — based on *how* the information was
obtained, not on what it says.**

An exact date beats "next week" not because 20 August is more likely than next week, but
because reading "20 August" is a more reliable act than resolving "next week."

## How it's computed

`computeConfidence` in `src/modules/extraction/confidence.utils.ts`.

**Weights** (sum to 1.0):

| Field | Weight | Why |
|---|---|---|
| date | 0.35 | Without a date there is no event |
| company | 0.25 | Identity anchor |
| time | 0.20 | The most commonly corrected field |
| stage | 0.10 | Deterministic and low-variance |
| venue | 0.10 | Nice to have |

**Field scorers:**

```
company : "unknown" or empty → 0    |  length > 2 → 1    |  else 0.7
date    : missing → 0
          text mentions "next week"/"coming week" → 0.5
          text mentions "tomorrow"/"today"        → 0.8
          otherwise (an exact date)               → 1
time    : missing → 0
          ×0.6 if isTimeEstimated ("around", "approx", "morning"…)
          ×0.8 if the text contains morning/afternoon/evening
stage   : missing → 0  |  present → 1
venue   : no meta                        → 0.5
          isExplicit = false (inferred)  → 0.5   ← neutral, not penalised
          isExplicit = true, value null  → 0.3   ← explicitly invalid
          isExplicit = true, real value  → 0.9
```

**Then:**
```
total = Σ(score × weight)
      + 0.05 if company && date && stage      (completeness bonus)
      clamped to [0, 1]
```

**And then penalties**, applied in `extract()` in `extraction.service.ts`:
```
-0.10  if company === "unknown"
-0.15  if no venue
-0.10  if no time
final = max(0, total - penalty)
```

> 🕘 The old Notion notes give the penalties as `0.2 / 0.1 / 0.1`. The code says
> `0.1 / 0.15 / 0.1`. **Quote the code.** Notion also describes a `confidence *= 0.7` when
> AI is unavailable — that is **not implemented**.

Note the `"unknown"` company case is scored twice: 0 from the scorer *and* a 0.1 penalty.
The comment says the extra penalty is a deliberate "low trust" signal. It's also mostly
academic now, because the viability gate abandons unresolved companies before confidence is
ever consulted for a decision.

## Where confidence is used — four places

1. **Admission.** `confidence < CONFIDENCE_THRESHOLD (0.6)` → don't touch anything existing;
   create a `review` event.
2. **Incumbent protection.** `newConfidence < existingConfidence` → skip the update entirely.
3. **Ranking.** `scoreEventMatch` includes `min(incoming.confidence, event.confidence) × 0.2`
   — a match between two well-established beliefs ranks above a match between two guesses.
4. **Persistence and display.** Stored on both `Event` and `EmailExtraction`; the dashboard
   sorts low-confidence first and shows High/Medium/Low.

## The trade-off

Confidence is a **hand-tuned heuristic**, not a calibrated probability. `0.6` is a
judgement, not a measurement. That's a legitimate criticism, and the honest answer is:

> "It's not calibrated — I don't have labelled data to calibrate against. What it *does*
> give me is a single ordered scalar that makes 'don't act' and 'don't overwrite something
> better' expressible at all. The alternative was acting on everything equally, which
> demonstrably destroyed good data. If I had usage data, the next step is logging every
> decision with its confidence and the human's eventual correction, and fitting the
> threshold to that."

**Follow-up you'll get:** *"What if new data has lower confidence but is actually correct?"*
Then it's rejected and the event goes stale — visible, and the user can fix it manually
(which sets confidence to 1.0 and locks it). That's the accepted trade: **staleness is
recoverable, corruption is not.**

---

# Part 3 — Matching (recognition)

`matchEventV2(owner, data)` in `src/modules/matching/matching.service.ts`.

Three tiers of **decreasing evidential strength**, stopping at the first sufficient answer.
Every candidate query is bounded by `owner` — tenant scoping decides what the engine can
*see*, never what it *accepts*.

## Tier 1 — Exact identity key

```ts
const key = generateEventKey({ company, stage, date });   // "amazon|OA|2026-08-20"
const exact = await findByEventKey(owner, key);
if (exact) return { event: exact, matchType: "exact", confidence: 1.0 };
```

All three identity attributes agree. There is nothing to score. Accepted unconditionally,
no identity gate needed — the key *is* the identity.

## Tier 2 — Soft match (±3 days), identity-gated

```ts
const softMatches = await findNearbyEvents(owner, { company, date, windowDays: 3 });
```
Same company, date within ±3 days. Note: the query **deliberately does not filter on
stage.** The engine has to *see* a contradicting candidate in order to refuse it — and to be
able to say that it did.

**Phase A — the identity gate (categorical):**
```ts
classifyRoundIdentity(candidate.stage, incoming.stage)
  → "AGREES"      same round
  → "CONTRADICTS" different round        → VETOED, never scored
  → "UNKNOWN"     either side unresolved → stays eligible
```
`resolveRound` normalises to lowercase and maps the `"unknown"` sentinel (and empty string)
to `null`. **The sentinel never compares equal to itself** — it marks "not extracted", not a
round any company runs.

**UNKNOWN is deliberately not a contradiction.** An email that didn't state a round has said
nothing about identity, and the domain's *silence is not denial* rule forbids reading that
as disagreement.

**Phase B — similarity ranking (continuous), survivors only:**
```
score = dateScore × 0.5 + stageScore × 0.3 + confidenceScore × 0.2

dateScore:   0 days → 1.0
            ≤1 day  → 0.7
            ≤3 days → 0.5
            >3 days → return { score: 0, reason: "Date too far" }   (early exit)

stageScore:  case-insensitive equality → 1, else 0

confidenceScore = min(incoming.confidence, event.confidence)

accept if bestScore >= 0.5
```

Each score carries a human-readable `reason` string — `"Exact date match + Stage matched +
Strong confidence alignment"` — which is returned with the match and logged. Debugging a
wrong match without that is guesswork.

## Tier 3 — Loose match (±30 days), uniqueness required

```ts
const looseMatches = await findByCompanyAndStage(owner, { company, stage, date, windowDays: 30 });
if (looseMatches.length === 1) return { event: looseMatches[0], matchType: "loose", confidence: 0.6 };
```

Same company **and** same stage, but the date is far off. The identity claim here rests
entirely on **uniqueness**: if exactly one candidate exists in a plausible range, it is
probably a reschedule that moved further than ±3 days.

**Why the 30-day bound (`LOOSE_MATCH_WINDOW_DAYS`)?** Uniqueness is only meaningful inside a
bounded range. Over unbounded time, "a company's first OA" is trivially unique — so this
tier fired *most* confidently exactly where it had the *least* evidence, and merged rounds
months apart into a single "reschedule". 30 days is wide enough to keep catching real
reschedules and narrow enough to exclude cross-cycle collisions.

Two or more candidates → **no match**, which creates a duplicate. That's the recoverable
failure, chosen on purpose.

If all three tiers miss → `null`.

---

## Identity vs similarity — the distinction to say out loud

> **Identity** is a fact about the world that the system tries to *recognise*. It either
> holds or it doesn't. **Similarity** is a quantity the system *computes* to rank things.
>
> The bug was using similarity to establish identity. A weighted sum of non-negative terms
> is monotone — every term can only push the score up — so no term can veto. A mismatched
> round contributed `0`, which means "no support", and the function had no way at all to
> express "evidence against". The date term alone (0.5 × 1.0 = 0.5) already met the 0.5
> threshold, so *same company, same date, different round* was accepted.
>
> The fix wasn't retuning constants. It was changing the representation: identity is now
> categorical with three outcomes, and it runs **to completion before any scoring**.
> Similarity ranks the survivors and has no authority to admit anyone.

ADR-006: *"A constraint is a rule; a threshold is a coincidence a future retune silently
removes."*

---

# Part 4 — The decision layer

In `email.service.ts → processEmail`, after matching:

```
                     extraction + confidence
                              │
                     ┌────────┴────────┐
                     │ VIABILITY GATE  │  company unresolved OR date not YYYY-MM-DD
                     └────────┬────────┘─────► email = "ignored", STOP
                              │
                         matchEventV2
                              │
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
 confidence < 0.6      match found            no match
       │                      │                      │
       ▼                      ▼                      ▼
 create Event           updateEventService      create Event
 status = "review"      (guarded, see below)    status = "scheduled"
 nothing existing
 is touched
```

### The viability gate (AC-4)

```ts
if (!isResolvedCompany(data.company) || !data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date))
```

An observation with no identity anchor cannot be reasoned about, so it's abandoned rather
than guessed at.

`isResolvedCompany` is used instead of a truthiness check because extraction substitutes the
literal string `"unknown"` when it finds no company — **and that string is truthy.** It used
to satisfy this gate, create a real Event named "unknown", and that Event then became a
matching candidate for every later unresolved observation. One garbage event that swallowed
everything.

The gate runs *before* the key is generated, before candidate queries, before any write.

### Note an ordering quirk (be honest if asked)

`matchEventV2` is called **before** the low-confidence check, and on the low-confidence path
its result is thrown away. So a low-confidence email still runs three candidate queries for
nothing. Harmless, slightly wasteful, and the kind of thing worth mentioning as "here's
something I'd tidy up."

Also: `reviewReason` is built as
`` `Low confidence: missing ${!data.company ? "company" : ...}` `` — but by that point the
company can only be a real value (the gate already removed `"unknown"`), so the "company"
branch is unreachable. Cosmetic, but know it.

---

# Part 5 — Update safety

`updateEventService(owner, eventId, existing, incoming)` in `event.service.ts`. Five guards,
in this order:

### Guard 1 — Manual authority is categorical (AC-3)
```ts
if (existing.status === "confirmed") return existing;
```
A human decision is the highest authority. Automated inference may not revise a confirmed
event **at any confidence**.

**Why check `status` and not confidence?** Because manual confirmation sets confidence to
exactly `1.0`, and a maximally confident extraction also reaches `1.0`. The numeric
comparator literally cannot tell "a person settled this" from "the extractor was very sure."
**Authority is a kind, not a quantity.**

### Guard 2 — Change detection (`detectChanges`)
```
DATE   compare IST calendar keys (toISTKey), not raw timestamps
       different → change + isRescheduled = true

TIME   change only if incoming.time is not undefined AND not null AND differs
       → an email that says nothing about time can never blank it

VENUE  if venueMeta.isExplicit:
           compare against venueMeta.value (which may be null → CLEARS the venue)
       else:
           only change when incoming.venue != null and differs
```
`changes.length === 0` → return `existing`, write nothing, create no audit row. **This is
what makes reprocessing the same email a true no-op.**

### Guard 3 — Confidence
```ts
if (newConfidence < existingConfidence) return existing;
```
Strictly less-than, so equal confidence *does* update. Deliberate: two automated inferences
of equal quality should let the newer one through; it's only *worse* information that's
refused.

### Guard 4 — Field-level update payload
```ts
if (changes.some(c => c.field === "date"))  updateData.date  = toUTCDate(incoming.date);
if (changes.some(c => c.field === "time"))  updateData.time  = incoming.time;
if (changes.some(c => c.field === "venue")) updateData.venue = incoming.venueMeta?.isExplicit
                                                                 ? incoming.venueMeta.value
                                                                 : (incoming.venue ?? null);
```
Only fields that *actually changed* are written. A field the email never mentioned isn't in
the payload at all, so it cannot be collaterally blanked.

### Guard 5 — Atomic write
```ts
return prisma.$transaction(async (tx) => {
  for (const change of changes) await tx.eventUpdate.create({ ... });
  return tx.event.update({ where: { id: eventId }, data: { ...updateData, confidence: newConfidence } });
});
```
An event whose values moved without a matching audit row would be an event that cannot
explain itself. See [ch. 08](08-RELIABILITY-IDEMPOTENCY-AND-TRANSACTIONS.md).

---

## The null taxonomy (say this exactly)

> "In this domain, `null` is three different facts and they need three different behaviours."

| Case | Representation | Update behaviour |
|---|---|---|
| **Not mentioned** | `venueMeta.isExplicit = false`, value null | **Preserve** whatever is stored |
| **Explicitly none** | `venueMeta.isExplicit = true`, value null | **Clear** the stored value |
| **A real value** | `isExplicit = true`, value `"tpo"` | **Update** |

The trigger case: `"Venue: PFA seating plan"` — the email *does* speak about venue, but what
it says is not a venue (PFA = "please find attached"; that's attachment boilerplate). Before
`VenueMeta`, that produced plain `null`, indistinguishable from silence, so a stale
"auditorium" survived forever. `extractVenue` returns `{ value: null, isExplicit: true }` for
it, and `detectChanges` clears the field.

Same pattern appears in `"venue will be shared soon"` / `"tbd"` / `"after the PPT"` — all
matched by an explicit invalid-venue regex.

**And it's the same idea as the identity gate.** `VenueMeta` distinguishes silence from
denial on the *update* path; `AGREES / UNKNOWN / CONTRADICTS` distinguishes silence from
denial on the *identity* path. One lesson, two applications — that's a strong thing to point
out unprompted.

---

## Rescheduling — exactly how it works

Triggered inside `detectChanges` when the IST calendar keys differ.

```ts
if (isRescheduled) {
  updateData.status   = "rescheduled";
  updateData.eventKey = generateEventKey({
    company: existing.company,   // keep the stored identity attributes
    stage:   existing.stage,
    date:    incoming.date,      // ← new date
  });
}
```

**Why regenerate the key?** Because `eventKey` encodes the date. After a move to 25 Aug, a
*later* email about 25 Aug must find this event by exact key — not create a second one at
the vacated slot. Without regeneration the key still says 20 Aug and tier 1 misses forever.

**Why `existing.company` / `existing.stage` and not the incoming ones?** Because they're
identity attributes. A reschedule changes *when*, not *what*. Rebuilding the key from
incoming values would let a stage mis-extraction silently re-identify the event.

Note the key is regenerated but `status` is a one-way `"rescheduled"` — there is no
"rescheduled back to scheduled" transition. Fine in practice; worth knowing.

---

## Multi-event emails — stated honestly

**One email produces at most one event.** This is a deliberate MVP limitation, not an
oversight.

- Deterministic: `extractStage` checks keywords in priority order and returns the first hit
  (interview → test/OA → PPT → registration).
- AI: the prompt says *"If multiple events exist: extract the most important one. Prefer
  Interview > Test > PPT."*

**The real email that exposed this** (from the Notion issue log) announced a PPT at 3:45 PM
*and* an online test right after it, in one message, with the test's venue "to be shared
soon". The system produced one event.

**Why it wasn't fixed:** supporting N events per email means extraction returns an array,
matching runs per item, the decision layer needs a per-item outcome, and a partial failure
(2 of 3 matched) needs semantics. That's a large change, and the failure mode of getting it
wrong is *more* false merges — the failure I'd specifically engineered against.

**How I'd do it:** extraction returns `ExtractedEvent[]`; each element goes through the
existing gate → match → decide path independently, in one transaction per element; and
`EmailExtraction` becomes one row per extracted event rather than one per email.

That's an honest, complete answer to "what's a limitation of your system?" — much better
than pretending there isn't one.
