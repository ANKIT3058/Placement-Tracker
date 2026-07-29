# The Event

Engineering Handbook — Domain Model
Status: canonical. This document defines the language the system is written in.

If you read one document in this repository, read this one. Every subsystem
either produces Events, protects Events, or explains Events. An engineer who
understands the Event understands the system; an engineer who does not will
misread every module in it.

---

# Executive Summary

**Purpose**

The Event is the system's model of a real placement activity — one company, one round, one point in time. It exists because the information describing that activity does not arrive as a description of it. It arrives as a scattered sequence of human-written announcements, each partial, each written without knowledge of the others, several of which revise what earlier ones said. The Event is where those fragments are reconciled into a single current answer, and it is the only place in the system where the question "what is actually happening?" has an answer at all.

**Core Idea**

Messages are observations of reality; the Event is the system's belief about reality, and belief must be modelled separately from the observations that produced it.

**Primary Invariant**

An Event always represents the best currently known truth about exactly one real-world placement activity.

**Primary Failure Mode**

Two observations of the same real activity fail to be recognized as such, producing two Events for one round — or worse, two observations of *different* activities are wrongly unified, silently corrupting a record the user will act on without checking.

---

# Domain Definition

**An Event is** the system's authoritative, evolving belief about a single real-world placement activity — one round, run by one company, at one point in time — assembled from many partial and sometimes contradictory observations, carrying with it an explicit measure of how much that belief should be trusted, a record of how it came to hold its current values, and a state indicating whether it is still being inferred by the system or has been settled by a human. It is not a message, not a copy of a message, and not a summary of messages. It is a claim about the world that the system maintains on the user's behalf, revises as better information arrives, refuses to revise when worse information arrives, and escalates to a person when it cannot decide. Everything else in the system exists either to produce Events, to protect them from bad information, or to explain how they reached their current state.

---

# Problem Statement

A student needs to know what is happening and when. That information exists, but it is published in a form that resists being known.

A single placement round is described across time by several messages. The first announces it. A second moves it three days. A third assigns a venue. A fourth attaches a shortlist. Each message is written by a different person, in different words, with no reference to the others, and none of them contains the complete picture. A message that corrects the venue mentions no date; a message that announces a schedule mentions no company.

If the system stores messages, it has stored the problem, not the solution. The student is still the one who must read four messages, recognise that they concern one round, notice that the date silently changed between the first and the second, and work out that the absence of a date in the fourth means "unchanged" rather than "unknown".

That integration work is precisely what the product exists to remove, and it cannot be removed without a place to put the result. **The Event is that place.** Its existence is not a modelling preference; it is the entire product thesis expressed as a data structure.

---

# Why Messages Are Not Events

This is the most important distinction in the system, and the one most likely to be lost during a refactor by someone who has not read this document.

## An email cannot be the primary entity

A message is a record of *something having been said*. It is immutable, timestamped, and true forever: the message said what it said. That property makes messages excellent evidence and useless as an answer.

The user's question is not "what was said?" It is "what is true now?" Those questions have different shapes. The first is answered by a list. The second is answered by a single value. Any system whose primary entity is the message has structurally declined to answer the second question, and has handed the reconciliation work back to the user — which is the work the product exists to do.

## What messages lack

**Messages lack completeness.** Each carries a fragment of a round's description. The complete description exists only as an accumulation, and an accumulation needs somewhere to accumulate.

**Messages lack currency.** A message announcing a date remains a true record of that announcement forever, even after the date changes. Message-shaped data cannot express supersession; it can only express addition. A reader given four messages must determine which parts of each are still in force.

**Messages lack identity across time.** Nothing in a message states which round it concerns. That relationship is inferred, not declared. Without an entity to attach the inference to, the inference must be recomputed by every reader, every time.

**Messages lack a place to record uncertainty.** The system's trust in what it understood is a property of the *conclusion*, not of the text. There is nowhere on a message to put it that would mean anything.

## Why several messages become one Event

Because they describe one thing. A round that is announced, moved, given a venue, and then staffed with a shortlist is a single activity in the world, and the student attends it once. A model in which it appears four times is not a more faithful model — it is a less faithful one, because the world contains one round and the model contains four rows.

Collapsing many observations into one belief is not a compression optimization. **It is the modelling act that makes the data usable.**

## Why the distinction is fundamental

Because it determines the direction of every other decision in the system.

If messages were primary, reconciliation would be a read-time concern: store everything, resolve on display. Trust would be presentational. History would be reconstructed by diffing. And each reader would independently decide which message currently wins, which means two readers can disagree.

Because Events are primary, reconciliation is a **write-time** concern. It happens once, at the moment information arrives, by a component whose only job is to do it well. Trust becomes an input to writes. History becomes a first-class record rather than a derived one. And there is exactly one answer in the system, so no two readers can disagree.

Messages are still retained — they are the evidence, and evidence is how a wrong belief gets diagnosed. But they are not the answer, and nothing reads them to determine what is true.

---

# Event Identity

Identity is the hardest concept in this domain, and the one most often confused with matching. Matching is the procedure that decides. Identity is what the procedure is trying to discover.

## The question

Two observations arrive, days apart, in different words. What makes them observations of *the same Event*?

The answer is not "they contain the same text," "they came from the same sender," or "they scored above a threshold." Those are evidence. **Two observations refer to the same Event when they describe the same real-world activity** — the same company running the same round at the same point in time. Identity lives in the world. The system does not create it; the system attempts to *recognise* it.

This framing matters practically. It means the system can be wrong about identity, and being wrong is a factual error about the world rather than a policy choice. It also means identity is not negotiable by convenience: two rounds that a user experiences as one thing are one Event, whatever our data says.

## What distinguishes one activity from another

Three attributes, together, individuate a placement activity in this domain:

- **Which company** it belongs to.
- **Which round** of that company's process it is.
- **When** it occurs.

Any two of these are insufficient. A company plus a round does not distinguish a first attempt from its rescheduled replacement. A company plus a date does not distinguish a morning test from an afternoon interview. All three together are what make an activity the specific activity it is.

## The uncomfortable part: identity includes something that changes

Time is one of the three distinguishing attributes — and time is exactly what a reschedule changes.

This is a genuine tension in the domain, not an artifact of implementation. When a round moves from the 14th to the 17th, the *thing* is continuous — the student experiences one round that got moved, not a cancellation followed by a new round — but one of the attributes that distinguishes it has changed. Its description no longer matches the description it had.

The domain resolves this by separating two ideas that are easy to conflate:

**Continuity** is the Event's persistence as one thing across all its changes. It survives every revision. It is what makes "this round was moved twice" a sentence about one Event rather than three.

**The recognition key** is the current combination of company, round, and time that lets a new observation be matched to it quickly. This is a *description*, and descriptions follow the thing they describe. When a reschedule changes the time, the key is regenerated so future observations of the moved round recognise it.

The engineering consequence is worth stating explicitly: **an Event's recognition key is not its identity.** The key is a fast, exact path to recognition when the world has not moved. Continuity persists independently of it, which is why history survives a reschedule and why a rescheduled Event is an update rather than a replacement. Any change that treats the key as the Event's true identity will silently convert reschedules into duplicates.

## Identity under uncertainty

Real observations are inconsistent, so exact recognition frequently fails while identity still holds. The domain handles this by admitting weaker evidence in a specific order — exact description, then close-but-imperfect description within a narrow time window, then the weakest case of a company and round with only one possible candidate.

Two principles govern this, and both are domain statements rather than tuning choices:

**Ambiguity is resolved by declining, not by guessing.** When the weakest form of evidence produces more than one candidate, the system asserts no identity at all. An identity claim requires uniqueness. Choosing arbitrarily among plausible candidates is worse than making no claim, because a wrong unification is unrecoverable while a missed one is visible.

**The failure modes are asymmetric, and the asymmetry sets the bias.** Failing to recognise identity produces a duplicate — visible to the user, correctable, embarrassing. Falsely asserting identity merges two real activities into one record, silently destroying information about both, in a system the user trusts enough not to double-check. The first is a nuisance; the second is the primary failure mode. Every threshold in the recognition path should be read as an expression of that preference.

---

# Event Evolution

An Event is a **continuant**: it persists through change while its values are revised. This is what most sharply separates it from a message, which is a fixed record of a moment. Messages accumulate; **Events evolve**. The system needs both, because evolution is what makes an Event useful and accumulation is what makes evolution auditable.

## Creation

An Event comes into being when an observation describes an activity the system does not recognise. Creation is not neutral about trust: an observation confident enough to act on creates an Event in the ordinary state, while one below the acting threshold creates an Event already parked for human review, carrying the reason it was doubted. **An Event's first moment already reflects how much it is believed.**

## Updates

A later observation matched to an existing Event proposes changes. Only fields the observation actually spoke about are considered, and only where the value differs. An update is not a wholesale replacement — it is a set of field-level revisions, each of which must independently earn its way in.

## Corrections and the confidence gate

An update is not automatically applied. It must be at least as trustworthy as what it would overwrite. A weaker observation does not get to degrade a stronger record merely by arriving later.

This inverts the ordinary intuition that newer data wins. In this domain the newest observation is not the most authoritative — it is simply the most recent *guess*, and guesses vary in quality. **Recency is a poor proxy for correctness when every write is an inference.** The user acts on this data without verifying it, so a silent downgrade of a good record costs more than a declined update.

## Rescheduling

A changed date is categorically different from a changed venue or time. The venue moving is a correction to the description of an activity. The date moving is the activity itself being relocated in time — which is both the most consequential change for the user and the one that alters a distinguishing attribute.

The domain therefore treats it as a distinct state rather than an ordinary field update: the Event is marked as rescheduled, and its recognition key is regenerated so that subsequent observations find the moved round rather than the position it vacated. Continuity is preserved; history retains both dates.

## Confirmation and manual review

Review is where an Event waits for a human because the system will not act alone. It is an entry state, not a damaged one — the Event holds its doubted values and, critically, **nothing already believed elsewhere was disturbed to put it there.**

Confirmation is the human's answer. It sets the Event's values, raises its trust to certainty, and clears the reason it was doubted. From that point the Event is settled with respect to inference: later machine conclusions do not silently override a person's decision. If they did, review would be pointless — the user would correct the same field repeatedly and stop trusting the system.

## History

Every accepted change is recorded as an immutable statement: this field, this old value, this new value, at this time. History is not a log and not a debugging aid. It is the domain's answer to a question the user will eventually ask — *why does it say this?* — and the only thing that makes a wrong answer recoverable rather than merely wrong.

History is written in the same act as the change it describes. An Event whose values moved without a corresponding record would be an Event that cannot explain itself, which is a state the domain does not permit.

## Lifecycle

```
                    observation describes an
                    unrecognised activity
                              │
              ┌───────────────┴────────────────┐
     trusted enough to act              not trusted enough
              │                                │
              ▼                                ▼
      ┌───────────────┐                ┌───────────────┐
      │   SCHEDULED   │                │    REVIEW     │
      │ believed, but │                │ parked; harms │
      │ still open to │                │   nothing     │
      │  inference    │                │               │
      └───────┬───────┘                └───────┬───────┘
              │                                │
    ┌─────────┴──────────┐                     │
    │                    │                     │
 venue/time         date changes               │
 correction              │                     │
    │                    ▼                     │
    │            ┌───────────────┐             │
    │            │  RESCHEDULED  │             │
    │            │ same Event,   │             │
    │            │ relocated in  │             │
    │            │ time; key     │             │
    │            │ regenerated   │             │
    │            └───────┬───────┘             │
    │                    │                     │
    └────────┬───────────┘                     │
             │                                 │
             │  human confirms                 │  human confirms
             │                                 │  or corrects
             ▼                                 ▼
          ┌────────────────────────────────────────┐
          │              CONFIRMED                  │
          │  settled by a person; certainty raised; │
          │  doubt cleared; inference no longer     │
          │  silently overrides                     │
          └────────────────────────────────────────┘

  every transition above writes an immutable history entry
```

---

# Event Boundaries

Boundaries are what keep the Event meaningful. An entity that absorbs everything nearby stops being a model of anything.

## What belongs inside an Event

**Company** — which organization the activity belongs to. A distinguishing attribute.

**Round** — which stage of that company's process this is. A distinguishing attribute.

**Time** — when it occurs. A distinguishing attribute, and the one whose change constitutes a reschedule.

**Venue** — where it happens. Descriptive, not distinguishing: two rounds are not different rounds because the room changed.

**Status** — whether the Event is believed, relocated, awaiting a person, or settled by one. This is not workflow bookkeeping; it states how much human and machine agreement stands behind the current values.

**Confidence** — how much the current values should be trusted. It belongs on the Event because it is a property of the *belief*, not of any message that contributed to it, and because it governs whether the next observation may modify it.

**Reason for doubt** — when an Event awaits review, why. Escalating without a reason makes review guesswork.

**History** — how the Event reached its current values. Inside the boundary because an Event that cannot explain itself is incomplete.

**Ownership** — conceptually inside the boundary: an Event is somebody's. It is **not modelled today**, because the system currently serves a single user with a single mailbox. This is a known boundary of the current implementation, not a claim that Events are ownerless. Any move to multiple users places ownership here, on the Event, not on the messages that produced it.

## What deliberately does not belong

**Messages.** They are evidence, not content. An Event that embedded its source messages would fuse belief with observation and lose the ability to be revised independently of them. They are retained separately and referenced when a belief must be audited.

**Extraction artifacts.** What a particular observation claimed, with its own confidence and raw text, is a record of an interpretation attempt. It is retained — it is how extraction quality is measured and how a bad conclusion is traced — but it lives with the observation. Only the *conclusion* reaches the Event. Storing every attempt on the Event would make the Event a history of the system's reasoning rather than a statement about the world.

**Prompts and model behaviour.** How a conclusion was computed is an implementation of the interpretation layer. If the extraction strategy is replaced entirely, no Event should change shape. That is the test of this boundary, and it is the reason the Event survives a rewrite of everything upstream.

**Raw attachments.** Files are evidence with their own lifecycle — download, parse, classify, extract. What a document *means for the activity* may update an Event. The document itself stays outside.

**Transient processing state.** Whether a message is queued, retrying, or failed describes the pipeline, not the world. Pipeline state has no place on an entity that models a real activity — a round does not become "pending" because a worker is behind.

**Participants.** Who is shortlisted, who sits where, who is on the panel. These are understood by the document layer today and are deliberately *not* folded into the Event, because they describe people, not the activity. Forcing them inside would either distort the Event or force a premature model of a student.

---

# Event Philosophy

Ten principles. They are the compressed form of everything above, and they are meant to be quotable in a design review.

**1. Messages describe observations. Events describe reality.**
Confusing the two is the root of most modelling errors in this system.

**2. Truth evolves; evidence does not.**
An Event is revised. The messages that shaped it are never edited. Both are needed.

**3. History is immutable.**
Recorded change is the only reason a wrong answer is recoverable rather than merely wrong.

**4. Confidence governs mutation.**
Trust is not decoration on the data. It is permission to write.

**5. Highest trust wins, not last write.**
Recency is a poor proxy for correctness when every write is an inference.

**6. Silence is not deletion.**
A message that omits a field says nothing about that field. Only an explicit statement removes information.

**7. Ambiguity is resolved by declining, not by guessing.**
An identity claim requires uniqueness. No claim beats a wrong claim.

**8. A duplicate is a nuisance; a false merge is a catastrophe.**
The asymmetry between these two failures sets every threshold in the recognition path.

**9. Human confirmation outranks inference.**
Otherwise review is theatre and the user learns to distrust the system.

**10. An Event must be able to explain itself.**
Any current value must be traceable to what changed it and when. An Event that cannot is incomplete regardless of whether it is correct.

---

# Responsibilities

## What the Event owns

- **Current truth** about one real-world placement activity.
- **The trust attached to that truth**, and therefore the authority to reject a weaker write.
- **Its own lifecycle state**, including whether a human has settled it.
- **Its provenance** — the immutable record of how it reached its current values.

## What the Event does not own

- **Interpretation.** It does not know how text becomes structured claims.
- **Recognition.** It does not decide which observations refer to it; that judgement is made before it is touched.
- **Acquisition.** It knows nothing about mailboxes, queues, or delivery.
- **Presentation.** It defines no views, groupings, or notifications.
- **Participants and documents.** Adjacent domains with their own models.

---

# Workflow

An Event's life as seen from the outside:

```
   observation                     ┌──────────────────────────┐
   (structured claims + trust)     │  RECOGNITION             │
              │                    │  which Event, if any,    │
              └───────────────────►│  does this describe?     │
                                   └────────────┬─────────────┘
                                                │
                 ┌──────────────────────────────┼───────────────────────┐
                 ▼                              ▼                       ▼
          no Event matched              Event matched            no confident
                 │                              │                identity claim
                 ▼                              ▼                  possible
          ┌─────────────┐               ┌──────────────┐               │
          │   CREATE    │               │  ADJUDICATE  │               ▼
          │ trust sets  │               │ is the new   │        decline to act
          │ the initial │               │ claim at     │        (no Event is
          │   state     │               │ least as     │         touched)
          └──────┬──────┘               │ trusted?     │
                 │                      └──────┬───────┘
                 │                    ┌────────┴────────┐
                 │                   yes               no
                 │                    │                 │
                 │                    ▼                 ▼
                 │           ┌─────────────────┐   leave the Event
                 │           │ APPLY changed   │   unchanged
                 │           │ fields + WRITE  │   (protecting the
                 │           │ HISTORY, in one │    stronger belief)
                 │           │ indivisible act │
                 │           └────────┬────────┘
                 │                    │
                 └────────┬───────────┘
                          ▼
                 the Event is now the
                 system's answer
```

The shape worth noticing: **every path either improves the Event or leaves it alone.** There is no path that degrades it.

---

# State

The Event *is* the system's durable state — the only place where "what is true" persists.

**Belief** — the current values for one activity.
**Trust** — how much those values should be relied on, which governs future writes.
**Lifecycle state** — believed, relocated, awaiting a person, or settled by one.
**Provenance** — the append-only record of accepted changes.

Two things are deliberately absent. There is **no pipeline state** on an Event: nothing about queues, retries, or processing. And there is **no ownership**, because the system is currently single-user; this is the boundary most likely to move.

---

# State Machine

The lifecycle machine appears under Event Evolution. A second, distinct machine governs what happens to an *incoming observation* — it is the one engineers get wrong, because it looks like a write path and is actually an adjudication:

```
              incoming observation
                       │
                       ▼
              is trust above the acting threshold?
                       │
          ┌────────no──┴──yes───────┐
          ▼                         ▼
   route to REVIEW           attempt recognition
   (existing beliefs                 │
    untouched)          ┌────────────┴────────────┐
                        ▼                         ▼
                 no Event matched          Event matched
                        │                         │
                        ▼                         ▼
                     CREATE            is incoming trust >= existing?
                                                  │
                                    ┌─────no──────┴──────yes─────┐
                                    ▼                            ▼
                             REJECT the update            for each field the
                             (existing belief             observation spoke
                              is stronger)                about AND changed:
                                                          apply + record
                                                                 │
                                                          date changed?
                                                                 │
                                                         yes ──► mark rescheduled,
                                                                 regenerate key
```

Note the ordering: **the trust gate runs before recognition.** An untrusted observation never reaches an existing Event at all — it cannot degrade something it is never allowed to touch. This is a deliberate structural protection rather than a check that happens to come first.

---

# Core Algorithm

Conceptually, three steps. Only the third is about the Event.

**Interpret.** Turn an observation into claims about an activity, and attach trust to those claims. Trust is derived from *how the information was obtained*: an explicitly stated date outranks one inferred from "next week"; an explicitly stated venue outranks one guessed from context; an unmentioned field is scored neutrally rather than as a failure — because silence is not evidence of absence.

**Recognise.** Determine which Event, if any, these claims concern. Strongest evidence first, declining to claim identity when the evidence permits more than one answer.

**Adjudicate.** Compare the trust behind the claims against the trust behind the existing belief, and act only if the claims are at least as good. Apply only fields the observation actually spoke about and that actually differ. Record every applied change. If the date moved, mark the relocation and regenerate the recognition key.

The reasoning that ties these together: **the Event is never written by the component that interpreted the text.** Interpretation produces a proposal. Adjudication decides. Keeping these separate is what makes it possible to replace the interpretation strategy entirely — regex, model, document parser, human — without touching the rules that protect the Event.

---

# Engineering Decisions

### Why the Event is the primary entity

**Decision** — Model the real-world activity as the system's central entity; treat messages as evidence.

**Reason** — The user's question is "what is true now?", which is answered by one value, not a list. Making the Event primary moves reconciliation to write time, where it happens once by a component built for it, instead of read time, where every consumer redoes it and consumers can disagree.

**Trade-offs** — Requires identity resolution, which is the hardest correctness problem in the system and carries the worst failure (a false merge). A message-primary design would avoid that problem entirely — by handing it to the user, which is the product's whole reason for existing. The system accepts a hard internal problem to remove a hard user problem.

### Why history is a separate concept from the Event

**Decision** — Record change as its own append-only record rather than as fields on the Event.

**Reason** — The Event answers "what is true now"; history answers "how did this come to be true". These have different shapes (one row versus many), different lifecycles (mutable versus immutable), and different readers. Fusing them would force the Event to carry an unbounded, ever-growing tail and would make its primary question harder to answer.

**Trade-offs** — Two records must be kept consistent, which is why the change and its record are written as one indivisible act. Storage grows with revision count. Accepted, because the alternative — reconstructing history by diffing retained messages — is unreliable precisely when it matters most: after a bad update, when you need to know what a value used to be.

### Why history is immutable

**Decision** — History is written once and never edited or deleted.

**Reason** — Its only purpose is to be trustworthy after something has gone wrong. A mutable audit record is worth nothing at exactly the moment it is needed, because the same fault that corrupted the Event could have corrected the record.

**Trade-offs** — Wrong history entries stay wrong; corrections are made by appending, never by editing. Growth is unbounded. Both are the ordinary price of an audit trail, and both are cheaper than an unexplainable Event.

### Why confidence belongs on the Event

**Decision** — Trust is a property of the Event, not only of the observations that produced it.

**Reason** — Confidence is not a fact about a message; it is a fact about a *conclusion*. It must be readable at the moment the next write is adjudicated, and the thing being written is the Event. Putting it anywhere else would require reconstructing the belief's trustworthiness from its inputs on every update — expensive, and ambiguous once several observations have contributed.

**Trade-offs** — The Event carries a value that is a system artifact rather than a fact about the world, which slightly blurs "the Event models reality." Accepted deliberately: without it, the system has only two possible behaviours — act on everything or act on nothing — and both are wrong. This also makes confidence a first-class product concern, since the acting threshold is the system's most sensitive parameter and errs quietly in both directions.

### Why Event identity exists independently of messages

**Decision** — Identity is grounded in the real-world activity, not in any message or message id.

**Reason** — The same round is described by many messages, and no message declares which round it concerns. If identity were message-derived, every message would produce its own Event, which is the pile-of-duplicates outcome the product exists to prevent. Independent identity is also what lets a *document* — a schedule, a shortlist — inform an Event without a message being involved at all.

**Trade-offs** — Identity must be inferred, and inference can be wrong in both directions. The design accepts that and biases the inference toward the recoverable failure (duplicate) over the unrecoverable one (false merge).

### Why reconciliation happens before persistence

**Decision** — Decide which Event an observation concerns, and whether it may write, before anything is stored.

**Reason** — Write-time reconciliation means the stored state is always directly usable and there is exactly one answer in the system. Read-time reconciliation would let two consumers reach different conclusions from the same data, and would make the confidence gate unenforceable — you cannot protect a stronger belief from a weaker one if both have already been written.

**Trade-offs** — A reconciliation error is baked in, whereas a read-time design could be re-evaluated with better logic later. This is mitigated rather than solved: observations are retained, so beliefs can be rebuilt if the reconciliation rules improve. That retention is what makes an otherwise irreversible decision recoverable.

### Why the recognition key is regenerated on reschedule

**Decision** — When an Event's date changes, its recognition key is rewritten to match, while the Event itself continues.

**Reason** — Future observations will describe the round at its *new* time. If the key still pointed at the vacated slot, those observations would fail exact recognition and could create a duplicate — a reschedule would manufacture the very problem the Event model exists to prevent.

**Trade-offs** — It makes the key mutable, which invites the misreading that identity itself is mutable. This document exists partly to prevent that: continuity is the Event's persistence; the key is only a fast path to recognising it. Any code that treats the key as the Event's true identity will convert reschedules into duplicates.

---

# Invariants

The architectural laws. Violating any of these is a domain error, not a behavioural change.

**1. Every Event represents exactly one real-world placement activity.**
The model's fidelity is measured against the world, not against the messages. Two Events for one round is a defect even if both are internally consistent.

**2. An Event always represents the best currently known truth.**
It is never a historical snapshot, never a copy of one message, and never a partially applied update. What it says is what the system currently believes.

**3. Confidence governs automatic mutation.**
No inference may overwrite a belief held with greater confidence. This is the guard that makes trust meaningful rather than decorative.

**4. Human confirmation outranks inference.**
Once a person has settled an Event, machine conclusions do not silently override it. Otherwise review has no value and the user learns to distrust the system.

**5. Silence never removes information.**
An observation that does not mention a field makes no claim about it. Only an explicit statement clears a value. Most observations are partial, so collapsing this distinction destroys data continuously.

**6. History never mutates.**
Entries are appended, never edited or deleted. An audit record that can be rewritten is worthless at the moment it is needed.

**7. Every accepted change is recorded.**
An Event's values never move without a corresponding history entry. The change and its record are one indivisible act, because an Event that cannot explain itself is incomplete.

**8. Identity is never asserted under ambiguity.**
When evidence permits more than one candidate, no identity claim is made. No claim beats a wrong claim, because a false merge is unrecoverable.

**9. Only the fields an observation spoke about may change.**
An update is a set of field-level revisions, never a wholesale replacement. This is invariant 5 expressed as a write rule.

**10. An Event carries no pipeline state.**
Queues, retries, and processing status describe the system, not the world. A round does not change because a worker is behind.

---

# Failure Handling

**Failure preference**

```
   correct  >  flagged for review  >  stale  >  silently wrong
```

An Event may be out of date. It may be uncertain and say so. It must not be confidently wrong, because the user acts on it without verifying it.

**Failure boundaries.** A bad observation must not corrupt a good Event — enforced by the trust gate, which runs *before* recognition so untrusted claims never reach an Event. A failed interpretation must not alter belief at all: a failure produces no proposal, and no proposal means no write. A wrong reconciliation is contained to the Events involved and remains diagnosable because the observations are retained.

**Recovery.** History makes a bad update explicable and reversible in principle. Retained observations make belief rebuildable if reconciliation rules improve. Human confirmation is the final override and is durable against subsequent inference.

**The honest gaps.** History is recorded but not exposed, so an Event cannot currently explain itself to the person who needs it — invariant 7 is satisfied in storage and unsatisfied in practice. And there is no automated detection of the primary failure mode: a false merge produces no error, no flag, and no signal. It is found by a user noticing that something looks wrong. That is the domain's largest blind spot.

---

# Consistency Guarantees

**One answer per activity.** At most one Event is intended per real-world activity; recognition exists to preserve this, and it is the guarantee most at risk from a recognition error.

**Idempotent creation.** Re-observing an already-known activity does not produce a second Event.

**Monotonic trust under automation.** An Event's confidence does not decrease through automatic updates, because a weaker observation cannot be applied. Human confirmation sets it to certainty.

**Convergent, not immediate.** An Event reflects observations that have been processed. Something announced in the mailbox may not yet be reflected. There is no real-time guarantee.

**Order independence.** Observations may arrive and be processed out of order. Correctness does not depend on order — because adjudication is trust-based rather than last-write-wins. Under a naive model, out-of-order delivery would silently corrupt records; here it merely means a weaker late arrival is rejected.

**Consistency boundary: one Event.** Adjudication reasons about a single Event at a time. There is no cross-Event or cross-company transaction and no globally consistent snapshot. A company's rounds are independent records that happen to share a name.

**Atomic change-plus-history.** An accepted update and its history entry succeed or fail together.

---

# Related Components

Dependency direction is one-way, and it is the shape of the whole system:

```
   Ingestion ──► Interpretation ──► Recognition ──► ADJUDICATION ──► EVENT
   (evidence)    (claims+trust)     (identity)      (may it write?)      │
                                                                         ├─► History
                                                                         │
   Documents ──► Document Intelligence ─────────────────────────────────►│
   (attachments)  (event-affecting facts)                                │
                                                                         ▼
                                                              Review ──► Presentation
```

- **Ingestion** produces evidence. It has never heard of an Event.
- **Interpretation** produces claims and trust. It does not know what already exists.
- **Recognition** is the only component permitted to say two observations concern one Event.
- **Adjudication** is the only path that writes an Event. Everything else proposes.
- **History** is written by adjudication and read by nobody yet.
- **Document Intelligence** is a second source of event-affecting facts, entering at the same adjudication boundary as email — which is the test that the boundary was drawn correctly.
- **Review** is the only path by which a human overrides inference.
- **Presentation** is a pure consumer.

**Nothing upstream of adjudication may write an Event.** That single rule is what makes every invariant above enforceable in one place.

---

# Things The Event Does NOT Do

- **It does not store messages.** Evidence lives with the observation.
- **It does not record interpretation attempts.** What a given observation claimed, and how sure it was, stays with that observation. Only conclusions reach the Event.
- **It does not know how it was extracted.** Replacing the interpretation strategy entirely must not change the Event's shape. This is the test of the boundary.
- **It does not hold documents.** A document's *meaning* may update an Event; the file does not.
- **It does not model people.** Shortlists, seating, and panels describe participants, not the activity.
- **It does not carry processing state.** No queues, retries, or statuses belonging to the pipeline.
- **It does not decide its own identity.** Recognition happens before adjudication; the Event is told which Event it is.
- **It does not notify.** It changes; telling anyone is somebody else's job.
- **It does not model ownership today.** Conceptually inside the boundary, deliberately unimplemented while the system is single-user.

---

# Future Evolution

**Correctness**
- **Detect false merges.** The primary failure mode is currently silent. Even a weak signal — an Event absorbing contradictory observations, or history showing implausible oscillation — would convert an invisible failure into a visible one.
- **Make history readable.** Invariant 7 holds in storage but not in practice while history has no surface. An Event that cannot explain itself to a user is incomplete.
- **Calibrate the acting threshold** against real review outcomes rather than intuition; it is the most sensitive parameter in the domain.

**Scalability**
- **Ownership on the Event**, when the system serves more than one user. It belongs on the Event, not on the messages that produced it.
- **Recognition beyond exact text.** Identity resolution over inconsistent naming is currently lexical; semantic comparison would raise recall, and must not be allowed to raise false merges with it.

**Product**
- **Documents as first-class contributors.** Schedules and shortlists already yield event-affecting facts; routing them through adjudication makes them peers of email rather than a parallel path.
- **Participants as their own domain**, adjacent to the Event and deliberately outside it.
- **Expose confidence and doubt to users**, so the system's uncertainty is legible rather than internal.

**Operational**
- **Measure recognition quality** — duplicates created, merges performed, corrections made. None is currently observable, so the system's central risk is unmeasured.
- **Retain adjudication decisions**, including rejected updates. A rejected write is currently invisible, though "why didn't it update?" is a question users will ask.

---

# Interview Discussion

**Q: Why isn't the message the aggregate root?**
Because a message is an immutable record of something having been said, and the user's question is "what is true now?" Those have different shapes — one is a list, the other is a value. A message-rooted design pushes reconciliation to read time, which means every consumer redoes it, consumers can disagree, and the confidence gate becomes unenforceable because you cannot protect a stronger belief from a weaker one once both are written. The Event is the aggregate root because it is the thing the user is actually asking about; messages are evidence that shaped it.

**Q: Why separate the Event from its history rather than versioning the Event?**
Different questions, different shapes, different lifecycles. The Event answers "what is true now" and must stay small and mutable; history answers "how did it get here" and must be unbounded and immutable. Versioning the Event conflates them and makes the common read — current truth — pay for the rare one. Separation also lets history be immutable while the Event is not, which is exactly the property that makes an audit trail worth having.

**Q: How does this differ from event sourcing?**
Nearly the inverse, despite the shared word. In event sourcing the log is authoritative and current state is a projection you can always rebuild. Here the *Event* is authoritative and history is a descriptive record — you cannot fully rebuild an Event by replaying history, because rejected updates are not recorded and human confirmations override rather than accumulate. This is closer to a mutable aggregate with an audit trail. The reason is that our inputs are untrusted inferences of varying quality, not commands: a log of every inference we ever made is not a foundation to rebuild truth from, since most of the interesting decisions are about which inferences to *ignore*. Note the naming collision is unfortunate — our "Event" is a domain entity (a placement round), not a state-change fact.

**Q: What breaks if you remove Event identity — say, one row per message?**
The product. Every message about a round becomes a separate record, so a round announced, moved, and given a venue appears four times with contradictory values and no indication which is current. The user is back to reconciling by hand, which is the job the system exists to do. You would also lose the confidence gate (nothing to compare against), history (nothing to be the history of), and review (nothing to confirm). Identity is not a feature of this system; it is the system.

**Q: The recognition key contains the date, but a reschedule changes the date. Isn't that a broken identity model?**
It is the tension the model has to manage, and the resolution is to separate continuity from recognition. The Event's continuity is unconditional — it survives every revision, which is why history spans a reschedule. The key is a *description* used for fast exact recognition, so when the round moves, the key follows it. If the key stayed at the vacated slot, later observations of the moved round would fail to recognise it and create a duplicate — a reschedule would manufacture exactly the problem the model prevents. The genuine risk is engineers reading the key as the identity; that misreading turns reschedules into duplicates.

**Q: Why highest-trust-wins rather than last-write-wins?**
Last-write-wins assumes writes are authoritative statements. Ours are inferences of varying quality, so recency is a poor proxy for correctness. Given a user who acts on this data without double-checking, silently degrading a good record is worse than declining an update. The cost is that a correct low-confidence correction can be rejected — which is what the review queue is for. It also buys order-independence for free: out-of-order arrival is safe because a weaker late observation is rejected on its merits rather than because of when it arrived.

**Q: Why is a duplicate acceptable but a false merge not?**
Recoverability. A duplicate is visible — the user sees the same round twice and can act. A false merge silently destroys information about two activities and leaves a plausible-looking record with no signal that anything is wrong, in a system trusted enough not to be verified. Every threshold in the recognition path expresses that asymmetry, including the rule that the weakest evidence tier only claims identity when exactly one candidate exists.

**Q: Why doesn't confidence live with the extraction that produced it?**
It does, as well — each interpretation attempt retains its own. But the Event needs *its own* trust value because confidence is a property of the belief, not of any single contributor, and it must be readable at the instant the next write is adjudicated. Reconstructing a belief's trustworthiness from its inputs on every update would be expensive and ambiguous once several observations have contributed.

**Q: What alternatives were rejected in the domain model?**
Message-as-primary (rejected: hands reconciliation back to the user). Event-sourcing the Event (rejected: our inputs are untrusted inferences, and the interesting decisions are about which to ignore). Content-hash identity instead of attribute identity (rejected: text is unstable across senders and parser versions, so it produces both false splits and false merges). Read-time reconciliation (rejected: consumers can disagree and the confidence gate becomes unenforceable). Folding participants into the Event (rejected: forces a premature student model and distorts an entity that describes an activity, not people).

**Q: How would you know the Event model is failing in production?**
Today, mostly you would not — which is the honest answer and the most important gap in the domain. False merges emit no error. Recognition quality is unmeasured: duplicates created, merges performed, and corrections made are all unobservable. Rejected updates leave no trace, so "why didn't it update?" is unanswerable. History is recorded but has no surface, so the one mechanism designed to explain a wrong Event cannot currently be read by anyone. Making the central risk measurable is the highest-value work in this domain.

---

# Confidence

**High** for the domain model; **Medium** for one attribution, noted below.

Every structural claim is derived directly from the source: the three-attribute basis of identity and its regeneration on reschedule; the tiered recognition strategy and its refusal to claim identity when the weakest tier yields more than one candidate; the confidence gate rejecting weaker updates; field-level updates restricted to fields an observation actually spoke about; the explicit-versus-unmentioned distinction that makes silence non-destructive, which appears both in update logic and in how trust is scored; the lifecycle states and their transitions; human confirmation raising trust to certainty and clearing doubt; and history written atomically with the change it describes.

The claim that **history is immutable** is Medium confidence in attribution. There is no enforcement preventing edits — the property holds because nothing in the system modifies history and the design clearly intends append-only semantics. It is documented here as a domain law because that is what it must be, but a reader should know it is currently a convention rather than a constraint. If it matters, enforce it.

Statements about **failure asymmetry** (duplicate versus false merge) are inference from the recognition thresholds and the product's stated preferences rather than from an explicit comment. The design is consistent with that reading, and no alternative reading explains the "exactly one candidate" rule.

Statements about **observability gaps** are direct: there is no detection of false merges, no retention of recognition or adjudication outcomes, and no read path for history.

Test coverage relevant to this domain exists for confidence scoring, recognition, and the end-to-end ingestion path. The update adjudication rules — the confidence gate, field-level application, and reschedule handling — are **not directly covered**, which is worth knowing before changing them.
