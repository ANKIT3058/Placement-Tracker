# Recognition Decision Matrix

Engineering Handbook — Backend
Status: canonical. Companion to `Event_Intelligence.md`.
Reflects the implementation **after AC-1** (loose-tier temporal bound).

`Event_Intelligence.md` explains how the system reasons. This document is the
exhaustive truth table of what it actually decides. Every row states the
architecturally expected behaviour, the current behaviour, and whether they
differ. Where they differ, the row is the authoritative bug report.

---

## How to read this document

**Confidence (`C`)** is the observation's own extraction confidence, computed
before any candidate is considered. It gates review and protects incumbents.

**Confidence alignment (`c`)** is a *matching* term: `min(incoming.confidence,
candidate.confidence)`. It contributes to tier-2 scoring only. `C` and `c` are
different quantities and are not interchangeable.

**Δ** is the absolute difference in days between the observation's date and a
candidate's date.

**Trusted** means `C ≥ 0.6`. **Untrusted** means `C < 0.6`.

### Reference constants

| Constant | Value | Governs |
|---|---|---|
| `CONFIDENCE_THRESHOLD` | 0.60 | Trusted vs. review |
| Tier-2 candidate window | ±3 days | Which events are scored |
| Tier-2 acceptance threshold | 0.50 | Soft match accepted |
| `LOOSE_MATCH_WINDOW_DAYS` | 30 | Tier-3 candidate window (**AC-1**) |
| Tier-3 uniqueness rule | exactly 1 | Loose match accepted |
| Tier-3 assigned confidence | 0.60 | Fixed, not computed |

### Recognition order

Tier 1 (exact key) → Tier 2 (soft, scored) → Tier 3 (loose, unique) → no match.
Each tier short-circuits on success. **Tier 2 filters candidates by company and
date only — not by round.** Tier 3 filters by company, round, and date.

---

## 1. Scoring model

```
score = 0.5·dateScore + 0.3·roundScore + 0.2·c        accept iff score ≥ 0.5
```

| Term | Value |
|---|---|
| `dateScore` | Δ=0 → 1.0 · Δ=1 → 0.7 · Δ=2–3 → 0.5 · Δ>3 → **early return, score 0** |
| `roundScore` | exact round match (case-insensitive) → 1.0, else 0 |
| `c` | `min(incoming.confidence, candidate.confidence)`, range 0–1 |

### Resolved score table

| Round | Δ | Score | Range over c ∈ [0,1] | Accepted? |
|---|---|---|---|---|
| Same | 0 | `0.80 + 0.2c` | 0.80 – 1.00 | **Always** |
| Same | 1 | `0.65 + 0.2c` | 0.65 – 0.85 | **Always** |
| Same | 2–3 | `0.55 + 0.2c` | 0.55 – 0.75 | **Always** |
| Same | >3 | 0 | 0 | Never (falls to tier 3) |
| **Different** | **0** | **`0.50 + 0.2c`** | **0.50 – 0.70** | **Always ⚠ D-1** |
| Different | 1 | `0.35 + 0.2c` | 0.35 – 0.55 | **iff c ≥ 0.75 ⚠ D-1** |
| Different | 2–3 | `0.25 + 0.2c` | 0.25 – 0.45 | Never |
| Different | >3 | 0 | 0 | Never |

**The decisive arithmetic:** the date term alone is worth exactly the
acceptance threshold. An exact date match therefore satisfies the bar with **zero
contribution from the round**, which is an identity attribute. This is D-1, and
it is the reason two different rounds run on one day merge.

---

## 2. Decision matrix

Decisions: **CREATE** · **UPDATE** · **NO-OP** · **REJECT** · **REVIEW** · **ABANDON**

### A. Same company, same round — the date boundary

All rows trusted (`C ≥ 0.6`), one candidate.

| # | Δ | Tier | Score | vs 0.5 | Decision | Expected | Current | Differ |
|---|---|---|---|---|---|---|---|---|
| A1 | 0 (key hit) | 1 | n/a (1.0) | n/a | UPDATE / NO-OP | UPDATE | UPDATE | No |
| A2 | 0 (key miss) | 2 | 0.80–1.00 | pass | UPDATE | UPDATE | UPDATE | No |
| A3 | 1 | 2 | 0.65–0.85 | pass | UPDATE + reschedule | same | same | No |
| A4 | 3 | 2 | 0.55–0.75 | pass | UPDATE + reschedule | same | same | No |
| A5 | 4 | 3 | fixed 0.6 | n/a | UPDATE + reschedule | same | same | No |
| A6 | 29 | 3 | fixed 0.6 | n/a | UPDATE + reschedule | same | same | No |
| A7 | **30** | 3 | fixed 0.6 | n/a | UPDATE + reschedule | same | same | No |
| A8 | **31** | — | no candidate | — | **CREATE** | CREATE | CREATE | No ✅ |
| A9 | ~190 (Mar↔Sep) | — | no candidate | — | **CREATE** | CREATE | CREATE | No ✅ |

**Why correct.** A1–A7 all describe one activity whose date moved; continuity is
preserved and the move is recorded as a reschedule. A8–A9 are the AC-1 fix: past
30 days, sole candidacy is no longer evidence of identity, so the system produces
a duplicate — visible and recoverable — instead of overwriting a real round.

**A2 is worth noting:** it is only reachable when tier 1 misses on an identical
date, which happens when the identity key differs by formatting or company
casing. Tier 2 then recovers it. This is the safety net that makes D-7 tolerable
today rather than catastrophic.

### B. Same company, different round — where the engine is wrong

Trusted, one candidate.

| # | Δ | Tier | Score | vs 0.5 | Decision | Expected | Current | Differ |
|---|---|---|---|---|---|---|---|---|
| B1 | **0** | 2 | **0.50–0.70** | **pass** | CREATE | CREATE | **UPDATE** | **YES ⚠ D-1** |
| B2 | 1, c ≥ 0.75 | 2 | 0.50–0.55 | pass | CREATE | CREATE | **UPDATE** | **YES ⚠ D-1** |
| B3 | 1, c < 0.75 | 2→3 | 0.35–0.49 | fail | CREATE | CREATE | CREATE | No |
| B4 | 2–3 | 2→3 | 0.25–0.45 | fail | CREATE | CREATE | CREATE | No |
| B5 | 31 | 3 | no candidate | — | CREATE | CREATE | CREATE | No |

**Why B1/B2 are wrong.** Round is one of three attributes that individuate a
placement activity. A pre-placement talk and an online assessment on the same day
are two activities; merging them destroys one. Tier 2 does not filter candidates
by round, and the score permits acceptance with `roundScore = 0`. The update then
writes the observation's time and venue onto the wrong Event — and since
`detectChanges` never compares round, the Event keeps its original round label,
leaving no trace that a merge occurred.

**Note on B3/B4:** these reach the correct outcome by accident of arithmetic, not
by design. Tier 3 excludes them properly (its query filters on round), but tier 2
declined only because the score fell short. Raising confidences would flip B3
into a merge.

### C. Different company

| # | Case | Tier | Decision | Expected | Current | Differ |
|---|---|---|---|---|---|---|
| C1 | Different company, any Δ | none — all tiers filter on company | CREATE | CREATE | CREATE | No |
| C2 | Same company, different **casing** | none — equality is case-sensitive | UPDATE | UPDATE | **CREATE (duplicate)** | **YES ⚠ D-7** |

**Why C2 matters.** Every tier matches company by exact equality. Text is
lowercased before extraction, so the pattern path always yields lowercase; the
model path is unconstrained and may return capitalised names. A casing difference
produces no candidates at any tier and silently creates a duplicate. The failure
direction is safe (duplicate, not merge), which is why this is debt rather than
an incident.

### D. Candidate count

| # | Case | Tier | Decision | Expected | Current | Differ |
|---|---|---|---|---|---|---|
| D1 | Zero candidates anywhere | — | CREATE | CREATE | CREATE | No |
| D2 | Tier 3: 2+ candidates in window | 3 | CREATE (ambiguity → no claim) | CREATE | CREATE | No |
| D3 | Tier 3: 2 all-time, 1 in window | 3 | UPDATE | UPDATE | UPDATE | No ✅ (AC-1) |
| D4 | Tier 2: several candidates | 2 | highest score wins | best *identity* | **best score, which can be the wrong Event** | **YES ⚠ D-1** |

**D3 is the intentional AC-1 behaviour change.** Before AC-1 the far candidate
made the set ambiguous (count 2), so no match was claimed and a duplicate was
created. The far candidate was never plausible; excluding it removes a spurious
ambiguity. Narrowing made the engine *more* permissive here, and correctly so.

**D4 is D-1 amplified.** Because `c = min(incoming, candidate)`, a candidate's
own stored confidence raises its score. Worked example — observation on day 0,
`C = 0.8`:

| Candidate | Round | Δ | c | Score |
|---|---|---|---|---|
| Correct round, stored conf 0.3 | same | 2 | 0.3 | 0.55 + 0.06 = **0.61** |
| Wrong round, stored conf 0.9 | different | 0 | 0.8 | 0.50 + 0.16 = **0.66** |

The wrong-round candidate wins. A well-established Event can out-compete the
correct one purely by being more confident, and a nearby correct match does not
protect against it.

### E. Confidence

| # | Case | Decision | Expected | Current | Differ |
|---|---|---|---|---|---|
| E1 | `C < 0.6`, no candidate | REVIEW | new Event in review | new Event in review | No |
| E2 | `C < 0.6`, candidate exists (recognisable) | flag the recognised Event for review | attach review to it, values untouched | **recognition discarded; a second Event created in review** | **YES ⚠ D-3** |
| E3 | `C < 0.6`, identity key collides exactly | REVIEW | some record of the doubt | **silently dropped — no create, no flag, no trace** | **YES ⚠ D-3** |
| E4 | `C ≥ 0.6`, matched, `C < existing.confidence` | REJECT | no write | no write | No |
| E5 | `C ≥ 0.6`, matched, no field differs | NO-OP | no write, no history | no write, no history | No |
| E6 | `C ≥ 0.6`, matched, `C ≥ existing`, fields differ | UPDATE | apply + record | apply + record | No |
| E7 | `C = 1.0`, matched Event is **confirmed** (conf 1.0) | REJECT | human outranks inference | **UPDATE — overwrites the human decision** | **YES ⚠ D-9 (new)** |

**E4/E5/E6 are the engine at its best** — the confidence comparator and
field-level minimality both behave exactly as the handbook specifies.

**E3 is the sharpest edge in the decision layer.** Whether an untrusted
observation produces a duplicate or vanishes entirely depends on whether its
identity key happens to collide, because creation is idempotent on that key. A
near-miss yields a duplicate; an exact hit yields silence.

**E7 is a defect not previously documented.** Manual confirmation sets an Event's
confidence to exactly 1.0. The incumbent guard is `newConfidence < existingConfidence`
— strictly less. A maximally-confident extraction also scores exactly 1.0
(reachable: known company, explicit date, explicit unestimated time, explicit
venue → 0.99 + 0.05 bonus → clamped to 1.0, no penalties). `1.0 < 1.0` is false,
so the update proceeds: it rewrites fields, and if the date differs it sets status
`rescheduled`, discarding `confirmed`. **A human decision can be silently
overwritten by inference** — a direct violation of `Event.md` invariant 4. See §5.

### F. Venue

| # | Case | Effect on recognition | Effect on Event | Expected | Current | Differ |
|---|---|---|---|---|---|---|
| F1 | Venue unmentioned | **none** | venue preserved | preserved | preserved | No |
| F2 | Venue explicitly different | **none** | updated + recorded | updated | updated | No |
| F3 | Venue explicitly cleared ("TBA") | **none** | cleared + recorded | cleared | cleared | No |
| F4 | Venue unmentioned — confidence effect | — | — | neutral (scored 0.5) | **scored 0.5 then penalised −0.15** | **YES ⚠ D-5** |

**Venue never participates in recognition.** No tier reads it. This is correct:
venue is descriptive, not individuating — two rounds are not different rounds
because the room changed.

**F1 vs F4 is an internal contradiction.** The update path honours *silence is not
deletion* perfectly. The confidence path scores an unmentioned venue neutrally —
a deliberate decision marked as such in the code — and then a flat penalty
subtracts 0.15 for the absent value anyway. The same silence is simultaneously
respected and punished.

### G. Viability gate (pre-recognition)

| # | Case | Decision | Expected | Current | Differ |
|---|---|---|---|---|---|
| G1 | No company extracted | ABANDON | recorded as ignored | ignored, **then overwritten to `completed`** | **YES ⚠ D-4** |
| G2 | Company extracted as `"unknown"` | ABANDON | treated as no company | **passes the gate; may CREATE an Event named "unknown"** | **YES ⚠ D-10 (new)** |
| G3 | No date, or date not `YYYY-MM-DD` | ABANDON | recorded as ignored | ignored, then overwritten | **YES ⚠ D-4** |

**G2 is a second new finding.** The pattern extractor substitutes the literal
string `"unknown"` when no valid company is found. The confidence scorer treats
`"unknown"` as a *missing* company (score 0), but the viability gate and the
completeness bonus both test truthiness, and `"unknown"` is truthy. Net effect: a
typical such observation reaches roughly `C ≈ 0.69`, clears the trusted threshold,
and creates a real Event whose company is `"unknown"`. That Event then becomes a
matching candidate for every future `"unknown"` observation, so unrelated
activities accumulate against one record — a merge vector with a different root
cause from D-1.

---

## 3. Complete state transition table

Event status. Guards in brackets.

| From | Event | To | History written? |
|---|---|---|---|
| — | CREATE, trusted | `scheduled` | No (creation is not a change) |
| — | CREATE, untrusted | `review` (+ reason) | No |
| — | CREATE, key collision | *(existing returned unchanged)* | No |
| `scheduled` | UPDATE, no date change | `scheduled` | Yes — per changed field |
| `scheduled` | UPDATE, date changed | `rescheduled` | Yes — date entry |
| `rescheduled` | UPDATE, date changed again | `rescheduled` | Yes |
| `scheduled` / `rescheduled` | REJECT `[C < existing]` | *unchanged* | No — by design |
| `scheduled` / `rescheduled` | NO-OP `[no field differs]` | *unchanged* | No — by design |
| `review` | manual confirmation | `confirmed` (conf → 1.0, reason cleared) | **No ⚠ G-4** |
| `scheduled` / `rescheduled` | manual confirmation | `confirmed` | **No ⚠ G-4** |
| `confirmed` | UPDATE `[C = 1.0]` | `scheduled` / `rescheduled` | Yes | **⚠ D-9** |
| `confirmed` | UPDATE `[C < 1.0]` | *unchanged* (rejected) | No |

**Two observations.** `confirmed` is intended to be terminal with respect to
inference; it is terminal only against `C < 1.0`. And the two transitions a human
causes are the only two that write no history — the system forgets exactly the
changes it should remember best.

---

## 4. Complete scoring and threshold reference

| Gate | Comparison | Operator | Consequence of the operator |
|---|---|---|---|
| Trusted vs. review | `C < 0.6` | strict `<` | `C = 0.6` exactly is trusted |
| Tier-2 acceptance | `score ≥ 0.5` | inclusive `≥` | a bare exact-date match (0.5) is accepted → D-1 |
| Tier-2 best candidate | `score > bestScore` | strict `>` | first candidate wins ties — order-dependent |
| Tier-3 uniqueness | `count === 1` | equality | 0 or 2+ → no claim |
| Tier-3 window | `|Δ| ≤ 30` | inclusive | Δ = 30 matches, Δ = 31 does not |
| Incumbent protection | `newC < existingC` | strict `<` | equal confidence **passes** → D-9 |
| Change detection | value differs | per field | date · time · venue **only** |

**Fields that can never change through automated update:** company, round.
`detectChanges` does not compare them, so a matched Event keeps its original
company and round regardless of what the observation said — and no history entry
is produced. This is what makes a false merge invisible: the surviving record
looks internally consistent.

---

## 5. Remaining inconsistencies after AC-1

Ordered by severity. **D-9** and **D-10** are new, surfaced by constructing this
matrix; the rest carry forward from `Event_Intelligence.md`.

| ID | Defect | Rows | Severity |
|---|---|---|---|
| **D-1** | Tier 2 accepts a same-date match with a mismatched round; date term alone meets the threshold | B1, B2, D4 | **Critical** — active false-merge path |
| **D-9** | *(new)* Incumbent guard is strict `<`, so a confidence-1.0 extraction overwrites a human confirmation | E7 | **Critical** — violates `Event.md` invariant 4 |
| **D-10** | *(new)* `"unknown"` company passes the viability gate and can create a matchable Event | G2 | **High** — second merge vector |
| **D-3** | Untrusted observations discard recognition; duplicate, or silent drop on key collision | E2, E3 | High |
| **G-4** | Manual confirmation writes no history | state table | High |
| **D-7** | Identity key unnormalised; company casing divergence creates duplicates | C2 | Medium |
| **D-5** | Confidence penalties double-count absences and punish venue silence the scorer neutralises | F4 | Medium |
| **D-4** | `ignored` outcome overwritten by `completed` | G1, G3 | Medium |
| **G-2/G-3** | No detection of false merges or duplicates | all | Medium |

### Correction to `Event_Intelligence.md`

D-7 is documented there as: the pattern extractor yields lowercase rounds while
the model yields capitalised ones, so the same activity produces different
identity keys depending on which extractor ran. **That is incorrect.** The pattern
extractor returns capitalised literals (`"OA"`, `"Interview"`, `"PPT"`,
`"Registration"`) irrespective of input casing, matching the model's vocabulary.
Round casing does not diverge between paths.

D-7 remains valid on its other grounds: the key applies no normalisation at all,
and **company** casing is genuinely unconstrained on the model path while the
pattern path is forced lowercase. Row C2 states the corrected form.

### Residual consideration on AC-1 itself

The 30-day bound is **per observation, not cumulative**. Each accepted reschedule
regenerates the identity key at the new date, so successive observations can walk
an Event forward in ≤30-day steps indefinitely. Three observations at 30-day
intervals move an Event 90 days with no rule violated. No evidence suggests this
occurs in practice, and the correct guard would be a distance from the Event's
*original* date — which is not currently retained on the Event, though history
preserves it. Recorded as a known limit of the chosen bound, not a defect.

---

## 6. Does AC-1 fully satisfy the Engineering Handbook?

**No. AC-1 fully resolves D-2 and nothing else. That was its stated scope, and it
achieved it completely.**

### What AC-1 settles

Tier 3 no longer asserts identity across unbounded time. Rows A8, A9 and D3
confirm the closure by execution. The handbook principle *an identity claim
requires uniqueness of interpretation* now holds at tier 3, because uniqueness is
finally scoped to a plausible range. The specific catastrophe the handbook named
— a March round rewritten as a September reschedule — is eliminated, and the
class of failure it belonged to (identity asserted over implausible temporal
distance) is closed at every tier: tier 2 was already bounded at ±3 days, tier 3
is now bounded at 30.

### What remains unsatisfied

Measured against the handbook's own invariants:

| Principle | Source | Status |
|---|---|---|
| Ambiguity never resolves into a selection | `Event_Intelligence.md` inv. 3 | **Violated at tier 2** (D-1) |
| Human confirmation outranks inference | `Event.md` inv. 4 | **Violated** (D-9) |
| Every accepted change is recorded | `EventUpdate.md` inv. 1 | **Violated on the human path** (G-4) |
| Silence is not deletion | `Event.md` inv. 5 | Upheld in updates; **violated in confidence scoring** (D-5) |
| No decision path degrades an Event | `Event_Intelligence.md` inv. 10 | **Violated** (D-1, D-9, D-10) |
| Identity is conceptual; the key approximates it | `Event.md` inv. 7 | **Undermined** (D-7) |
| Refusal is a valid terminal state | `Event_Intelligence.md` inv. 9 | Upheld |
| Recognition precedes mutation | `Event_Intelligence.md` inv. 1 | Upheld |
| Higher confidence is never overwritten by lower | `Event_Intelligence.md` inv. 4 | Upheld — but see D-9 for *equal* |
| One observation revises at most one Event | `Event_Intelligence.md` inv. 2 | Upheld |

**Verdict.** The engine's *architecture* conforms to the handbook. Its
*thresholds and guards* do not, in three material places. AC-1 closed the one the
handbook called most dangerous; D-1 is now the highest-severity open defect, and
D-9 is its equal in severity while being far cheaper to fix — a single comparison
operator.

Two of the three critical defects (D-9, D-10) are boundary conditions on
comparisons and truthiness rather than design errors. That is the encouraging
reading of this matrix: **the reasoning model is sound, and its remaining failures
are arithmetic.**

---

## Confidence

**High.** Every tier behaviour, threshold, operator, score, and state transition
is derived directly from the post-AC-1 source: the matching service and its
scoring function, the event repository's three candidate queries, the decision
layer, the update path and change detection, the confidence model with its
weights, bonus and penalty stack, the pattern extractors, and the manual
confirmation path. Score values in §1 and §2 are computed from the implemented
formula, not estimated.

Rows A8, A9, A7, D3, and the tier-1/tier-2 rows were verified by executing the
compiled service against a stubbed repository during AC-1. All other rows are
derived by reading, since the Jest suite cannot run in the current environment
(a missing MSVC runtime prevents Jest 30's native resolver from loading — an
environment gap, unrelated to any code in this repository).

D-9 and D-10 are traced from source and are not empirically reproduced; both
depend on reaching specific confidence values, and the arithmetic showing those
values are reachable is given inline. They should be confirmed with a test before
being treated as incidents.
