# ADR-006 — Identity Precedes Similarity

Engineering Handbook — Architecture Decision Record
Date: 2026-07-31
Scope: the recognition layer of the reasoning engine
Detailed analysis: AC-2 Architecture RFC (*Eliminating D-1*)

---

# Status

**Accepted.** Permanent. This decision constrains all future recognition work.

---

# Context

The reasoning engine's job is to decide whether a new observation describes an
activity it already knows. Until AC-2, it made that decision with a weighted
similarity score:

```
score = 0.5·dateProximity + 0.3·roundAgreement + 0.2·confidenceAlignment
accept iff score ≥ 0.5
```

The three signals were summed into one scalar, and that scalar decided both
*whether* any candidate was the same Event and *which* candidate it was.

This produced **D-1**. The date term alone was worth exactly the acceptance
threshold, so an exact date match satisfied the bar with zero contribution from
anything else. Same company, same date, **different round** was accepted. Two
genuinely different activities — a pre-placement talk in the morning and an
online assessment in the afternoon, which is an ordinary occurrence — were
recognised as one Event.

The defect was not a mis-tuned constant. It was representational. The score was
a sum of non-negative terms, monotone in each, so the date term was a *lower
bound* on the total: no configuration of the other inputs could pull the score
back below the threshold. A mismatched round contributed `0`, and `0` in that
function means *no support* — the function had no way to express *evidence
against*. **A weighted sum of corroboration cannot encode a veto.** The engine
was structurally incapable of disagreeing with itself.

Two further properties made this worse than an over-permissive bar. Because
confidence alignment competed on the same scale as round agreement, a
well-established wrong-round Event could **out-rank** the correct one — so even
when the right candidate was present, the engine could choose the wrong one.
And because the update path never compares round, the merged Event kept its
original label and the match basis was never persisted: the resulting record was
internally consistent, and nothing anywhere recorded that a contradicted
identity attribute had been accepted.

### Why this violated the Event identity model

`Event.md` states that three attributes together individuate a placement
activity — company, round, and time — and that **any two of these are
insufficient**. D-1 made the round optional. An identity claim was being
asserted from company plus date, which the domain explicitly says does not
distinguish a morning test from an afternoon interview.

The deeper violation is a principle the handbook already held, applied in the
wrong direction. The domain forbids collapsing *silence* into *denial* on the
update path: a message that omits a field says nothing about it. The scorer
committed the inverse collapse on the identity path — it treated *denial* as
*silence*. "This is a different round" and "this says nothing about the round"
were both encoded as zero, and the engine could not tell them apart.

---

# Decision

**Identity is determined by hard constraints. Similarity ranks candidates that
have already satisfied them. Similarity never establishes identity.**

Recognition is two phases with strictly separated authority:

1. **Admission (categorical).** Each candidate is evaluated against the identity
   attributes. An attribute on which the observation and the candidate
   *disagree* is disqualifying. An attribute that either side does not state is
   neither support nor disqualification — but an identity claim resting on fewer
   than all three attributes requires uniqueness within a bounded range. Only
   candidates that satisfy the constraints are eligible.

2. **Ranking (continuous).** The similarity score orders the eligible set and
   applies a floor. It has no authority to admit. An inadmissible candidate is
   not scored, and no score can make one admissible.

Identity attributes are therefore compared with three outcomes — **agree**,
**contradict**, **unknown** — never two. A sentinel standing in for an
unextracted attribute is not a value and never satisfies a constraint.

This ordering is permanent. It applies at every recognition tier, to every
identity attribute, and to every future mechanism that proposes a match,
whatever produces its inputs.

---

# Rationale

**Event identity.** Identity is a fact about the world that the system attempts
to *recognise*; it is not a quantity the system computes. Recognition either
holds or it does not. Expressing it as a threshold on a continuum forces a
categorical judgement through a representation that cannot carry it — the
contradiction has to be encoded as a small number, and small numbers are
outvoted. Constraints are the only representation with the same shape as the
thing being decided.

**Preference for duplicates over false merges.** The two failures are not
symmetric: a duplicate is visible and recoverable, a merge is silent and
destroys the information needed to undo it. That asymmetry must be expressed by
the *mechanism*, not merely by its calibration. A scoring threshold fails toward
the merge, because every additional term can only push the total upward. A
constraint fails toward the duplicate, because a candidate that does not
qualify is simply absent. The architecture now fails in the recoverable
direction by construction rather than by arithmetic — and arithmetic is exactly
what a future tuning change can silently undo.

**Recognition before mutation.** The invariant is not satisfied by running
recognition *earlier*; it is satisfied by recognition producing a *verdict*.
A pipeline that mutates on a best-available guess has ordered its steps
correctly and recognised nothing. Constraint-then-rank is what makes the
existing ordering mean what the handbook says it means.

**Confidence as permission to act.** Confidence answers *may I write?* It has
never answered *what am I writing about?* Allowing confidence alignment to
contribute to a match let a credential decide an identity — and inverted the
principle, since two well-extracted records agreeing raised the score and
therefore widened the merge. Confidence is now confined to ranking and to the
incumbent comparator, which is the only reading of it the handbook supports.

Taken together, these four require the ordering. Identity is categorical,
recoverability demands the failure direction be structural, mutation must follow
a verdict rather than a preference, and confidence is permission rather than
evidence of subject. A single scalar satisfies none of them.

---

# Alternatives Considered

Summarised only; the RFC holds the analysis and the feasibility proofs.

**Weighted scoring, retuned.** Keeping one scalar and adjusting its constants.
Rejected: no weighting fixes the defect while preserving legitimate same-round
matching unless the round term dominates the date term — at which point the
scorer *is* a round constraint, expressed as a coincidence between four numbers
instead of as a rule.

**Higher acceptance threshold.** Provably infeasible. Rejecting the worst
mismatch requires a threshold above 0.7; preserving legitimate matches three
days apart requires one at or below 0.55. Any threshold high enough to close
D-1 collapses the tier into exact matching.

**Lower date weight.** Provably infeasible for the same reason, in the opposite
direction. Partial reductions are worse than none: they leave the merge intact
precisely in the well-extracted case while appearing to fix it.

**Lexicographic scoring.** Ordering candidates by round agreement, then date,
then confidence fixes *which* candidate is chosen but not *whether* one is
accepted: a sole contradicted candidate is still top-ranked and still admitted.
Ordering is not admission. Made correct, it becomes this decision.

**Round equality encoded inside the score** (as a required term or a negative
penalty). Numerically workable, architecturally the same mistake: a veto that
depends on constants holding a particular relation is a veto that a future
tuning change removes without anyone noticing. It also keeps identity and
similarity fused in one number, which is what erased the *kind* of evidence the
tiering was built to preserve.

**Round equality in the candidate query.** The cheapest correct fix, and the one
a reader will ask about first. Rejected because it relocates the identity
predicate into the persistence layer — recognition is the only component
permitted to judge identity — and because a candidate excluded in SQL cannot be
refused, recorded, or counted. For a defect whose defining property was
invisibility, a fix whose refusals are equally invisible cannot be shown to
work.

---

# Consequences

### Positive

The class closes rather than the case: an accepted match now requires agreement
on every stated identity attribute, at every tier, by construction. The engine
also recovers the *correct* Event in contested candidate sets, because ranking
runs over a set from which contradicting candidates have already been removed —
a property no threshold change delivers. Refusals become expressible, so the
system can state why it declined instead of leaving no trace.

### Negative

Duplicates increase. Round-name variation, round misextraction, and observations
with no resolvable round now produce a visible second record where they
previously produced a silent merge. This is the intended direction and a real
product cost: enough duplicates erode trust too, only more slowly and more
visibly. The cost lands hardest on observations whose round cannot be resolved
at all, which create records that later observations cannot reach.

### Operational

The constraint phase is evaluated in the reasoning layer, not in SQL, so
candidate queries are unchanged and no new I/O is introduced. False-merge risk
stops scaling with data density along the constrained attributes: additional
Events of *different* rounds add no risk, because they are eliminated before any
score exists. This breaks the subsystem's previous property of getting riskier
as it accumulates data. In exchange, recognition decisions must now carry their
basis — tier, attribute relation, candidate count, score — because a
prevention mechanism whose refusals are unobservable cannot be verified in
production.

### Future extensibility

**Multiple observation sources.** Admissibility is a property of the claims, not
of their provenance, so documents, attachments, and future channels are admitted
by the same predicate as email. Confidence values from different sources are not
commensurable; confining confidence to ranking means that incommensurability can
no longer decide an identity. **No cross-source confidence term may re-enter the
admission phase.**

**Embedding-based extraction.** The three-valued attribute relation is the
correct interface for a semantic model, because it forces the model to express
*abstention* rather than emitting a continuum that is later flattened into a
sum. D-1 existed precisely because a graded signal was flattened. Ranking may
consume continuous semantic distance freely, since ranking cannot admit. This
decision is therefore the precondition that makes semantic recognition safe to
adopt rather than an obstacle to it.

**Future recognition algorithms.** Any new tier, heuristic, or model inherits an
admission phase to satisfy, not a threshold to guess. Adding an identity
attribute means adding a constraint clause; changing how similar things are
ranked means changing the scorer. The two evolve independently, which is the
property that was absent when D-1 was written.

---

# Handbook Impact

The following documents now depend on this decision and must be read as
governed by it:

**`Event.md`** — carries the invariant this decision generalises: *contradiction
is not silence*. An identity attribute on which two descriptions disagree is
evidence against identity; one that neither states is evidence of nothing. This
completes the three-attribute identity model by defining what happens when an
attribute is absent rather than merely present or matching.

**`Event_Intelligence.md`** — the matching strategy, the invariant that ambiguity
never resolves into a selection, and the candidate-narrowing rationale are all
now statements about a constrained engine. In particular, tier 2's tolerance of
round-name variation is provided by canonical comparison, not by the permissive
score it was previously attributed to.

**`Recognition_Decision_Matrix.md`** — the authoritative truth table. Its scoring
model section now describes ranking among eligible candidates only; the
same-date / different-round rows change outcome; and the acceptance threshold is
documented as a similarity floor rather than an identity gate.

`EventUpdate.md`, `Product_Vision.md`, and `Gmail_Synchronization.md` are
unaffected. This decision changes *which* Event is written, never whether or how
a write is recorded.

---

# Implementation Notes

Implementation is delivered under **AC-2** and tracked separately. This ADR
records the architecture; AC-2 records the change. The AC-2 RFC remains the
detailed analysis, including the feasibility proofs for the rejected numeric
options, the stress cases, and the enumerated documentation updates.

Two points settled at acceptance, recorded here so they are not re-opened:

- An unresolved identity attribute is not a value **anywhere**, including
  identity-key construction. Exact-key recognition itself is unchanged; what
  changes is that an observation lacking a stated round produces no key to
  recognise by.
- The adjudication-boundary guard added by AC-2 is an **assertion, not a
  behaviour**. After this decision no recognition path can yield a
  round-contradicting match. If the guard ever fires, a recognition invariant
  has regressed.

Adjacent defects — the incumbent-confidence comparator, the unknown-company
sentinel, the review path's discarded recognition, and the confidence penalty
stack — are out of scope and remain open on their own records.

---

# Decision Summary

1. **Identity is categorical.** It holds or it does not; it is not a quantity.
2. **Similarity is continuous.** It orders candidates; it decides nothing.
3. **Similarity cannot create identity.** No score admits an inadmissible
   candidate.
4. **Identity gates reasoning.** Recognition determines eligibility before
   scoring, always in that order.
5. **Contradiction is not silence.** A disagreeing attribute disqualifies; an
   absent one neither supports nor disqualifies.
6. **Confidence ranks belief, not identity.** It is permission to write, never
   evidence of what is being written about.
7. **Duplicates are safer than false merges,** and the mechanism — not its
   calibration — must be what fails in that direction.
8. **A constraint is a rule; a threshold is a coincidence.** Identity is
   protected by the first, never by the second.
