# Recognition Decision Matrix

Engineering Handbook — Backend
Status: canonical. Companion to `Event_Intelligence.md`.
Reflects the implementation **after AC-1 through AC-4** — loose-tier temporal
bound (AC-1 / `8edf87a`), identity-first recognition (AC-2 / `54584db`), manual
authority (AC-3 / `7c006a4`), and placeholder-company rejection (AC-4 /
`7c006a4`). Rows recording the defects those changes closed are retained as
history and labelled as such; the residual risks that remain are in §5.

`Event_Intelligence.md` explains how the system reasons. This document is the
exhaustive truth table of what it actually decides. Every row states the
architecturally expected behaviour, the current behaviour, and whether they
differ. Where they differ, the row is the authoritative bug report.

---

## How to read this document

**Confidence (`C`)** is the observation's own extraction confidence, computed
before any candidate is considered. It gates review and protects incumbents.

**Confidence alignment (`c`)** is a *matching* term: `min(incoming.confidence,
candidate.confidence)`. It contributes to tier-2 scoring only, and since AC-2 it
ranks candidates that have already been admitted rather than deciding admission —
except in the one band recorded as residual risk 2. `C` and `c` are different
quantities and are not interchangeable.

**Δ** is the absolute difference in days between the observation's date and a
candidate's date.

**Trusted** means `C ≥ 0.6`. **Untrusted** means `C < 0.6`.

### Reference constants

| Constant | Value | Governs |
|---|---|---|
| `CONFIDENCE_THRESHOLD` | 0.60 | Trusted vs. review |
| Tier-2 candidate window | ±3 days | Which events are considered |
| Tier-2 identity gate | AGREES / UNKNOWN / CONTRADICTS | Which considered events are scored (**AC-2**) |
| Tier-2 acceptance threshold | 0.50 | Soft match accepted, among those scored |
| `LOOSE_MATCH_WINDOW_DAYS` | 30 | Tier-3 candidate window (**AC-1**) |
| Tier-3 uniqueness rule | exactly 1 | Loose match accepted |
| Tier-3 assigned confidence | 0.60 | Fixed, not computed |

### Recognition order

Tier 1 (exact key) → Tier 2 (soft: gated, then scored) → Tier 3 (loose, unique)
→ no match. Each tier short-circuits on success.

**Tier 2 filters candidates by company and date only — not by round.** That is
deliberate and unchanged by AC-2: the engine has to *see* a contradicting
candidate in order to refuse it and to record that it did. The round is applied
immediately afterwards, in code rather than in SQL, as the identity gate. Tier 3
filters by company, round, and date, all in SQL — which is why its round
comparison is exact equality rather than the three-valued relation (residual
risk 3).

---

## 1. Scoring model

**Admission precedes scoring (AC-2 / ADR-006).** Since AC-2 the score decides
nothing about identity. A tier-2 candidate is first classified against the
observation's round — AGREES, UNKNOWN, or CONTRADICTS — and a CONTRADICTS
candidate is vetoed before the scorer is called. The model below therefore
describes **ranking among admitted candidates**, and its threshold is a similarity
floor rather than an identity gate.

```
score = 0.5·dateScore + 0.3·roundScore + 0.2·c        accept iff score ≥ 0.5
```

| Term | Value |
|---|---|
| `dateScore` | Δ=0 → 1.0 · Δ=1 → 0.7 · Δ=2–3 → 0.5 · Δ>3 → **early return, score 0** |
| `roundScore` | exact round match (case-insensitive) → 1.0, else 0 |
| `c` | `min(incoming.confidence, candidate.confidence)`, range 0–1 |

### Resolved score table

The rows are unchanged — no weight, band or threshold was altered by AC-2 — but
the `Different` rows now describe two different situations, and only one of them
is still reachable.

| Round relation | Δ | Score | Range over c ∈ [0,1] | Accepted? |
|---|---|---|---|---|
| AGREES | 0 | `0.80 + 0.2c` | 0.80 – 1.00 | **Always** |
| AGREES | 1 | `0.65 + 0.2c` | 0.65 – 0.85 | **Always** |
| AGREES | 2–3 | `0.55 + 0.2c` | 0.55 – 0.75 | **Always** |
| AGREES | >3 | 0 | 0 | Never (falls to tier 3) |
| **CONTRADICTS** | any | — | — | **Never — vetoed before scoring** *(was ⚠ D-1)* |
| **UNKNOWN** | **0** | **`0.50 + 0.2c`** | **0.50 – 0.70** | **Always — residual risk 1** |
| UNKNOWN | 1 | `0.35 + 0.2c` | 0.35 – 0.55 | **iff c ≥ 0.75 — residual risk 2** |
| UNKNOWN | 2–3 | `0.25 + 0.2c` | 0.25 – 0.45 | Never |
| UNKNOWN | >3 | 0 | 0 | Never |

**The decisive arithmetic, and what changed about it.** The date term alone is
worth exactly the acceptance threshold, so an exact date match satisfies the bar
with **zero contribution from the round**. That arithmetic is untouched. What AC-2
removed is the ability of a *contradicted* round to reach it — which was D-1, and
which is why two different rounds run on one day no longer merge. Where the round
is merely **unstated**, the same arithmetic still admits; ADR-006 rules that
silence is not denial, so this is a consequence of a stated decision rather than a
defect. Both UNKNOWN rows above are recorded in *Current residual recognition
risks*.

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

### B. Same company, different round — where the engine was wrong

Trusted, one candidate. **Both rounds resolved and different**, so the identity
relation is CONTRADICTS. The `Score` column is retained as history: since AC-2 no
score is computed for any row in this block, because the candidate is disqualified
before scoring.

| # | Δ | Tier | Score *(pre-AC-2)* | vs 0.5 | Decision | Expected | Current | Differ |
|---|---|---|---|---|---|---|---|---|
| B1 | **0** | 2 | 0.50–0.70 | pass | CREATE | CREATE | CREATE — vetoed, never scored | No *(was ⚠ D-1)* |
| B2 | 1, c ≥ 0.75 | 2 | 0.50–0.55 | pass | CREATE | CREATE | CREATE — vetoed, never scored | No *(was ⚠ D-1)* |
| B3 | 1, c < 0.75 | 2→3 | 0.35–0.49 | fail | CREATE | CREATE | CREATE — vetoed, never scored | No |
| B4 | 2–3 | 2→3 | 0.25–0.45 | fail | CREATE | CREATE | CREATE — vetoed, never scored | No |
| B5 | 31 | 3 | no candidate | — | CREATE | CREATE | CREATE | No |

**Why B1/B2 were wrong.** Round is one of three attributes that individuate a
placement activity. A pre-placement talk and an online assessment on the same day
are two activities; merging them destroys one. Tier 2 did not filter candidates
by round, and the score permitted acceptance with `roundScore = 0`. The update
then wrote the observation's time and venue onto the wrong Event — and since
`detectChanges` never compares round, the Event kept its original round label,
leaving no trace that a merge occurred.

**How they are closed (AC-2 / `54584db`).** The round is now classified before any
scoring: AGREES, UNKNOWN or CONTRADICTS. Every row in this block is CONTRADICTS,
so the candidate is vetoed by the identity gate and never reaches the scorer. The
outcome is CREATE regardless of Δ or confidence, which is what `Expected` always
required.

**Note on B3/B4:** these previously reached the correct outcome by accident of
arithmetic, not by design — tier 3 excluded them properly (its query filters on
round), but tier 2 declined only because the score fell short, and raising
confidences would have flipped B3 into a merge. That accident is no longer
load-bearing: B3 and B4 are now refused for the same categorical reason as B1 and
B2, and confidence cannot flip any of them.

> **The block's scope, stated precisely.** These rows govern a **contradicting**
> round. They say nothing about an **unstated** one: where either side's round is
> unresolved the relation is UNKNOWN, the candidate stays eligible, and the
> pre-AC-2 arithmetic in the `Score` column still applies. That case is not a
> defect and has no row here; it is recorded in *Current residual recognition
> risks*.

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
| D4 | Tier 2: several candidates | 2 | highest score among *admitted* candidates | best *identity* | best score among survivors; contradicting rounds are no longer among them | No *(was ⚠ D-1)* |

**D3 is the intentional AC-1 behaviour change.** Before AC-1 the far candidate
made the set ambiguous (count 2), so no match was claimed and a duplicate was
created. The far candidate was never plausible; excluding it removes a spurious
ambiguity. Narrowing made the engine *more* permissive here, and correctly so.

**D4 was D-1 amplified, and is closed by the same fix.** Because
`c = min(incoming, candidate)`, a candidate's own stored confidence raises its
score. Worked example — observation on day 0, `C = 0.8`:

| Candidate | Round | Δ | c | Score *(pre-AC-2)* | Now |
|---|---|---|---|---|---|
| Correct round, stored conf 0.3 | same | 2 | 0.3 | 0.55 + 0.06 = **0.61** | scored; wins |
| Wrong round, stored conf 0.9 | different | 0 | 0.8 | 0.50 + 0.16 = **0.66** | vetoed; never scored |

The wrong-round candidate used to win: a well-established Event could out-compete
the correct one purely by being more confident, and a nearby correct match did not
protect against it. Since AC-2 it is not a candidate at all, so the correct round
wins at 0.61 — the outcome `Expected` always specified. This is the case that
makes the ordering matter rather than the arithmetic: ranking was never the
problem, admission was.

**What D4 still shows.** Ranking among admitted candidates is decided by score,
and the scorer keeps the first strict maximum. Where several survivors tie, the
tier selects rather than refusing — unlike tier 3, which refuses on ambiguity.
That is the tiers' stated division of labour, not a defect.

### E. Confidence

| # | Case | Decision | Expected | Current | Differ |
|---|---|---|---|---|---|
| E1 | `C < 0.6`, no candidate | REVIEW | new Event in review | new Event in review | No |
| E2 | `C < 0.6`, candidate exists (recognisable) | flag the recognised Event for review | attach review to it, values untouched | **recognition discarded; a second Event created in review** | **YES ⚠ D-3** |
| E3 | `C < 0.6`, identity key collides exactly | REVIEW | some record of the doubt | **silently dropped — no create, no flag, no trace** | **YES ⚠ D-3** |
| E4 | `C ≥ 0.6`, matched, `C < existing.confidence` | REJECT | no write | no write | No |
| E5 | `C ≥ 0.6`, matched, no field differs | NO-OP | no write, no history | no write, no history | No |
| E6 | `C ≥ 0.6`, matched, `C ≥ existing`, fields differ | UPDATE | apply + record | apply + record | No |
| E7 | `C = 1.0`, matched Event is **confirmed** (conf 1.0) | REJECT | human outranks inference | REJECT — returned early by the confirmed-status guard | No *(was ⚠ D-9)* |

**E4/E5/E6 are the engine at its best** — the confidence comparator and
field-level minimality both behave exactly as the handbook specifies.

**E3 is the sharpest edge in the decision layer.** Whether an untrusted
observation produces a duplicate or vanishes entirely depends on whether its
identity key happens to collide, because creation is idempotent on that key. A
near-miss yields a duplicate; an exact hit yields silence.

**E7 was a defect surfaced by this matrix, and is now closed by a guard rather
than by a comparator change (AC-3 / `7c006a4`).**

*The original finding, which remains true of the comparator.* Manual confirmation
sets an Event's confidence to exactly 1.0. The incumbent guard is
`newConfidence < existingConfidence` — strictly less. A maximally-confident
extraction also scores exactly 1.0 (reachable: known company, explicit date,
explicit unestimated time, explicit venue → 0.99 + 0.05 bonus → clamped to 1.0,
no penalties). `1.0 < 1.0` is false, so that comparator does not reject the
update. **That is still the case: the comparator was deliberately not changed.**

*What closed the defect.* A categorical guard was added ahead of it: the update
path returns the existing Event unchanged when its status is `confirmed`, before
change detection and before the confidence comparison is reached. Authority is
treated as a kind, not a quantity — which is the point, because confidence 1.0
cannot distinguish "a person settled this" from "the extractor was very sure".
Tightening the comparator to `<=` was rejected precisely because it would express
that intent as a numeric coincidence, and would additionally reject equal-confidence
updates between two inferences, which is unrelated behaviour.

**Original comparator finding remains true, but its previously identified
overwrite consequence is closed by the confirmed-status guard.** `Event.md`
invariant 4 is upheld. The `<` comparator is retained in §4 as a live
implementation detail, not as a defect. See §5.

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
| G2 | Company extracted as `"unknown"` | ABANDON | treated as no company | ABANDON — rejected by `isResolvedCompany` | No *(was ⚠ D-10)* |
| G3 | No date, or date not `YYYY-MM-DD` | ABANDON | recorded as ignored | ignored, then overwritten | **YES ⚠ D-4** |

**G2 was a second new finding, and is now closed (AC-4 / `7c006a4`).**

*The defect.* The pattern extractor substitutes the literal string `"unknown"`
when no valid company is found. The confidence scorer treats `"unknown"` as a
*missing* company (score 0), but the viability gate and the completeness bonus
both tested truthiness, and `"unknown"` is truthy. Net effect: a typical such
observation reached roughly `C ≈ 0.69`, cleared the trusted threshold, and created
a real Event whose company was `"unknown"`. That Event then became a matching
candidate for every future `"unknown"` observation, so unrelated activities
accumulated against one record — a merge vector with a different root cause from
D-1.

*The fix.* The gate no longer tests truthiness. It calls `isResolvedCompany`,
which rejects a non-string, an empty or whitespace-only value, and the `"unknown"`
sentinel itself. The placeholder is therefore treated as a missing company, which
is what the Decision Model already specified for this case — no new outcome was
introduced. Because the gate runs before the identity key is generated and before
any candidate query, the placeholder never reaches the key, the candidate set, or
the database.

*Unchanged by this fix:* the completeness bonus still tests truthiness, so a
`"unknown"` company still contributes the +0.05 bonus while scoring 0. That
affects the confidence figure only. It cannot produce an Event, because the gate
above now refuses the observation before the figure is used.

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
| `confirmed` | UPDATE, any `C` | *unchanged* (rejected by the status guard) | No — *(was ⚠ D-9 at `C = 1.0`)* |

**Two observations.** `confirmed` is now terminal with respect to inference at
every confidence, because the guard tests status rather than the confidence
comparison — closing D-9 (AC-3 / `7c006a4`). Its two rows collapse into one, since
`C` no longer distinguishes them. And the two transitions a human causes remain
the only two that write no history — the system forgets exactly the changes it
should remember best (**G-4**, still open).

---

## 4. Complete scoring and threshold reference

| Gate | Comparison | Operator | Consequence of the operator |
|---|---|---|---|
| Trusted vs. review | `C < 0.6` | strict `<` | `C = 0.6` exactly is trusted |
| **Tier-2 identity gate** | round relation ≠ CONTRADICTS | categorical | runs before scoring; a contradicted round is never scored (AC-2) |
| Tier-2 acceptance | `score ≥ 0.5` | inclusive `≥` | a bare exact-date match (0.5) is accepted — reachable now only when the round is UNKNOWN (residual risk 1) |
| Tier-2 best candidate | `score > bestScore` | strict `>` | first candidate wins ties — order-dependent |
| Tier-3 uniqueness | `count === 1` | equality | 0 or 2+ → no claim |
| Tier-3 window | `|Δ| ≤ 30` | inclusive | Δ = 30 matches, Δ = 31 does not |
| **Manual authority** | `status === "confirmed"` | categorical | returns early, before change detection and before the comparison below (AC-3) |
| Incumbent protection | `newC < existingC` | strict `<` | equal confidence **passes** — retained deliberately; the D-9 consequence is closed by the guard above |
| **Company viability** | `isResolvedCompany(company)` | predicate | rejects empty, whitespace and the `"unknown"` sentinel before the key is built (AC-4) |
| Change detection | value differs | per field | date · time · venue **only** |

**Fields that can never change through automated update:** company, round.
`detectChanges` does not compare them, so a matched Event keeps its original
company and round regardless of what the observation said — and no history entry
is produced. This is what makes a false merge invisible: the surviving record
looks internally consistent.

---

## 5. Defect register

**D-9** and **D-10** were new when this matrix was constructed; the rest carry
forward from `Event_Intelligence.md`. The register is split into what has since
been closed and what remains. Closed entries keep their original defect text — the
reasoning that identified them is what constrains changes to these paths — and
gain the fixing commit and the mechanism that closed them.

### Closed

| ID | Original defect | Rows | Closed by | Current mechanism |
|---|---|---|---|---|
| **D-1** | Tier 2 accepts a same-date match with a mismatched round; date term alone meets the threshold | B1, B2, D4 | **AC-2 / `54584db`** | Round is classified AGREES / UNKNOWN / CONTRADICTS before scoring; a CONTRADICTS candidate is vetoed and never scored, so no score can admit it. Weights and threshold unchanged. |
| **D-2** | Weakest tier applies no date bound; a sole same-name candidate matches at any temporal distance | D3, B5 | **AC-1 / `8edf87a`** | The tier's candidate query requires date and window arguments; recognition passes ±30 days (`LOOSE_MATCH_WINDOW_DAYS`). |
| **D-9** | Incumbent guard is strict `<`, so a confidence-1.0 extraction overwrites a human confirmation | E7 | **AC-3 / `7c006a4`** — *closed by guard* | A categorical `status === "confirmed"` check returns early, ahead of change detection and of the comparator. **The comparator itself was deliberately not changed**, so the original finding remains true of it; the overwrite consequence is what closed. |
| **D-10** | `"unknown"` company passes the viability gate and can create a matchable Event | G2 | **AC-4 / `7c006a4`** | The gate calls `isResolvedCompany` instead of testing truthiness, rejecting the sentinel before the identity key, the candidate queries and any write. |

### Open

Ordered by severity.

| ID | Defect | Rows | Severity |
|---|---|---|---|
| **D-3** | Untrusted observations discard recognition; duplicate, or silent drop on key collision | E2, E3 | High |
| **G-4** | Manual confirmation writes no history | state table | High |
| **D-7** | Identity key unnormalised; company casing divergence creates duplicates | C2 | Medium |
| **D-5** | Confidence penalties double-count absences and punish venue silence the scorer neutralises | F4 | Medium |
| **D-4** | `ignored` outcome overwritten by `completed` | G1, G3 | Medium |
| **G-2/G-3** | No detection of false merges or duplicates | all | Medium |

### Current residual recognition risks

Distinct from both tables above, and deliberately **not** assigned `D-n` numbers:
a `D-n` marks implementation that contradicts stated intent, and each of these
follows from intent the architecture states and defends. They are recorded so that
closing D-1 and D-2 is not read as "recognition is now safe".

The dividing line is ADR-006's: **contradiction is not silence.** D-1 was a
*contradicted* identity attribute overruled by a score. Each risk below arises
where an attribute was never *stated*.

| # | Risk | Rows |
|---|---|---|
| **1** | Tier 2 admits on date proximity alone when the round is UNKNOWN on either side: Δ=0 scores exactly 0.50, meeting the threshold with zero contribution from stage and zero from confidence | §1 UNKNOWN Δ=0 |
| **2** | Confidence participates in admission in one narrow band: with UNKNOWN round and Δ=1, the candidate is admitted iff `min(incoming C, event C) ≥ 0.75` | §1 UNKNOWN Δ=1 |
| **3** | Tier 3 does not apply the semantic identity gate — it compares round by exact SQL equality, so two records carrying the unresolved-round sentinel compare equal, where tier 2 would classify the pair as UNKNOWN | D2, D3 |

Risk 3 is a real difference in identity protection between the tiers. It is
recorded as such rather than as a regression: tier 3's identity claim has always
rested on uniqueness rather than on attribute agreement, and AC-1 bounded that
claim in time without changing its nature.

No fix is proposed here for any of the three. No threshold, window, weight or gate
is revised by recording them.

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

## 6. Does the engine satisfy the Engineering Handbook?

**This section was written against AC-1 alone, when D-1, D-9 and D-10 were all
open. AC-2, AC-3 and AC-4 have since closed them.** The AC-1 assessment is kept
below as written, because it is an accurate record of what that one change did and
did not achieve; the conformance table that follows has been brought up to date.

**AC-1's own verdict, unchanged: it fully resolves D-2 and nothing else. That was
its stated scope, and it achieved it completely.**

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

Measured against the handbook's own invariants, after AC-1 through AC-4:

| Principle | Source | Status |
|---|---|---|
| Ambiguity never resolves into a selection | `Event_Intelligence.md` inv. 3 | Upheld against contradiction since AC-2. **Qualified** by residual risks 1 and 3, where the round is unstated rather than contradicted |
| Human confirmation outranks inference | `Event.md` inv. 4 | **Upheld** since AC-3 — the status guard, not the comparator |
| Every accepted change is recorded | `EventUpdate.md` inv. 1 | **Violated on the human path** (G-4) |
| Silence is not deletion | `Event.md` inv. 5 | Upheld in updates; **violated in confidence scoring** (D-5) |
| No decision path degrades an Event | `Event_Intelligence.md` inv. 10 | Upheld against D-1, D-9 and D-10. Still depends on recognition being right — see the residual risks |
| Identity is conceptual; the key approximates it | `Event.md` inv. 7 | **Undermined** (D-7) |
| Refusal is a valid terminal state | `Event_Intelligence.md` inv. 9 | Upheld |
| Recognition precedes mutation | `Event_Intelligence.md` inv. 1 | Upheld |
| Higher confidence is never overwritten by lower | `Event_Intelligence.md` inv. 4 | Upheld. The *equal*-confidence case still passes the comparator, but can no longer reach a `confirmed` Event |
| One observation revises at most one Event | `Event_Intelligence.md` inv. 2 | Upheld |

**Verdict.** The engine's *architecture* conformed to the handbook throughout; the
gap was always in its thresholds and guards. All four conformance issues that gap
produced are now delivered: AC-1 bounded the weakest tier, AC-2 put identity ahead
of similarity, AC-3 made human confirmation categorical, and AC-4 stopped the
placeholder company from becoming an Event.

The original reading of this matrix — *the reasoning model is sound, and its
remaining failures are arithmetic* — held up. Three of the four were closed by
adding a categorical check ahead of a numeric one rather than by retuning any
number: no weight, band or threshold in §1 or §4 was changed by any of them. What
remains open is one recognition-adjacent defect (**D-7**) and four elsewhere in the
decision layer; what remains *unclosed by design* is recorded as residual risks.

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

D-9 and D-10 were traced from source and never empirically reproduced; both
depended on reaching specific confidence values, and the arithmetic showing those
values are reachable is given inline. Both were closed by AC-3 and AC-4
(`7c006a4`) before that confirmation was attempted, so they are recorded as closed
by construction — the guard and the gate make the confidence value irrelevant —
rather than as reproduced and then fixed.

**Currency of this document.** §1, §2.B, §2.E, §2.G, §3, §4, §5 and §6 have been
reconciled against the post-AC-4 implementation. The closed-defect text is retained
as history and is labelled as such throughout; where a row's `Current` column
differs from what this matrix originally recorded, the original finding is shown
in italics beside it.
