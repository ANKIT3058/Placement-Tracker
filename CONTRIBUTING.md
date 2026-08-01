# Contributing

How engineering work is done in this repository. This is not a guide to Git,
GitHub, or pull requests — it assumes you know those. It covers the workflow
specific to this project.

The short version: **this system infers its data, its worst failures are silent,
and the handbook is the specification.** Everything below follows from that.

---

## Before Writing Code

Read, in this order, before your first change:

1. **[docs/README.md](docs/README.md)** — the handbook index. It states the
   reading order and the conventions (`D-n`, `G-n`, `AC-n`) used throughout.
2. **[Product Vision](docs/00_Project_Overview/Product_Vision.md)** — what the
   system is for, what it refuses to do, and the failure-preference ordering used
   as a tie-breaker when a trade-off has no other guidance.
3. **[Domain Model](docs/01_Domain_Model/)** — `Event.md` and `EventUpdate.md`.
   Both are marked *canonical*. `Event.md` is the pivot: every module either
   produces Events, protects Events, or explains Events, and an engineer who has
   not read it will misread the code.
4. **The relevant Backend handbook** — [`docs/02_Backend/`](docs/02_Backend/).
   Read the document covering the area you are changing, including its
   *Design Intent vs. Current Implementation* audit.
5. **The relevant ADRs** — [`docs/06_ADR/`](docs/06_ADR/). If an ADR governs the
   area you are touching, its decision is settled. Do not re-open it in a code
   change.

For environment setup, see
[Development Environment](docs/03_Development/Development_Environment.md).

---

## Engineering Principles

**Preserve domain terminology.** An Event is a real-world placement activity, not
a row. Identity is discovered, not assigned. A recognition key is not an identity.
The handbook defines these terms precisely; renaming or blurring them in code is a
domain change, not a style choice.

**Architecture drives implementation.** The handbook is the specification and the
code conforms to it. If a change requires the architecture to be different, that
is a separate, prior conversation.

**ADRs capture decisions.** One decision per ADR: context, decision, rejected
alternatives, consequences. ADRs do not describe code, name functions, or track
defects. A reversal supersedes an ADR; it never edits one.

**Do not bypass invariants.** Each canonical document lists its invariants
explicitly. Violating one is a domain error, not a behavioural change. Two that
are bypassed most often by accident: trusted information is never overwritten by
less-trusted information, and silence is never treated as deletion.

**Prefer explicit reasoning over clever code.** A constraint is a rule; a
threshold is a coincidence. Where a rule can be expressed structurally, express it
structurally — arithmetic that happens to produce the right answer will be
silently undone by the next person who retunes it.

**Bias toward the recoverable failure.** A duplicate is visible and correctable.
A false merge destroys information silently in a system the user trusts enough not
to check. When in doubt, fail in the direction that leaves a signal.

**Add regression tests for architectural changes.** See *Testing*.

---

## Documentation

**The handbook evolves when architecture changes — not when code changes.**

A refactor that preserves behaviour changes nothing in `docs/`. An implementation
detail is not a handbook concern. Do not rewrite a canonical document to describe
what you happened to build.

What each kind of change touches:

| Change | Updates |
|---|---|
| Refactor, no behaviour change | nothing |
| What the engine decides | the relevant `02_Backend/` document |
| A new architectural decision | a new ADR |
| What a domain term *means* | `01_Domain_Model/` — a much larger event than it looks |
| Setup, tooling, environment | `03_Development/` |

**Gaps are documented, not hidden.** Where the implementation does not meet the
stated architecture, record it as `D-n` (debt: implementation contradicts intent)
or `G-n` (gap: intent not yet built) rather than quietly adjusting the document to
match the code.

---

## Testing

Run the suite from `backend/`:

```bash
npm test
```

**Every architectural change ships with regression tests.** Not tests that the
new code runs — tests that the invariant it establishes *cannot be violated*.
Prefer exhaustive coverage of the boundary over a single representative case: the
defect that motivated ADR-006 survived a passing suite because the existing test
chose inputs that avoided the boundary.

**Do not merge if an architectural invariant cannot be verified.** If an invariant
is not expressible as a test, say so explicitly in the change description and
explain how it is enforced instead. An unverifiable invariant is a convention, and
conventions do not survive contributors who have not read this page.

Where the invariant is that something *never happens*, assert on the absence —
that a function was never called, that no candidate was admitted. An assertion on
the outcome alone cannot distinguish "correctly refused" from "considered and
happened to lose".

---

## Decision Making

**When the implementation disagrees with the handbook, do not silently change
either one.** The disagreement is information; resolving it quietly destroys it.

Exactly two valid responses:

1. **The handbook is right and the code is wrong.** Fix the implementation. If the
   fix is non-trivial, track it as an Architecture Conformance issue (`AC-n`) so
   the scope and the reasoning are recorded. AC-1 and AC-2 are the precedents.
2. **The code is right and the architecture should change.** Write a new ADR.
   State the context, the decision, the alternatives you rejected and why, and the
   consequences. Get it accepted before implementing it.

What is not acceptable is a third path: adjusting the code to match your reading
of the document, or adjusting the document to match the code you already wrote,
without a record either way. That is how a specification becomes fiction.

If you are unsure which of the two applies, that uncertainty is itself worth
raising before you write code. The handbook's own rule applies to contributors as
much as to the system it describes: **ambiguity is resolved by asking, not by
guessing.**
