# Placement Tracker Engineering Handbook

Index and entry point. Start here.

This is not the repository README. The root `README.md` is a project overview
written for a general audience; this handbook is the internal specification the
implementation is expected to conform to.

---

## What this is

Eight documents describing what Placement Tracker is, the language it is written
in, how its reasoning works, how to work on it, and which architectural decisions
are settled.

The handbook is **specification, not description**. Where the code and the
handbook disagree, the handbook states the intended architecture and names the
gap — it does not quietly re-describe whatever the code currently does.

## Why it exists

The system infers its data. Every value in it is a conclusion the machine drew
from ambiguous human-written text, applied automatically, with nobody watching.
That has two consequences ordinary code comments cannot carry:

- **The reasoning is the product.** Recognising that two messages describe one
  placement round is a judgement call with asymmetric failure modes. Those
  judgements are encoded in thresholds and tiers that look arbitrary in isolation
  and are not. The handbook is where the *why* lives.
- **The failure modes are silent.** The system's worst outcome — two distinct
  activities merged into one record — produces no error and no signal. Preventing
  it depends on engineers understanding the rules before changing them. Every
  document carries a Confidence section stating what is verified versus inferred,
  precisely so that reasoning can be trusted after the fact.

---

## Organization

Documents are grouped by layer. The numbering has gaps: `04` and `05` are
unallocated, and no documents exist for them.

### `00_Project_Overview/`

What the product is and why it exists in this shape. Problem statement, the
product thesis, what the system deliberately does **not** own, the invariants
that hold system-wide, and the failure-preference ordering used as a tie-breaker
whenever a trade-off has no other guidance.

Read this to understand intent. Nothing here is about code.

- [Product_Vision.md](00_Project_Overview/Product_Vision.md)

### `01_Domain_Model/`

The language the system is written in. **These must be understood before any
backend work.** Every module either produces Events, protects Events, or explains
Events, so an engineer who has not read these will misread the code — most
commonly by treating the recognition key as the Event's identity, which silently
converts reschedules into duplicates.

Both documents are marked *canonical*. They define terms; they do not describe
implementation.

- [Event.md](01_Domain_Model/Event.md) — what an Event is, what individuates one,
  continuity versus the recognition key, lifecycle, and ten invariants.
- [EventUpdate.md](01_Domain_Model/EventUpdate.md) — how an Event is allowed to
  change, why evidence, history and truth are three separate things, and why
  history is immutable and written atomically with the change it records.

### `02_Backend/`

Implementation and reasoning: how the system actually decides, and where the
implementation currently diverges from the architecture. These documents separate
**design intent** from **current implementation** and carry explicit discrepancy
identifiers (`D-n` for architectural debt, `G-n` for unbuilt intent).

- [Event_Intelligence.md](02_Backend/Event_Intelligence.md) — the reasoning
  layer. Recognition pipeline, the three matching tiers, the confidence model,
  the closed set of decision outcomes, and a consolidated audit of every known
  divergence.
- [Recognition_Decision_Matrix.md](02_Backend/Recognition_Decision_Matrix.md) —
  the exhaustive truth table of what the engine decides, case by case. Each row
  states expected behaviour, current behaviour, and whether they differ. Where
  they differ, the row is the authoritative bug report.
- [Gmail_Synchronization.md](02_Backend/Gmail_Synchronization.md) — the ingestion
  boundary. Cursor-based sync, why bootstrap reads the cursor before listing
  messages, two-layer de-duplication, and the drop path that remains its sharpest
  edge.

> **Currency.** Both documents have been reconciled against the implementation
> after AC-1 through AC-4. Four defects they originally recorded as open are
> **closed**:
>
> | | Defect | Closed by |
> |---|---|---|
> | **D-1** | Tier 2 accepting a same-date match with a mismatched round | AC-2 / `54584db` — see [ADR-006](06_ADR/ADR-006_Identity_Precedes_Similarity.md) |
> | **D-2** | Tier 3 applying no date bound | AC-1 / `8edf87a` |
> | **D-9** | A confidence-1.0 extraction overwriting a human confirmation | AC-3 / `7c006a4` |
> | **D-10** | A `"unknown"` placeholder company creating a matchable Event | AC-4 / `7c006a4` |
>
> **Both documents deliberately retain the original defect descriptions**, because
> the reasoning that identified them is what constrains future changes to these
> paths. Historical material is labelled as such — read a `D-n` heading together
> with its status before treating it as a description of current behaviour. One
> nuance worth carrying: **D-9 is closed by a guard, not by a comparator change.**
> The original observation that the incumbent comparator is a strict `<` remains
> true of the code; what closed is its consequence.
>
> `Event_Intelligence.md` and the matrix both now carry a **Current residual
> recognition risks** section. Those are not defects and hold no `D-n` numbers:
> each follows from a decision the architecture states and defends. They are
> recorded so that four closed defects are not read as "recognition is now safe",
> and no fix is proposed for them.

### `03_Development/`

How to work on the repository. Setup contract, not architecture.

- [Development_Environment.md](03_Development/Development_Environment.md) —
  required software, every environment variable and whether it is required,
  initial setup, how tests are run, common commands, troubleshooting, and
  platform-specific issues. Grounded in the repository as it exists, including
  what is missing from it.

### `06_ADR/`

Architecture Decision Records. An ADR records **one decision**: the context that
forced it, the decision itself, the alternatives rejected and why, and the
consequences. It is the durable answer to "why is it built this way?" asked two
years later.

**ADRs must not duplicate implementation.** They do not describe code, name
functions, or track defects. When implementation changes, the ADR does not — only
a *new* decision produces a new ADR, and a reversal supersedes rather than edits.
Implementation detail belongs in `02_Backend/`; the work that carries out a
decision is tracked separately as an Architecture Conformance issue (`AC-n`).

Numbering begins at 006; ADR-001 through ADR-005 do not exist.

- [ADR-006_Identity_Precedes_Similarity.md](06_ADR/ADR-006_Identity_Precedes_Similarity.md)
  — **Accepted.** Identity is determined by hard constraints; similarity ranks
  only candidates that already satisfy them. Similarity never establishes
  identity.

### `rfcs/`

Requests for Comments. An RFC records a proposed change **in full** — motivation,
goals and non-goals, the design, the alternatives weighed, the migration, and the
rollout — before and during implementation. Where an ADR records one settled
decision in isolation, an RFC records the whole shape of a change and may produce
several ADRs, or none.

RFCs are numbered independently of ADRs; the sequences do not correspond.

- [RFC-001-authentication-multi-user-foundation.md](rfcs/RFC-001-authentication-multi-user-foundation.md)
  — **Accepted.** Identity, authentication, authorization, ownership boundaries,
  and the multi-user foundation the existing reasoning engine now operates
  within.

### `runbooks/`

Operational procedures. Runbooks answer *how do I operate this?* — starting the
stack, signing in, applying a migration, recovering from a specific failure.
They are permitted to name commands, ports, URLs, and error strings, which is
both their value and the reason they stale faster than anything else here.

**Where a runbook and this handbook disagree, the handbook is the specification
and the runbook is the bug.**

- [runbooks/README.md](runbooks/README.md) — what runbooks are, how they differ
  from the handbook, ADRs and RFCs, and the reading order for a new contributor.

---

## Reading order

For a new engineer. Each step assumes the one above it.

```
        Product_Vision.md              what the product is, and its failure preferences
                 ↓
             Event.md                  the central entity; read this one properly
                 ↓
          EventUpdate.md               how belief may change, and what is remembered
                 ↓
      Event_Intelligence.md            how the system decides, and where it falls short
                 ↓
 Recognition_Decision_Matrix.md        exactly what it decides, case by case
                 ↓
    Gmail_Synchronization.md           how observations arrive in the first place
                 ↓
  Development_Environment.md           how to run and test it
                 ↓
              06_ADR/                  which questions are already settled
```

Two notes on the order.

**`Event.md` is the pivot.** The three backend documents are unreadable without
it — they assume its vocabulary throughout. If you read only one document before
touching code, read that one.

**Ingestion comes after reasoning** deliberately. Gmail synchronization is easier
to understand once you know what the messages are eventually *for*, and its
central decision — overlap is safe, gaps are not — only makes sense against the
reconciliation model downstream of it.

If you are here to change a specific recognition behaviour, the shortest correct
path is `Event.md` → `Recognition_Decision_Matrix.md` → the relevant ADR.

---

## Philosophy

The handbook documents five things, and only these:

| | |
|---|---|
| **Product intent** | why the system exists and what it refuses to do |
| **Domain language** | the terms every module is written in |
| **Architecture** | how the system reasons, and on what basis |
| **Development practices** | how to run, test, and change the repository |
| **Architectural decisions** | which questions are closed, and why |

Three rules govern it.

**Implementation conforms to the handbook.** Not the reverse. When code and
handbook disagree, that is a defect in the code or an acknowledged gap in the
document — never a licence to silently rewrite the specification to match what
was shipped.

**The handbook evolves when architecture changes.** Not when code changes. A
refactor that preserves behaviour changes nothing here. A new decision produces
an ADR; a change in what the engine decides updates `02_Backend/`; a change in
what the domain *means* updates `01_Domain_Model/` and is a much larger event
than it looks.

**Gaps are documented, not hidden.** Every document states its own confidence,
distinguishes verified from inferred, and names the places where the
implementation does not yet meet the stated architecture. A handbook that
described only the parts that work would be worth nothing at the moment it was
needed.

---

## Conventions

- **`Status: canonical`** in a document header means it defines terms other
  documents depend on. Changing one is a domain change, not an edit.
- **`D-n`** identifies architectural debt — implementation that contradicts
  stated intent. **`G-n`** identifies a gap — intent not yet built. Both are
  catalogued in `Event_Intelligence.md` and ranked by severity in
  `Recognition_Decision_Matrix.md`. A closed `D-n` keeps its number and its
  original description; it is marked closed rather than deleted.
- **Residual risks carry no number.** A behaviour that follows from a decision the
  architecture states and defends is not debt, even where it admits on thin
  evidence. Those are recorded separately, under *Current residual recognition
  risks*, so the two are never conflated.
- **`AC-n`** identifies an Architecture Conformance issue: the work that brings
  the implementation back in line with the handbook. AC-1 bounded the weakest
  recognition tier in time; AC-2 implemented ADR-006's identity gate; AC-3 made
  human confirmation authoritative over inference; AC-4 stopped placeholder
  companies from becoming matchable Events; AC-5 introduced identity and ownership
  per RFC-001.
- **Every document ends with a Confidence section** stating what was derived
  directly from source, what is inferred, and what is not covered by tests. Read
  it before relying on a claim.
