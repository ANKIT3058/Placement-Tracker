# Event Intelligence

Engineering Handbook — Backend
Status: canonical. Companion to `01_Domain_Model/Event.md` and `01_Domain_Model/EventUpdate.md`.

`Event.md` defines what an Event is. `EventUpdate.md` defines how one is allowed to change.
This document defines **how the system decides** — how an uncertain observation becomes an authoritative revision, or fails to.

This is not a document about AI. Extraction is one input to the reasoning described here, and it is replaceable. The reasoning is not.

> **A note on this document's method.** Per the handbook's critical-analysis requirement, this document does not assume the implementation is correct. It separates **design intent** (what the architecture asserts), **current implementation** (what the code does), **known gaps** (intent not yet built), and **architectural debt** (implementation that contradicts intent). Several sections carry inline discrepancy flags, and a consolidated audit appears near the end. The system's reasoning model is sound; parts of its realisation are not, and this document says which.

---

# Executive Summary

**Purpose**

Event Intelligence is the layer that stands between what the system *observed* and what the system *believes*. Every message and document that enters the system produces claims about a placement activity — claims that are partial, inconsistently worded, sometimes wrong, and always uncertain. This subsystem decides what to do with them: whether they describe an activity already known, whether they are trustworthy enough to act on, and whether acting means creating, revising, deferring to a human, or doing nothing at all. It is the only place in the system authorised to change what is believed, and it is where the product's central promise — that a student can trust the timeline without checking it — is either kept or broken.

**Core Idea**

Uncertainty is not an error to be eliminated before acting; it is an input to the decision about whether to act at all.

**Primary Invariant**

No observation may modify an Event held with greater confidence, and no observation may modify an Event whose identity is ambiguous.

**Primary Failure Mode**

Two distinct real-world activities are recognised as one, silently overwriting a correct record with information belonging to a different round. The two paths that produced this in ordinary operation — **D-1** and **D-2** — are closed. The failure remains the primary one because prevention is still the entire defence: the system has no detection of any kind, and the narrower paths recorded under *Current residual recognition risks* still reach it.

---

# Domain Definition

**Event Intelligence is** the reasoning layer that converts uncertain observations into authoritative belief — the subsystem that receives structured claims about a placement activity, determines which Event those claims concern (or that they concern none, or that it cannot tell), weighs how much the claims should be trusted against how much the existing belief is trusted, and on that basis decides among a small, closed set of outcomes: create a new Event, revise an existing one, defer to a human, or decline to act. It owns no data of its own. It produces no facts. Its entire value lies in the quality of its judgements and in the discipline of its refusals — in knowing when the evidence is good enough to change what a student will act on, and when it is not.

---

# Problem Statement

## Why email is difficult

The system's inputs are messages written by people, for people, under time pressure, with no expectation that a machine will read them. Four properties make them hostile to automated reasoning:

**They are ambiguous about identity.** No message states which round it concerns. "The Amazon test has been moved to Friday" assumes a reader who knows which test. That assumption is safe for a human with context and unsafe for a system with a database.

**They are partial.** A venue correction names no date. A schedule names no company. The system must distinguish *"this field is unchanged"* from *"this field is now unknown"*, and the message itself does not mark the difference.

**They are inconsistently expressed.** The same company, round, and venue appear differently across senders and days. Identity must be inferred from text that was never standardised.

**They arrive out of order and overlap.** A correction may be processed before the announcement it corrects. Two messages may describe the same change. Nothing in the channel guarantees sequence.

## Why we cannot simply overwrite

Because the writes are not statements — they are **inferences of varying quality**. In a system where a human types a value, the newest value is authoritative by construction. Here the newest value is merely the most recent *guess*, and guesses vary enormously: a date read from "Interview on 16 August 2026" and a date read from "sometime next week" are not equally good, and treating them as equally good means the second silently destroys the first.

Overwriting also removes the system's ability to decline. A system that always writes has exactly one behaviour, which means it cannot express the single most important thing it knows about a bad extraction: *that it is bad*.

## Why ambiguity is dangerous

Ambiguity is dangerous specifically because **the natural response to it is a guess, and a guess is indistinguishable from knowledge once written.** If the system cannot tell whether a message concerns round A or round B and picks one, the resulting record carries no trace of the coin flip. A user reading it sees a confident answer. The information that the system was unsure is destroyed at exactly the moment it mattered.

This is why ambiguity must terminate in one of two places — a refusal, or a human — and never in a selection.

## Why false merges are worse than duplicates

This asymmetry is the organising principle of the entire subsystem, and it deserves stating precisely.

A **duplicate** — the same round appearing twice — is visible, self-announcing, and recoverable. The user sees two cards, notices, and can act. Nothing is lost; something is merely repeated.

A **false merge** — two distinct rounds collapsed into one record — is invisible, plausible, and unrecoverable. One round's information is overwritten by another's. The record looks entirely normal. There is no signal, no duplicate to notice, no error to log. The user, who trusts the system enough not to double-check, acts on a venue or time belonging to a different round. And the correct data is gone: the merge destroyed it.

The consequence: **every threshold, every tier, and every refusal in this subsystem should be read as an expression of the preference for duplicates over merges.** Where the implementation fails to express it, that is a defect — and this document identifies two places where it currently does not.

---

# Responsibilities

## Owns

- **The decision.** Create, revise, defer, or decline — the closed set of outcomes and the rules that select among them.
- **Identity recognition.** Determining which Event, if any, an observation concerns.
- **Trust adjudication.** Comparing the confidence behind claims to the confidence behind existing belief.
- **Escalation.** Routing what it will not decide alone to a human, with a reason.
- **Refusal.** Declining to act, which is a first-class outcome rather than a failure.

## Does not own

- **Extraction.** How text becomes claims belongs to interpretation. This layer consumes claims.
- **Truth.** The Event owns what is believed. This layer proposes and adjudicates; it does not store.
- **Memory.** History records accepted revisions; this layer causes them.
- **Acquisition.** It has never heard of a mailbox.
- **Presentation.** It surfaces nothing; the review queue is a consequence of its decisions, not a UI it owns.

---

# Recognition Pipeline

The real pipeline, as implemented:

```
  OBSERVATION                         a message body (documents do not
       │                              currently enter this pipeline — see
       │                              Gap G-6)
       ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ NORMALIZATION                                                 │
  │ whitespace collapsed, text lowercased                         │
  │ note: lowercasing is applied to the WHOLE body before any     │
  │ extraction, which has downstream identity consequences (D-7)  │
  └────────────────────────────┬─────────────────────────────────┘
                               ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ EXTRACTION (two independent strategies, merged)               │
  │                                                               │
  │   deterministic patterns ──┐                                  │
  │                            ├──► field-wise merge,             │
  │   model-based extraction ──┘    model preferred where present │
  │                                                               │
  │ model failure degrades to patterns silently — availability    │
  │ is preserved at the cost of consistency (D-7)                 │
  └────────────────────────────┬─────────────────────────────────┘
                               ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ CONFIDENCE                                                    │
  │ weighted field scoring  →  completeness bonus  →  penalties   │
  │ produces one scalar in [0,1]                                  │
  └────────────────────────────┬─────────────────────────────────┘
                               ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ VIABILITY GATE                                                │
  │ no company, or no well-formed date  →  ABANDON                │
  │ (an observation without identity anchors cannot be reasoned   │
  │  about at all)                                                │
  └────────────────────────────┬─────────────────────────────────┘
                               ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ RECOGNITION  (three tiers, first sufficient answer wins)      │
  │                                                               │
  │   tier 1  exact   identity key: company | stage | date        │
  │   tier 2  soft    same company, date within ±3 days;          │
  │                   identity gate FIRST — a CONTRADICTS round is│
  │                   vetoed and never scored (AC-2). Survivors   │
  │                   are then scored, accept if score ≥ 0.5      │
  │   tier 3  loose   same company + stage, date within ±30 days, │
  │                   accept ONLY if exactly one candidate exists │
  │                   (AC-1)                                      │
  │                                                               │
  │   otherwise → no identity claim                               │
  └────────────────────────────┬─────────────────────────────────┘
                               ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ TRUST GATE                                                    │
  │ confidence below threshold → REVIEW                           │
  │ (recognition result is computed before this gate and is       │
  │  DISCARDED on the review path — see D-3)                      │
  └────────────────────────────┬─────────────────────────────────┘
                               ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ DECISION                                                      │
  │   recognised + trusted     → adjudicate revision              │
  │   unrecognised + trusted   → CREATE                           │
  │   untrusted                → CREATE in review state           │
  └────────────────────────────┬─────────────────────────────────┘
                               ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ REVISION ADJUDICATION (only on the recognised path)           │
  │   compare field by field, considering only fields the         │
  │     observation actually spoke about                          │
  │   no differences            → NO-OP                           │
  │   incoming confidence lower → REJECT (protect stronger belief)│
  │   otherwise                 → apply + record, atomically      │
  │   date changed              → mark rescheduled, regenerate key│
  └────────────────────────────┬─────────────────────────────────┘
                               ▼
                          HISTORY + EVENT
                        (one indivisible act)
```

Two structural observations worth carrying forward. **Recognition precedes trust adjudication in execution but not in authority** — an untrusted observation never reaches an existing Event, because the review branch abandons the recognition result entirely. And **the pipeline has exactly one write point.** Everything before it proposes; only adjudication commits.

---

# Recognition Philosophy

Nine concepts, and the relations between them. This is the vocabulary the subsystem reasons in.

**Observation** — a single act of the system perceiving the world. Not a message: a message may yield one observation or none, and one observation may draw on a message's body and, in principle, its attachments. An observation is always *about* something and never *is* that thing.

**Evidence** — the retained record of what an observation saw, including the text it saw it in. Evidence outlives the decision made from it and is what allows a decision to be audited later.

**Candidate** — an existing Event that an observation *might* concern. Candidacy is cheap and plural: the system deliberately gathers several, because narrowing too early is how a correct match is missed.

**Identity** — the fact, in the world, that an observation and an Event concern the same activity. Identity is discovered, not assigned. The system can be wrong about it, and being wrong is a factual error rather than a policy choice.

**Match** — the system's *claim* that identity holds between an observation and one candidate. A match is an assertion with a confidence attached, not a fact. The distance between *match* and *identity* is precisely where false merges live.

**Conflict** — the situation where an observation and its matched Event disagree about a value. Conflict is normal and expected; it is what revision exists to resolve. Conflict is not evidence against the match — a rescheduled round *should* conflict on date.

**Confidence** — how much the system's claims should be relied on. It attaches both to observations and to Events, and comparing the two is what decides whether a revision is permitted.

**Decision** — the closed set of outcomes. Every observation terminates in exactly one.

**Human review** — the escape hatch for what the system will not decide alone. Not an error path: a designed destination.

## How they relate

```
   world:    IDENTITY  ──────────────────────── ground truth, unobservable
                 ▲
                 │  approximated by
                 │
   system:    MATCH  ◄── selected from ── CANDIDATES ◄── gathered for ── OBSERVATION
                 │                                                            │
                 │                                                     supported by
                 ▼                                                            │
             CONFLICT ──► resolved by ──► DECISION ◄── permitted by ──► CONFIDENCE
                                              │                              │
                                              └──► HUMAN REVIEW ◄────────────┘
                                                   when confidence is
                                                   insufficient or identity
                                                   is ambiguous
```

The chain worth memorising: **an observation gathers candidates; candidacy plus evidence yields a match; a match plus confidence yields permission; permission plus conflict yields a revision.** Break any link and the system either stops learning or starts corrupting.

---

# Matching Strategy

## How candidates are discovered

Recognition proceeds in tiers of decreasing evidential strength, stopping at the first tier that yields a sufficient answer. The reasoning behind tiering — rather than one scoring function over everything — is that **different qualities of evidence deserve different amounts of trust, and collapsing them into a single score hides which kind you had.**

**Tier 1 — exact description.** The observation's company, round, and date together match an existing Event's. All three identity attributes agree. This is the strongest possible non-human evidence and is accepted unconditionally.

**Tier 2 — near description.** Same company, and a date close enough that a reschedule or a reporting discrepancy is plausible. Candidates within a narrow window are gathered; each is first classified against the observation's round as AGREES, UNKNOWN or CONTRADICTS, and a CONTRADICTS candidate is disqualified outright. Only the survivors are scored on how well they agree, and the best is accepted if it clears a bar. This tier exists because real messages disagree about dates for benign reasons — a message may describe "the 20th" while the system recorded the 21st from an earlier, vaguer message.

**Tier 3 — sole candidate.** Same company and round, within a generous date window, accepted **only if exactly one such Event exists.** The reasoning is that uniqueness is itself a form of evidence: if a company has run exactly one round of this type in a plausible period, an observation about that round has only one thing it could mean. The window is what makes "exactly one" meaningful — over unbounded time a company's first round of a given type is trivially unique, which is what **D-2** exploited before AC-1 bounded it.

## How ambiguity is handled

By refusing. When the weakest tier finds more than one candidate, the system asserts nothing. It does not pick the closest, the newest, or the highest-confidence.

The reasoning is the failure asymmetry. Choosing among plausible candidates converts a *visible* failure (a duplicate the user notices) into an *invisible* one (a merge nobody notices). **An identity claim requires uniqueness of interpretation, not merely a best interpretation.**

## How uniqueness is determined

Three attributes individuate a placement activity: which company, which round, when. Tier 1 requires all three. Tier 2 relaxes the third within a narrow bound, and refuses any candidate that contradicts the second. Tier 3 relaxes the third within a wider bound but demands that the first two leave only one possibility.

The intended invariant across all three: **an Event is matched only when the evidence permits exactly one reading.**

> ## ✅ Closed architectural debt — the two tiers that violated this principle
>
> Both defects below were real, were reached in ordinary operation, and are now **closed**. They are retained in full because the reasoning that produced them is the reasoning that constrains any future change to these tiers. Their current status is carried in the Design Intent vs. Current Implementation audit; the residual risks that remain after them are recorded in *Current residual recognition risks*.
>
> **D-1 · Tier 2 accepted a same-date match regardless of round. — CLOSED by AC-2 (`54584db`).**
> *The defect.* The scoring function weights date proximity at 0.5 and accepts at a threshold of 0.5, so **an exact date match alone reached the acceptance bar with no contribution from anything else.** A round mismatch contributed zero — "no support", not "evidence against" — and therefore could not prevent acceptance. Two genuinely different rounds run by one company on one day — a pre-placement talk in the morning and an online assessment in the afternoon, which is an ordinary occurrence — were recognised as the same Event. The round, one of the three identity attributes, was effectively optional at this tier.
> *The fix.* Identity is now classified categorically **before** any scoring (ADR-006). A candidate whose round CONTRADICTS the observation is vetoed by the identity gate and never reaches the scorer, so no score at any date distance or confidence can admit it. The arithmetic above is unchanged; what changed is that contradiction is no longer something a score is permitted to overrule. Regression coverage sweeps every combination of Δ ∈ {0,1,2,3} × confidence ∈ {0, 0.25, 0.5, 0.75, 1.0} and asserts both that no match is returned **and** that scoring was never invoked — the ordering, not merely the outcome, is what is pinned.
>
> **BEFORE:** a contradicting round reached scoring, and the date term alone cleared the bar.
> **CURRENT:** a contradicting round is rejected before scoring, so admission cannot be reached at all.
>
> **D-2 · Tier 3 applied no date bound whatsoever. — CLOSED by AC-1 (`8edf87a`).**
> *The defect.* "Exactly one candidate" was evaluated across all time. An observation about a round in September matched a same-named round from the previous March if it was the only one on record — and because the dates differed, the revision was then classified as a **reschedule**, rewriting the old Event's date, marking it relocated, and regenerating its identity key. A year-old round was silently rebranded as the new one. This was the single most dangerous path in the subsystem, and it was reached precisely when the safer tiers found nothing.
> *The fix.* The weakest tier's candidate query now **requires** a date and a window as part of its signature — a caller cannot reintroduce the unbounded query by omission — and recognition passes `LOOSE_MATCH_WINDOW_DAYS` (30). Uniqueness is evidence only inside a plausible range; outside it the tier yields no match, which creates a duplicate rather than corrupting an existing Event. Regression coverage includes the original March-vs-September case and both inclusive window boundaries at exactly ±30 days.

---

# Confidence Model

The most consequential concept in the system, and the most frequently misunderstood.

## What confidence represents

Confidence is a scalar in [0,1] expressing **how much the system's own extraction should be relied upon.** It is a statement about the quality of an inference, derived from *how the information was obtained* rather than from what it says.

The inputs to that judgement are structural: was the date stated explicitly or inferred from "next week"? Was the time given, or estimated from "morning"? Was the venue named, or absent? Was the company identified at all? A claim built from explicit statements scores high; a claim assembled from hedges and inference scores low.

## Why it exists

Because a system that infers must be able to represent *not knowing*. Without such a representation there are exactly two possible behaviours — act on everything, or act on nothing — and both are wrong. Confidence is what gives the system a third option: **act conditionally.**

## How it influences behaviour

Confidence appears at three decision points, and it is worth seeing that it does different work at each:

1. **Admission.** Below the acting threshold, an observation may not modify anything; it becomes a review item. Confidence here is a *gate*.
2. **Protection.** An observation may not overwrite an Event whose confidence is higher. Confidence here is a *comparator* — the mechanism that makes belief defensible against later, weaker inference.
3. **Recognition.** Confidence alignment between an observation and a candidate contributes to match scoring. Here it is *corroborative evidence*: two well-extracted records agreeing is stronger evidence of identity than two poorly-extracted ones agreeing.

## Why confidence is not probability

This distinction matters and is routinely lost.

A probability would be a calibrated claim about the world: *there is a 78% chance this event is on the 16th.* Nothing in the system produces or validates such a claim. There is no ground-truth corpus, no calibration, no measured error rate. The number is a weighted aggregation of structural signals about extraction quality, and its absolute magnitude has no empirical meaning.

What it does have is **ordinal meaning within the system.** 0.8 is more trustworthy than 0.5 in the specific sense that its underlying extraction rested on firmer signals. That is enough for every decision the system makes, because every one of those decisions is a *comparison* — against a threshold, or against another confidence — and never a probabilistic computation.

The practical consequence: **do not reason about confidence as a likelihood, and do not display it to users as one.** It cannot support statements like "80% likely to be correct." It can support "this was extracted from firmer evidence than that."

## Why confidence is permission to act

The cleanest way to hold the concept. Confidence is not a quality metric, not telemetry, not a debugging aid, and not a display value. It is **the credential an observation presents when it asks to change what a student will act on.** Insufficient credential, no write. Weaker credential than the incumbent, no write. This framing explains every use of the value in the system and is the reason it lives on the Event rather than only on the observation.

## The model, stated

Confidence is a weighted sum over field-level quality scores, adjusted:

```
   base    =  Σ  wᵢ · scoreᵢ
              i ∈ {date, time, company, stage, venue}

   weights:   date 0.35 · company 0.25 · time 0.20 · stage 0.10 · venue 0.10

   bonus   =  +0.05  when company, date and stage are all present
              (a complete identity triple is worth more than its parts)

   penalty =  0.10  company unidentified
            + 0.15  no venue value
            + 0.10  no time value

   final   =  clamp₀¹( base + bonus − penalty )
```

The weighting encodes a domain judgement worth stating: **date dominates because it is what the user acts on, and because it is an identity attribute.** Venue and round are weighted lightly because they are descriptive — getting the venue wrong is recoverable, getting the date wrong means missing the round.

The field scores themselves encode a second judgement: an explicitly stated value outranks an inferred one. A date drawn from a full calendar reference scores 1.0; one drawn from "tomorrow" scores 0.8; one drawn from "next week" scores 0.5. This is the *how it was obtained* principle made concrete.

> ## ⚠ Architectural debt — the penalty stack contradicts the weighted model
>
> **D-5 · Missing fields are counted twice, and one penalty inverts a deliberate design decision.**
>
> The weighted model already accounts for absence: a missing time scores zero and therefore contributes zero of its 0.20 weight. The penalty stack then subtracts a *further* 0.10 for the same fact. Missing time and unidentified company are both double-counted.
>
> The venue penalty is worse than redundant — it is contradictory. The field scorer deliberately assigns an **unmentioned** venue a neutral 0.5 rather than 0, with an explicit comment marking this as an important design decision. The reasoning is exactly the domain's *silence is not evidence of absence* principle: a message that does not mention a venue has said nothing about it and should not be punished for staying quiet. The penalty stack then subtracts a flat 0.15 whenever no venue **value** is present — which is true precisely in the unmentioned case. **The penalty undoes the principle the scorer was written to uphold.**
>
> The net effect is a model with two overlapping mechanisms expressing the same signals with different sign conventions, where the later-added one silently overrides a documented decision of the earlier. This is not merely untidy: it makes the threshold's meaning opaque, because a given confidence value no longer corresponds to a stable statement about evidence quality.
>
> **Consequence for the review path.** Working the arithmetic: with company, date and round present, an observation missing *only* time or *only* venue still clears the threshold comfortably. Review is reached chiefly when **both** time and venue are absent, or when a vague date coincides with another absence. Human review is therefore a narrower safety valve than the architecture implies — it catches sparse extractions, not wrong ones. **Nothing routes a confidently-wrong extraction to a human**, because confidence measures completeness of evidence, not correctness of conclusion.

---

# Decision Model

Every observation terminates in exactly one outcome. The set is closed, and each member exists for a distinct reason.

| Outcome | Condition | Why it exists |
|---|---|---|
| **Abandon** | No company, or no well-formed date | An observation lacking identity anchors cannot be reasoned about at all. Proceeding would mean inventing identity. |
| **Review** | Confidence below the acting threshold | The system will not act on weak evidence, and refuses *without* disturbing existing belief. The escape hatch that makes aggression elsewhere safe. |
| **Create** | Trusted, and no Event recognised | The observation describes something new. The default when identity is genuinely absent. |
| **No-op** | Recognised, trusted, but nothing differs | Restating a belief is not a change. Prevents history from recording traffic instead of movement. |
| **Reject** | Recognised, but incoming confidence lower than incumbent | Protects a stronger belief from a weaker one. The mechanism that makes confidence meaningful rather than decorative. |
| **Update** | Recognised, trusted, confidence sufficient, fields differ | The normal path. Applies only fields the observation spoke about, and records each. |
| **Reschedule** | An update in which the date changed | A distinct outcome because relocating an activity in time is materially different from correcting its description, and alters an identity attribute. |

Two properties of the set are worth naming. **Four of seven outcomes change nothing** — abandon, review, no-op, reject. A system whose most common outcome is inaction is behaving correctly here, not failing. And **no outcome degrades an Event**; every path either improves belief or leaves it untouched.

> ## ⚠ Architectural debt — the review outcome produces duplicates or silence
>
> **D-3 · The review path discards recognition, and then may silently discard the observation itself.**
>
> Recognition is computed *before* the trust gate, and its result is **abandoned** when the observation is untrusted. A low-confidence observation of an activity the system already knows about does not flag that Event for review — it creates a **second, separate Event** in the review state. The review queue therefore fills with duplicates of existing rounds rather than with doubts about them.
>
> The code marks this deliberate — the safe option, chosen so that an untrusted observation cannot disturb a trusted Event. That reasoning is sound and the protection is real. But the implementation reaches it by the crudest available means, and pays a cost the intent did not require: the system knows which Event the observation probably concerns and throws that knowledge away. Attaching a review flag to the recognised Event, without modifying its values, would preserve the protection and eliminate the duplicate.
>
> **The sharper edge:** creation is idempotent on the identity key. When a low-confidence observation's company, round, and date exactly match an existing Event, creation returns the existing Event unchanged — **no duplicate, no review flag, no record that a doubtful observation was seen at all.** The observation vanishes. The outcome depends entirely on whether the identity key happens to collide: a near-miss produces a duplicate, an exact hit produces silence. Neither is the intended behaviour, and the second is a genuine loss of information.
>
> **D-4 · The abandon outcome is not observable.** Abandoned observations are marked as ignored, and the surrounding processing step then unconditionally overwrites that marking with *completed* on return. The distinction between "we processed this" and "we deliberately declined to reason about this" is destroyed in the data. Any future attempt to measure how much inbound mail is non-actionable will find the answer has not been recorded.

---

# False Merge vs Duplicate

## Why the asymmetry governs everything

Restating precisely, because this section is the subsystem's constitution:

| | Duplicate | False merge |
|---|---|---|
| Visible to user | Yes — two cards | No — one plausible card |
| Detectable by system | In principle | No signal exists |
| Information destroyed | None | One round's data, permanently |
| User's likely action | Notices, investigates | Acts on wrong information |
| Recoverable | Yes | No |

A duplicate is an **embarrassment**. A false merge is a **silent data-loss event that the product's own trust proposition converts into a missed placement round.** They differ by orders of magnitude in cost, and the architecture should differ correspondingly in how hard it works to avoid each.

## How the architecture reflects the preference

Where it is honoured, it appears as:

- **Tiered recognition** rather than one permissive score — the strongest evidence is tried first and short-circuits.
- **A uniqueness requirement at the weakest tier** — ambiguity yields no claim.
- **A narrow date window at the middle tier** — bounding how far identity may stretch.
- **The trust gate** — untrusted observations cannot reach existing Events at all.
- **The confidence comparator** — weak inferences cannot overwrite strong belief.
- **Field-level updates** — an observation revises only what it spoke about, so a partial match cannot blank unrelated fields.

## Where it was violated, and what remains

Historically: in the two places most likely to matter.

**D-1** made the middle tier accept a same-date match with a mismatched round, merging two distinct rounds run on one day. **D-2** made the weakest tier accept a sole candidate at unbounded temporal distance, merging rounds separated by months and then misclassifying the merge as a reschedule. Both converted the preferred failure (duplicate) into the catastrophic one (merge), and both were reached in ordinary operation rather than in edge conditions.

Both are closed — D-1 by AC-2 (`54584db`), D-2 by AC-1 (`8edf87a`). **The architecture's stated preference is now expressed by the recognition path itself**: contradiction disqualifies before similarity is consulted, and uniqueness is only evidence inside a bounded range. What each fix does when it declines is create a duplicate, which is the recoverable direction.

That is not the same as saying the preference is fully enforced. Three narrower paths still admit on thinner evidence than the principle implies, and they are recorded in *Current residual recognition risks*. The difference is one of kind: those are cases where an identity attribute was **unstated**, not cases where it was **contradicted**.

## Trade-offs of the preference itself

Preferring duplicates is not free, and the cost should be acknowledged rather than assumed away. Duplicates degrade the product surface: a timeline showing one round twice is a timeline the user trusts less, and enough duplicates produce the same abandonment that a false merge produces, only more slowly. A system tuned too conservatively is not obviously safe — it is merely failing in a more visible direction.

The reason the preference still holds is **recoverability**: a duplicate can be corrected by a human in seconds and leaves the underlying data intact, while a merge cannot be corrected at all because the information needed to correct it has been overwritten. The bias is toward the failure that preserves the ability to recover, not toward the failure that is less common.

---

# Engineering Decisions

### Three-tier recognition

**Decision** — Try exact identity, then bounded-proximity scoring, then sole-candidate, stopping at the first sufficient answer.

**Reason** — Different qualities of evidence warrant different levels of trust. Tiering keeps that visible: the system knows not just *that* it matched but *on what basis*, which is the information needed to decide how much to believe the match.

**Rejected alternatives** — A single scoring function over all candidates was rejected because it flattens evidence quality into one number, making "all three attributes agreed" indistinguishable from "the date was close and the score happened to clear the bar." Exact-match-only was rejected because human-written text rarely agrees exactly and the system would create a duplicate on every minor discrepancy.

**Trade-offs** — Three tiers mean three sets of thresholds to reason about and three distinct failure modes. Tier boundaries create discontinuities: an observation just outside the middle tier's window falls through to a much weaker tier rather than being scored on a continuum. **D-2 was a direct consequence of this shape** — falling through to the weakest tier is the dangerous path, and it is entered precisely when the safer tiers declined. AC-1 bounded that tier in time rather than removing the discontinuity, so the shape and its cost remain: the weakest tier is still the one entered when evidence is thinnest, and it is still the tier with the least identity protection (see *Current residual recognition risks*).

### Candidate narrowing

**Decision** — Gather candidates by company plus a bounded date window, then score within that set.

**Reason** — Narrowing on the cheapest, most reliable discriminator first keeps the scored set small and excludes the overwhelming majority of Events without expensive comparison. Company is the strongest available filter and the least likely to be misextracted.

**Rejected alternatives** — Scoring all Events was rejected as unnecessary and, more importantly, as widening the false-merge surface: every additional candidate is another chance for a spurious high score. Narrowing on company *and* round was rejected because it would make cross-round recognition impossible, and the middle tier exists partly to catch round-name variation.

**Trade-offs** — Company is matched by exact equality, so any variation in how a company is named produces no candidates and therefore a duplicate. This is the deliberate direction of failure, but it means recognition quality is bounded by extraction's naming consistency — and nothing normalises company names.

### Confidence thresholds

**Decision** — A single global threshold separates act-automatically from route-to-human, and a pairwise comparison protects incumbent belief.

**Reason** — A single threshold is comprehensible and tunable. Pairwise comparison is what makes belief defensible rather than merely current.

**Rejected alternatives** — Per-field thresholds were rejected as over-engineered relative to what the confidence model can support. Always asking a human was rejected because it destroys the product's core promise that the user does nothing. Never asking was rejected because it removes the only safety valve.

**Trade-offs** — One threshold is a blunt instrument: it errs quietly in both directions, and there is no calibration data to tune it against. As documented in **D-5**, it currently separates *sparse* extractions from *complete* ones rather than *unreliable* from *reliable* — those are different questions, and only the second is the one worth asking.

### Field weighting

**Decision** — Weight date most heavily, then company, time, round, venue.

**Reason** — Weights encode consequence. A wrong date makes the user miss a round; a wrong venue makes them walk to the wrong building. Date and company are also identity attributes, so errors there propagate into recognition and can cause merges.

**Rejected alternatives** — Uniform weighting was rejected as treating a wrong venue as equivalent to a wrong date. Learned weights were rejected for want of labelled outcome data — there is no ground truth to learn from.

**Trade-offs** — Weights are hand-tuned intuitions never validated against outcomes. Round is weighted at 0.10 despite being an *identity* attribute, which understates its importance to recognition — the same judgement that produced **D-1**. AC-2 removed round from the scorer's authority rather than reweighting it: the round now decides eligibility categorically before scoring, and its 0.10 weight ranks eligible candidates only. The weight is therefore no longer load-bearing for identity, and the confidence model still carries it unchanged (**D-6**).

### Date handling

**Decision** — Treat the date as both a described value and an identity attribute; a change to it is a reschedule, which regenerates the identity key.

**Reason** — Relocating an activity in time is the most consequential change for the user and genuinely alters what distinguishes the activity. Regenerating the key means later observations recognise the round at its new position rather than the vacated one.

**Rejected alternatives** — Treating date as an ordinary field was rejected because later observations would then fail exact recognition and create duplicates — a reschedule would manufacture the exact problem the model prevents. A stable synthetic identifier independent of attributes was rejected as unavailable: nothing in a message carries one.

**Trade-offs** — Identity keyed on a mutable attribute invites the misreading that identity itself is mutable, which `Event.md` exists partly to prevent. It also means **any wrong date creates a wrong identity**, so an extraction error propagates from description into recognition. And because reschedule is *inferred from* a date difference rather than stated by the message, a false merge is reported to the user as a legitimate reschedule — the most misleading possible presentation of that failure. **D-2** was the widest route to it; AC-1's 30-day bound narrows how far such a merge can reach, but the presentation problem is a property of inferring reschedule from a date difference and is untouched by that bound.

### Venue handling

**Decision** — Track not just the venue value but whether the message *spoke about* venue at all, and treat unmentioned as neutral rather than absent.

**Reason** — The domain's silence-is-not-deletion rule. Most messages are partial; if absence were read as a negative assertion, every partial message would erase good data. Distinguishing "said nothing" from "said there is none" is what makes incremental accumulation safe.

**Rejected alternatives** — Treating a missing value as a clear instruction was rejected as continuously destructive. Never clearing a venue was rejected because an explicit correction to "to be announced" is real information the user needs.

**Trade-offs** — Requires carrying explicitness alongside every venue value, which complicates the plumbing. And as **D-5** documents, the principle is honoured in the update path and in field scoring, then partially undone by a flat penalty that punishes silence anyway — an inconsistency between two parts of the same subsystem.

### Manual review

**Decision** — Low-confidence observations become human-adjudicated items rather than automatic writes, and human decisions outrank subsequent inference.

**Reason** — The student is the only party who can resolve genuine ambiguity, and is already in the loop. Making that explicit lets the automated path be aggressive elsewhere without risking trust.

**Rejected alternatives** — Discarding low-confidence observations was rejected as information loss. Applying them with a warning was rejected because a warning attached to data the user acts on is not a safeguard.

**Trade-offs** — Every queue item is a partial failure of automation and a direct cost to the user; queue volume is the honest measure of extraction quality. The realisation carries **D-3**'s duplicate-or-silence problem, and the queue currently receives only *sparse* extractions, never *wrong* ones — so the safety valve does not cover the failure mode that matters most.

### Identity model

**Decision** — Identity is grounded in the real-world activity and approximated by a derived key over company, round, and date.

**Reason** — No message declares which round it concerns, so identity must be inferred. Grounding it in the activity rather than in any message is what allows many observations — and, in future, documents — to converge on one Event.

**Rejected alternatives** — Message-derived identity was rejected because it produces one Event per message, which is the pile-of-duplicates outcome. Content-hash identity was rejected because text is unstable across senders and parser versions. Embedding-based identity was rejected as unjustifiable given no labelled data to validate it against and no way to explain a match to a user.

**Trade-offs** — Inference can be wrong in both directions, and the design accepts that while biasing toward the recoverable failure.

> **D-7 · The identity key is not normalised, and extraction path affects it.** The key is assembled from raw extracted values with no case or whitespace normalisation. Because the message body is lowercased before extraction, pattern-derived values arrive lowercase, while the model-based extractor is instructed to return a capitalised vocabulary for the round. The two extraction strategies therefore produce **different identity keys for the same real activity**, and which one is used depends on whether the model was enabled and whether the call succeeded — a silent per-message fallback. The consequence is that exact recognition fails across that boundary and the observation drops to the weaker tiers — historically where **D-1** and **D-2** lived, and still where the residual risks below are concentrated. An identity key that varies with infrastructure state is not an identity key; normalising it is cheap and should precede any threshold tuning. **D-7 remains open.**

---

# Invariants

The architectural laws of reasoning. Marked where the implementation does not currently uphold them.

**1. Recognition precedes mutation.** Nothing is written before the system has decided what it is writing about. *Upheld.*

**2. One observation never revises more than one Event.** A single observation resolves to at most one identity. Revising several would mean the system was unsure which one it meant and wrote to all of them. *Upheld.*

**3. Ambiguity never resolves into a selection.** When evidence permits more than one reading, the system makes no identity claim. *Upheld in the weakest tier's uniqueness rule, and — since AC-2 closed **D-1** — in the middle tier, where a contradicting identity attribute now disqualifies a candidate before it can be scored. Qualified: an **unstated** round is deliberately treated as no claim rather than as ambiguity, which is what residual risks 1 and 3 rest on.*

**4. Higher confidence is never overwritten by lower.** The comparator that makes belief defensible. *Upheld.*

**5. Untrusted observations never modify existing belief.** Below the threshold, nothing existing may be touched. *Upheld — this is the one protection the review path implements correctly, at the cost described in **D-3**.*

**6. Silence is not deletion.** An observation revises only fields it actually spoke about. *Upheld in the update path; contradicted in confidence scoring by **D-5**'s venue penalty.*

**7. Identity is conceptual; the key is an approximation.** The key is a fast path to recognising continuity, never the identity itself. *Upheld in design; undermined by **D-7**'s non-normalised key.*

**8. Every decision terminates in exactly one outcome.** No observation is partially applied and none is processed twice to different ends. *Upheld.*

**9. Refusal is a valid terminal state.** Declining to act is a decision, not a failure, and requires no compensating action. *Upheld.*

**10. No decision path degrades an Event.** Every outcome either improves belief or leaves it untouched. *Upheld under correct recognition. **D-1** and **D-2** violated it by writing correct data into the wrong Event — the degradation being of a different Event than the one being reasoned about — and both are now closed. The invariant still depends on recognition being right: any residual risk below is a route to the same class of degradation, on thinner evidence.*

**11. Every accepted revision is recorded.** *Violated on the human path — manual confirmation writes no history (see `EventUpdate.md`).*

---

# Failure Handling

**Ambiguous recognition.** Handled by refusal at the weakest tier, which produces a duplicate rather than a guess — the intended direction. Handled at the middle tier since AC-2 closed **D-1**: a candidate whose round contradicts the observation is vetoed before it can be scored, and the veto is logged with its reason, so a refusal is observable rather than silent.

**Duplicate Events.** Accepted as the tolerable failure. There is no deduplication pass, no merge tooling, and no detection: duplicates are found by users looking at their timeline. Tolerable while volume is low; it means the preferred failure mode is also unmanaged.

**False merge prevention.** The tiering, the identity gate, the ±3-day and ±30-day windows, and the uniqueness rule are the preventive mechanisms. **D-1** and **D-2** were the two widest holes and are closed; the residual risks below are what remains, and they are narrower but not nil. Prevention is still the entire defence, because there is **no detection whatsoever** — a false merge produces no error, no anomaly, and no flag. The only signal is a user noticing that a round's details are wrong, which requires them to already doubt the system (**G-2**).

**Human correction.** The one reliable repair path. A human sets values, raises confidence to certainty, and clears the doubt marker, after which inference does not silently override. It does not currently repair a false merge, because the merged-away round's data is gone and nothing indicates a merge occurred.

**Recovery.** Structurally strong, operationally unrealised. Observations are retained with their extracted claims and raw text, so belief could in principle be rebuilt if the reasoning rules improved. No such rebuild path exists, and history — which would identify affected Events — has no read surface. **The system has the data required to recover from a bad reasoning change and no mechanism to use it.**

**Failure preference.**

```
   correct  >  duplicate  >  routed to human  >  no-op  >  false merge
```

Note where "routed to human" sits: below a duplicate, because it costs user attention, and far above a merge. The ordering the implementation currently produces diverges from this in the two documented cases.

---

# Consistency Guarantees

**Single-outcome determinism.** Every observation terminates in exactly one outcome. No partial application.

**Recognition-before-mutation.** No Event is modified before its identity has been determined.

**Monotonic confidence under automation.** Automatic updates never lower an Event's confidence, since a lower-confidence observation cannot be applied. Human confirmation sets certainty directly.

**Field-level minimality.** A revision touches only fields the observation spoke about *and* that actually differ. An unrelated field cannot be collaterally modified by a matched observation.

**Atomic revision.** An accepted change and its history entries commit together or not at all.

**Order independence, qualified.** Correctness does not depend on processing order, because adjudication is trust-based rather than recency-based: a weaker late arrival is rejected on its merits. *Qualification:* order still affects outcomes through recognition. Which Event exists first determines what a later observation can match, so processing order influences which Events are created and which are merged. AC-1 bounded how far that reach extends in time; it did not make recognition order-independent.

**No cross-Event consistency.** Reasoning is per-Event. No transaction spans several, and a single observation affects at most one.

**Idempotency.** Re-processing an already-applied observation produces a no-op, since comparison finds no differences. Re-processing is safe and does not inflate history.

**What is explicitly not guaranteed:** that a recognised match is correct; that a duplicate will be detected; that a false merge will be detected; that the confidence threshold correlates with correctness; that a wrong-but-complete extraction will ever reach a human.

---

# Design Intent vs. Current Implementation

The consolidated audit. Each item states what the architecture asserts, what the code does, and how the gap should be classified.

| # | Intent | Current implementation | Class |
|---|---|---|---|
| **D-1** | Identity requires agreement on company, round and date; ambiguity yields no claim | *Was:* middle-tier scoring accepted on date proximity alone — an exact date reached the acceptance bar with a contradicting round contributing nothing. *Now:* identity is classified before scoring; a CONTRADICTS round is vetoed and never scored, so no score can admit it | **Closed — AC-2 / `54584db`** |
| **D-2** | Recognition is bounded so identity cannot stretch arbitrarily | *Was:* weakest tier applied no date bound; a sole same-name candidate matched at any temporal distance, and the resulting date difference was then reported as a reschedule. *Now:* the tier's query requires a date and a window, and recognition passes ±30 days (`LOOSE_MATCH_WINDOW_DAYS`) | **Closed — AC-1 / `8edf87a`** |
| **D-3** | Untrusted observations are held for a human without disturbing belief | Achieved, but by discarding the computed recognition and creating a separate Event; on an exact key collision the observation is silently dropped instead | **Debt** |
| **D-4** | Deliberately non-actionable mail is distinguishable from processed mail | The ignored marking is unconditionally overwritten with completed on return | **Debt — data loss** |
| **D-5** | Confidence expresses evidence quality; unmentioned fields are scored neutrally | A penalty stack double-counts absences already scored, and flatly penalises the unmentioned-venue case the scorer deliberately neutralised | **Debt — contradicts a documented decision** |
| **D-6** | Round is an identity attribute | Still weighted 0.10 in the confidence model. No longer optional in recognition: since AC-2 the round decides eligibility categorically before scoring, so the weight ranks eligible candidates and no longer bears on identity | **Debt — narrowed to the confidence model; was the root cause of D-1** |
| **D-7** | The identity key is a stable approximation of identity | Key is unnormalised; extraction strategy determines its casing, so the same activity yields different keys depending on whether the model was available | **Debt — infrastructure state affects identity** |
| **G-1** | Human review catches unreliable conclusions | Threshold responds to sparseness, not wrongness; a confidently wrong extraction never reaches a human | **Gap — by construction** |
| **G-2** | False merges are the primary risk and are guarded against | No detection of any kind exists | **Gap** |
| **G-3** | Duplicates are the tolerable failure | No detection, no merge tooling; users find them | **Gap** |
| **G-4** | Every accepted revision is recorded | Manual confirmation writes no history | **Gap — see `EventUpdate.md`** |
| **G-5** | One message may describe several activities | Extraction is instructed to select the single most important; remaining rounds are discarded | **Gap — known and documented as future scope** |
| **G-6** | Documents are a second source of event-affecting facts entering at the same adjudication boundary | **Implemented:** persistence (G-6.1), orchestration (G-6.2), and the attachment-processing call site (G-6.3) — gated on `USE_AI`, fail-soft at that one site. **Not production-active:** no production runtime consumes the attachment queue, and the one that exists sets no `USE_AI`. **Planned:** route the stored `eventInformation` into adjudication. **Open:** O-1 … O-6. `eventInformation` is stored, never adjudicated, so documents do not affect any Event | **Partially closed — understood and stored; adjudication boundary still not entered** |

Two clarifications, since earlier handbook documents describe the intended shape:

`Event.md` states that document intelligence "enters at the same adjudication boundary as email — which is the test that the boundary was drawn correctly." That statement still describes **intended architecture**. G-6.3 wired the layer into attachment processing and persists its output, so the capability is no longer inert — but the boundary itself is still not entered. `eventInformation` is written to `DocumentIntelligence` and read by nothing; no document has ever revised an Event. The boundary is drawn to accept it; nothing is sent through it yet.

What remains of **G-6** is therefore exactly one step: routing a document's `eventInformation` into the same adjudication path an email observation takes. That step is deliberately separate, because it is the first time a document could change an Event, and it inherits every question this subsystem already answers for email — identity, confidence, recognition tier, and what a document's confidence even means relative to an extraction's.

Those questions are tracked as **O-1 … O-6** and are all **OPEN**: whether a stage-less document may adjudicate (**O-1**); whether documents may ever take the update branch (**O-2**); whether document → Event provenance is recorded (**O-3**); whether the review path should honour its recognition result (**O-4**); the scope of company normalization (**O-5**); and what a document observation's confidence even is (**O-6**). None is resolved, and the remaining work cannot be specified until they are. `DocumentIntelligence.classificationConfidence` is a statement about a document's *type*, not about its extracted fields, and it is not used for recognition today.

Two further statements about **G-6**, kept distinct because they are different claims. *Implemented* is a property of this repository: the layer runs and stores its output. *Production-active* is a property of the deployment, and it is **not** — no production runtime consumes the attachment queue, and the one that exists sets no `USE_AI`, so the call site is unreachable there twice over. Neither fact changes G-6's status, which turns solely on the adjudication boundary. `docs/interview/06-ASYNC-JOBS-ATTACHMENTS-AND-AI.md` carries the detail; this document is not the Document Intelligence specification.

`Event.md`'s decision state machine presents the trust gate as preceding recognition. That is accurate as a description of **authority** — an untrusted observation never reaches an existing Event. In execution, recognition runs first and its result is discarded on the review path, which is the wasteful shape **D-3** describes.

**Also observed, non-behavioural:** a superseded confidence function remains exported and unused, alongside the active one. Harmless, but it is the kind of duplication that invites a future contributor to call the wrong one.

---

# Current residual recognition risks

What remains after **D-1** and **D-2** were closed. These are **not** the same category as the closed defects above and are deliberately not given `D-n` numbers: each is a consequence of a decision the architecture states and defends, not a contradiction of one. They are recorded because closing two false-merge paths is not the same as having none, and because a reader who sees only the closed rows would overstate how much recognition now guarantees.

The distinction that separates them from D-1 is exactly ADR-006's: **contradiction is not silence.** D-1 was a contradicted identity attribute being overruled by a score. Each risk below arises where an identity attribute was never **stated** — which the architecture rules is evidence of nothing, in either direction.

**1 · Tier 2 can admit on date proximity alone when round identity is UNKNOWN.**
The arithmetic that produced D-1 is unchanged: an exact date scores 1.0 at weight 0.5, which is exactly the acceptance threshold. When the round is unresolved on either side the identity gate returns UNKNOWN, the candidate stays eligible, and a Δ=0 candidate is admitted with **zero** contribution from stage and zero from confidence. Company is still exact-equality in the candidate query, so the real predicate is *same company + same calendar day + round unstated* — narrower than D-1, and not nothing.

**2 · Confidence participates in admission in one narrow band.**
With the round UNKNOWN and Δ=1, the score is `0.35 + 0.2 × min(incoming confidence, event confidence)`, so the candidate is admitted if and only if that minimum is **≥ 0.75**. In that band a confidence value decides an identity question rather than ranking a candidate. This is tolerable while every observation comes from one source and one confidence model. ADR-006 anticipates the case where that stops being true: *"Confidence values from different sources are not commensurable… No cross-source confidence term may re-enter the admission phase."* Any second observation source has to satisfy that rule against this band.

**3 · Tier 3 does not apply the semantic identity gate.**
The weakest tier compares round by **exact SQL equality** in its candidate query and never calls the identity classifier. Two records both carrying the unresolved-round sentinel therefore compare equal and can form a sole candidate, where tier 2 would classify the same pair as UNKNOWN. This is a real difference in identity protection between the tiers, and it is recorded as such — it is **not** a defect the tiers were meant to share and one silently lost. Tier 3's identity claim was always uniqueness-based rather than attribute-based, and AC-1 bounded that claim in time without changing its nature.

None of the three is a proposed change. No fix is specified here, no threshold is revised, and no tier is redesigned — this section states current behaviour so that a later decision about these paths is made deliberately rather than discovered.

---

# Relationship with Other Subsystems

```
   Gmail Sync ──► Extraction ──► EVENT INTELLIGENCE ──► Event ──► History
   (evidence)     (claims +          (decides)          (truth)   (memory)
                   confidence)            │
                                          ▼
                                       Review ──► Frontend
                                       (human)    (consumes)

   Document Intelligence ──► DocumentIntelligence (stored)
                         ┈┈┈► (adjudication boundary: still not entered — G-6)
```

**Gmail Sync** delivers evidence and knows nothing of Events. Its contract is durable capture; it never reasons. Its failure modes are independent — a message lost in ingestion is invisible here, which is why that subsystem's drop path matters to this one.

**Extraction** produces claims and a confidence value. It is this subsystem's only current input and is deliberately replaceable: patterns, model, or both. Event Intelligence must not encode assumptions about which produced a value — an independence **D-7** currently violates, since extraction strategy leaks into the identity key.

**Event** is the subject and the sole write target. This subsystem is the only writer, which is what makes every invariant enforceable in one place.

**History** is written as part of every accepted revision, atomically. This subsystem causes memory; it does not read it. Notably, **history is never consulted when deciding** — recognition looks only at current belief, so an Event that previously held a value the observation now proposes is indistinguishable from one that never did.

**Frontend** consumes outcomes: the timeline reflects accepted revisions, the review queue reflects deferred decisions. It is a pure consumer, and its correction path is the only human input this subsystem accepts.

**Document Intelligence** is the intended second source. Its output type is deliberately shaped as event-affecting facts, so it is designed to enter at this boundary. Since G-6.3 it runs and its output is persisted, but it still does not enter: this subsystem has never received a document-derived observation (**G-6**).

---

# Things This Subsystem Does NOT Do

- **It does not extract.** Text becomes claims elsewhere; this layer consumes claims and would function identically with a different extractor.
- **It does not store.** It writes through the Event, owning no persistent state of its own.
- **It does not read history.** Decisions consider current belief only; the past is not evidence here.
- **It does not detect its own failures.** No duplicate detection, no merge detection, no calibration feedback.
- **It does not learn.** Thresholds and weights are fixed; outcomes are never fed back.
- **It does not rank or explain to users.** Match explanations are produced and logged, never surfaced.
- **It does not handle multiple activities per message.** One observation per message, by construction (**G-5**).
- **It does not reason about participants.** Shortlists and seating describe people, not activities.
- **It does not decide presentation.** The review queue is a consequence of its decisions, not a surface it owns.
- **It does not retry.** A failed observation is the queue's concern; this layer sees each observation once.

---

# Future Evolution

**Correctness** — in priority order.

> The two items that previously headed this list — requiring identity-attribute agreement in the middle tier (**D-1**) and bounding the weakest tier by date (**D-2**) — are **done**, delivered as AC-2 (`54584db`) and AC-1 (`8edf87a`). They are retained in the audit table above as closed rather than deleted, because the reasoning that motivated them still constrains changes to these tiers. The list below is what remains.

1. **Normalise the identity key (D-7)** so recognition stops depending on which extraction strategy ran. Unchanged in priority: it is the cheapest correctness work left, and it feeds the weaker tiers where the residual risks sit.
2. **Reconcile the confidence model (D-5)** — remove double-counting and stop penalising the silence the scorer deliberately neutralised.
3. **Attach review to recognised Events (D-3)** rather than creating parallel ones, and never silently drop an observation on key collision.
4. **Preserve the abandoned outcome (D-4).**
5. **Route human confirmation through the recording path (G-4).**

**Scalability**
- Candidate discovery is per-observation and narrow; volume is not the pressure. The pressure is **per-message model cost**, addressable by filtering non-placement mail before extraction.
- Recognition is exact-equality on company. Semantic comparison would raise recall — and must not be adopted before **D-7** is closed and the residual risks above are understood, since it widens the candidate set and therefore the merge surface.

**Product**
- **Wire document intelligence into adjudication (G-6)** — the largest built-but-unused capability in the system.
- **Multi-activity extraction (G-5)** so one message can produce several observations.
- Surface match explanations, which are already produced, so a user can see *why* the system believes two messages describe one round.
- Expose confidence as evidence quality rather than as a probability, since it cannot support the latter reading.

**Operational**
- **Measure recognition quality** — matches by tier, duplicates created, merges suspected. The system's central risk is currently unmeasured.
- **Record adjudication decisions**, including rejections, so "why didn't it update?" becomes answerable without weakening history's meaning.
- **Alert on merge-shaped anomalies** — an Event absorbing contradictory observations, or oscillating history — converting an invisible failure into a visible one.
- **Calibrate the threshold** against real review outcomes, which requires recording those outcomes first.

---

# Interview Discussion

**Q: Why tiered recognition instead of one scoring function?**
Because a single score erases the *kind* of evidence you had. "All three identity attributes agreed" and "the date was close and the total happened to clear the bar" produce comparable numbers and warrant very different trust. Tiering keeps the basis of a match visible, which is what lets the system apply different rules per tier. The cost is discontinuity at boundaries — and our most dangerous path is exactly the fall-through into the weakest tier.

**Q: Why not fuzzy string matching on company names?**
It would raise recall and widen the false-merge surface simultaneously, and the second effect is the one that matters. Company is currently the strongest, most reliable discriminator — the filter everything else depends on. Loosening it means more candidates, and every extra candidate is another chance for a spurious high score. Given that our scoring already accepts on date proximity alone, loosening company matching before fixing that would be actively harmful.

**Q: Why not embeddings for identity resolution?**
Three reasons. There is no labelled data to validate against, so we could not tell whether it was better than what we have. Similarity is not identity — two rounds by one company are highly similar by construction and *should not* merge, which is the case embeddings handle worst. And an embedding match cannot be explained to a user, while our tiers can. Semantic comparison is a reasonable future step, but only after the thresholds are correct, since it widens the candidate set.

**Q: Why not learn the weights and thresholds?**
No ground truth. We do not record whether a match was correct, whether a review item was a real doubt, or whether an Event was ever wrong. Every input to supervised learning is missing — which is why "measure recognition quality" precedes any learning proposal. Learning from unvalidated data would encode current mistakes as targets.

**Q: Why not always ask a human?**
It destroys the product. The promise is that the student does nothing; a system that asks about every message is a slower inbox. Review is a safety valve sized to catch what automation should not decide, and queue volume is the honest measure of extraction quality. That said, our valve is currently mis-sized in an interesting way: it responds to *sparse* extractions, not *wrong* ones, so the failure that matters most never reaches a human.

**Q: Confidence is not probability. So what is it, and why does the distinction matter?**
It is an ordinal measure of evidence quality, derived from how information was obtained rather than from what it says. It matters because every use is a comparison — against a threshold or another confidence — and never a probabilistic computation. Treating it as a likelihood invites two errors: displaying "80% likely correct" to users, which the number cannot support, and reasoning about expected values it was never calibrated to produce.

**Q: Walk me through the worst thing that can happen in this subsystem.**
A false merge presented as a reschedule. An observation about a September round finds no exact and no near candidate, falls to the sole-candidate tier, and matches a round from the previous March because it is the only one with that name. The date differs, so the revision is classified as a reschedule: the old Event's date is rewritten, it is marked relocated, and its identity key is regenerated. The user sees a plausible "this moved" notification. Two distinct rounds are now one record, one round's data is gone, and every signal points to normal operation. It is unrecoverable and undetectable, and it is reached by ordinary inputs.

**Q: You claim duplicates are preferable. Isn't a duplicate-heavy timeline also a failed product?**
Yes, and the preference is not absolute. Enough duplicates produce the same abandonment as a merge, just more slowly. The bias holds because of *recoverability*: a duplicate leaves both records intact and is fixable in seconds, while a merge destroys the information needed to fix it. We prefer the failure that preserves the ability to recover, not the one that occurs less often. A system tuned so conservatively that it duplicates constantly is failing too — just visibly.

**Q: How would you fix the same-date, different-round merge?**
Three options. Lower the date weight below the acceptance threshold so date alone cannot clear it. Raise the threshold above the date weight. Or make a round mismatch disqualifying at that tier. I would take the third: it is the most direct statement of intent — round is an identity attribute, so contradicting it should be fatal to a match rather than merely unhelpful. The first two are numeric coincidences that a later tuning change could silently undo.

**Q: The tests cover this area. Why didn't they catch it?**
They cover the shape but not the boundary. There is a case asserting that a round mismatch produces no match — with candidates two days apart, and its own comment notes that the distance was chosen "so date alone can't clear the threshold." The test author understood that date alone *can* clear it at closer distances and picked a distance where it does not. The same-date, mismatched-round case — the realistic one, since companies run several rounds in a day — is untested and behaves incorrectly. It is a good reminder that a passing suite documents the cases someone thought of.

**Q: How does this scale?**
Not by volume: candidate discovery is narrow and per-observation, and the write path touches one Event. The real pressures are cost and correctness. Per-message model calls dominate spend, addressable by filtering before extraction. Correctness degrades with density — the more Events a company accumulates, the more candidates every observation gathers, and the more opportunities the current thresholds have to merge wrongly. **This subsystem gets riskier as it gets more data**, which is the opposite of the usual scaling story and the strongest argument for fixing the thresholds before growth rather than after.

---

# Confidence

**High** on mechanics; **High** on the identified discrepancies; **Medium** on attributed rationale.

Derived directly from source, verified by reading every file on the reasoning path: the tier order and short-circuit behaviour; the scoring weights, the acceptance threshold, and the ±3-day candidate window; the sole-candidate rule at the weakest tier; the viability gate on company and date; the acting threshold; the strict-less-than confidence comparator; field-level change detection restricted to date, time and venue; the reschedule classification and key regeneration; the confidence weights, completeness bonus and penalty stack; and the merge order of the two extraction strategies.

**The discrepancies are computed or directly observed, not inferred.**
**D-1** was arithmetic: date weight 0.5 × exact-date score 1.0 = 0.5, which meets an acceptance threshold of 0.5 with zero contribution from any other term. The arithmetic is unchanged and is the basis of residual risk 1; what AC-2 removed is the ability of a *contradicting* round to reach it. The round-mismatch test that placed candidates two days apart — chosen, per its inline comment, so the date term alone could not clear the threshold — has been superseded by a sweep over Δ ∈ {0,1,2,3} × confidence ∈ {0, 0.25, 0.5, 0.75, 1.0} asserting no match and no scoring call.
**D-2** was structural: the weakest tier's candidate query filtered on company and round with no date predicate. It now requires date and window arguments, verified at both inclusive ±30-day boundaries.
**The residual risks** are computed from the same source: risks 1 and 2 from the score arithmetic against the 0.5 threshold, risk 3 from reading the weakest tier's query, which compares round by SQL equality and never calls the identity classifier.
**D-3**, **D-4**, **D-5**, **D-6** and **D-7** are each read directly from the relevant paths.
**G-6** was verified by exhaustive search, twice. The first pass established the layer was unreachable. The current pass confirms it is now reached — attachment processing invokes the orchestrator after persisting the parsed content, and the result is written to `DocumentIntelligence` — and that **nothing reads that table**: the only references to it outside its own module are the eight lines G-6.3 added to the attachment pipeline, so no consumer of `eventInformation` exists. The production-inactivity claim is read from the worker entrypoints and the production workflow, which runs the email worker only and sets no `USE_AI`.

**Medium confidence in attributed rationale.** The "reason" and "rejected alternative" narratives reconstruct justification consistent with the implementation and its comments. They are sound engineering rationale for the design as it stands, not a record of the original discussion. Where the code states intent explicitly — the neutral treatment of unmentioned venues, the deliberate create-only review path — that is noted as stated rather than inferred.

**Test coverage on this path is partial and shape-oriented.** Recognition has six cases covering exact, near-date, round mismatch at a safe distance, different company, and best-candidate selection. Confidence has three. The end-to-end ingestion path has two. **Uncovered:** the trust gate, the confidence comparator, field-level change detection, reschedule classification, the review branch, the abandon branch, and every boundary condition identified in this document. The subsystem's correctness properties are guaranteed by reading, not by execution — the operative caveat before changing any threshold.
