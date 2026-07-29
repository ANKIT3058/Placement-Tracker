# Event History (EventUpdate)

Engineering Handbook — Domain Model
Status: canonical. Companion to `Event.md`; together they define the domain.

`Event.md` answers *what is an Event?*
This document answers *how is an Event allowed to change, and what does the system owe you afterwards?*

---

# Executive Summary

**Purpose**

An Event is mutable by design — it is the system's current belief about a placement activity, and beliefs get revised as better information arrives. Mutation without memory, however, produces a system that can be wrong and cannot say how it got that way. Event History exists so that every accepted revision leaves behind a permanent, specific statement of what changed, from what, to what, and when. It is what converts an Event from a value into a claim that can be audited, explained, and — when the system gets it wrong — reconstructed.

**Core Idea**

Overwriting is how the present is maintained; recording is how the past survives being overwritten, and a system that infers its data needs both.

**Primary Invariant**

Every accepted change to an Event produces exactly one immutable history entry, written in the same indivisible act as the change itself.

**Primary Failure Mode**

An Event's values move without a corresponding entry, producing a belief the system cannot explain — currently a real gap, not a hypothetical one, since human confirmation writes no history at all.

---

# Domain Definition

**An EventUpdate is** a permanent, immutable statement that the system once believed one thing about a placement activity and now believes another — naming the specific aspect that changed, the value it held before, the value it holds now, and the moment the revision was accepted. It is not a log line, not a diff, and not a copy of the observation that triggered it. It is the domain's memory: the record of a belief revision that the system committed to, retained so that any current value can be traced backwards to the sequence of revisions that produced it. An Event says what is true; its history says how that truth came to be held, which is the only thing that makes a wrong Event recoverable rather than merely wrong.

---

# Problem Statement

The system's central entity is mutable on purpose. A round is announced, moved, given a venue, moved again. Each revision is correct at the time it is applied, and each one destroys the value it replaced.

That destruction is the problem. Consider the questions a user or an engineer will eventually ask:

- *This says the test is on the 17th. I remember the 14th. Which of us is wrong?*
- *The venue was set yesterday and is blank today. What happened?*
- *This event has been rescheduled twice — or has the extractor been flip-flopping?*
- *We shipped a bad extraction rule on Tuesday. Which events did it corrupt?*

None of these can be answered by an entity that holds only its current values. Every one of them is a question about a value that no longer exists.

This matters more here than in an ordinary CRUD system for a specific reason: **nobody typed this data.** In a system where a human entered a value, "what did it used to be?" is answerable by asking them. Here, every value is an inference drawn by the system from ambiguous text, applied automatically, without anyone watching. When such a system is wrong, there is no human memory to fall back on — the system's own memory is the only record that the previous value ever existed.

History exists to make the system accountable for its own inferences.

---

# Why Change Is Recorded

## Why overwrite is not sufficient

Overwrite is sufficient when writes are *authoritative statements*. If a human types a date, the new value supersedes the old one completely and the old one has no residual meaning.

Our writes are not statements. They are **inferences of varying quality**, produced automatically from noisy text, and applied by a system that has explicitly modelled the possibility that it is wrong. In that setting the previous value retains meaning: it is what the system concluded from earlier evidence, and if the current value turns out to be wrong, the previous one is the most useful thing in the system.

Overwrite alone also makes a specific class of bug undiagnosable. When an extraction rule regresses, the damage is silent and distributed — a field on many Events, each of which now looks like a perfectly ordinary value. Without history, there is no way to distinguish "this event was always the 17th" from "this event was the 14th until Tuesday." The blast radius of a bad rule becomes unknowable, which means it also becomes unfixable.

## What history answers

- **What did this used to say?** The question a user asks when the system contradicts their memory.
- **When did it change?** Distinguishing "the placement cell moved it" from "our extractor changed its mind."
- **What else changed at the same time?** Turning a single suspicious value into a pattern.
- **Has this been stable or volatile?** An Event revised five times in two days is telling you something an Event revised once is not.
- **What did a deployment do?** The only way to bound the damage of a regression after the fact.

## Why history is product, not debugging

The temptation is to file this under observability. That misreads who needs it.

The person who will most need to know why an Event says what it says is **the student who is about to act on it**. When the system displays a date the user believes is wrong, exactly one of two things is true: the round moved, or the system made a mistake. Those demand opposite responses — trust it, or go check your mail — and the user cannot tell them apart from the value alone. History is the only thing in the system that distinguishes them.

A system that infers on your behalf and cannot explain itself will be abandoned after its first visible error. **The ability to explain a revision is a feature of the product**, not a convenience for engineers. That it is *also* the best debugging tool available is a fortunate side effect of building it for the right reason.

This ordering has a practical consequence, stated plainly: history is currently recorded and has no read path. Judged as debugging infrastructure, that is acceptable — engineers can query it. Judged as product, it is unfinished.

---

# Philosophy of Change

Three ideas are easy to collapse into one another, and the system keeps them deliberately separate because they answer different questions and have different lifecycles.

## Truth changes

The Event holds one value per aspect, and that value is replaced as better information arrives. Truth is **singular, current, and mutable**. Its question is *what should I act on?* and it must be answerable by a single read, with no reconstruction.

## Evidence accumulates

Messages and documents pile up, never revised, each a permanent record of something having been observed. Evidence is **plural, historical, and immutable**. Its question is *what were we told?* Evidence is not truth: four messages can say four different things, and three of them are superseded.

## History remembers

Between the two sits a third thing that is neither. History is **plural and immutable like evidence, but it records decisions rather than observations**. Its question is *what did we decide, and when?*

## Why three and not two

Because each pair, collapsed, loses something specific.

**Collapse truth into evidence** — store only messages, derive the answer on read — and you have no single answer, no place to attach confidence, and no way to enforce the rule that a weaker inference may not overwrite a stronger one. You have handed reconciliation back to the reader, which is the work the product exists to remove.

**Collapse history into evidence** — keep messages and rebuild the past by re-reading them — and you cannot distinguish what was *observed* from what was *accepted*. Most observations are rejected, superseded, or partially applied. Evidence tells you what arrived; only history tells you what the system did about it. Replaying evidence through today's rules also answers a different question than what actually happened, since the rules have changed since.

**Collapse history into truth** — version the Event, or keep old values inline — and the entity that must answer one question fast is now carrying an unbounded tail, and the immutable thing and the mutable thing share a lifecycle. Immutability that lives inside a mutable entity is a convention waiting to be violated.

The three-way split is the domain's core structural claim: **evidence is what we saw, history is what we decided, truth is what we now hold.**

---

# What Constitutes A Change

Not every mutation is a change in the domain sense. The distinction is precise and load-bearing: **a change is an accepted revision to a believed value.**

| Occurrence | Is it a domain change? | Recorded? |
|---|---|---|
| **Field modification** — an accepted revision to an Event's described values | Yes | **Yes** |
| **Correction** — a modification whose purpose is to fix a previously wrong value | Yes; indistinguishable from any other modification | **Yes** |
| **Reschedule** — the activity relocated in time | Yes, and the most consequential kind | **Yes**, as a revision of the date |
| **Creation** — an Event coming into being | No — nothing was revised | No, deliberately |
| **Confidence increase** — the system's trust in a belief rising | No — trust is not a described value | No, deliberately |
| **Confidence rejection** — a weaker observation declined | No — nothing changed | No, deliberately |
| **Manual confirmation** — a human settling an Event | **Yes** — and this is the most authoritative change the system can experience | **No — and this is a defect** |

## The reasoning behind each exclusion

**Creation is not a change.** There is no prior value, so there is nothing to remember. An Event's existence is its own first fact; recording "came into being" as a revision would put an entry with no meaningful prior state at the head of every history. The Event's own creation time already carries that information.

**Confidence movement is not a change.** Confidence describes the *belief's* trustworthiness, not the activity. Recording it would fill history with entries that tell a reader nothing about the world — and history's audience is a person asking what happened to their placement round, not a system auditing its own certainty.

**Rejection is not a change** — this is the sharpest of the exclusions and the one most often questioned. When a weaker observation is declined, the Event is untouched. Recording the rejection would mean history contained things that never happened, and a reader could no longer trust that every entry describes a real revision. **History records accepted belief, not attempted belief.** The cost is real: "why didn't it update?" is currently unanswerable, and that is a legitimate observability gap. But it is a gap that should be filled by a *separate* record of adjudication decisions, not by polluting the memory of what actually occurred.

**A status transition is not itself a change.** When a date moves, the Event is marked as rescheduled — but the recorded revision is the date, not the status. The status is a *consequence* of the change, derivable from it. Recording both would mean recording the same fact twice at different levels of abstraction.

## The exclusion that is a defect

**Manual confirmation currently writes no history.** When a human corrects a company or round name and confirms an Event, the values change, trust jumps to certainty, and the doubt marker clears — with no record that any of it happened.

This is not a principled exclusion. It is the exact inverse of one: a human decision is the **most** authoritative change the system can experience, and it is the only kind of change the system currently forgets. It means the one revision a user would most want explained — *I changed this myself, what did it say before?* — is the one that cannot be. It also breaks the domain's own law that accepted changes are recorded.

Two further exclusions follow from the same code path and are worth knowing: the aspects a human edits during review are **not among the aspects the automated path records at all**, so even routing confirmation through the recording path would need the recorded vocabulary widened. Closing this is the highest-value correctness work in this part of the domain.

---

# Responsibilities

## What history owns

- **The record of accepted revisions** — which aspect, prior value, new value, when.
- **Attribution to exactly one Event.** A history entry belongs to one Event and is meaningless without it.
- **Permanence.** Once written, an entry is a fact about the past.

## What history does not own

- **The present.** It never determines what an Event currently says.
- **Evidence.** It does not store the observation, its text, or its confidence.
- **Decisions not taken.** Rejections, retries, and failures leave no entry.
- **Interpretation.** It records that a value changed, not why the system concluded it should.
- **Presentation.** It defines no views or timelines; it is raw memory.

---

# Workflow

```
        adjudication accepts an update
                     │
                     ▼
        determine which aspects actually
        differ from current belief
                     │
        ┌────────────┴────────────┐
        │                         │
   none differ              one or more differ
        │                         │
        ▼                         ▼
   nothing happens     ┌─────────────────────────────┐
   (no write,          │   ONE INDIVISIBLE ACT       │
    no history)        │                             │
                       │  1. write one entry per     │
                       │     differing aspect        │
                       │     (aspect, old, new, now) │
                       │                             │
                       │  2. apply the new values    │
                       │     to the Event            │
                       │                             │
                       │  both succeed, or neither   │
                       └──────────────┬──────────────┘
                                      ▼
                          Event now holds new truth;
                          history holds the memory of
                          the truth it replaced
```

Two properties are worth reading off this diagram. **A no-op writes nothing** — an observation that merely restates what is already believed produces no entry, which keeps history a record of *change* rather than a record of *traffic*. And **the entries are written before the values are applied**, inside one boundary, so there is no instant at which the Event has moved and its memory has not.

---

# State

History is the system's **only append-only state**. Everything else — beliefs, cursors, statuses — is current-value state that is overwritten in place.

Each entry holds: the Event it belongs to, which aspect changed, the prior value, the new value, and when the revision was accepted. Nothing else. The entry is complete at the moment of writing and is never revisited.

Two fidelity caveats a reader should know, because they bound what history can honestly answer:

**Values are recorded as text, not as typed values.** A date, a time, and a venue all become strings. This makes history universally readable and permanently decoupled from how the Event stores things, at the cost of not being directly comparable to live values without interpretation.

**Absence is recorded as a literal marker rather than as a typed null.** "This had no venue" and "this had the text *null*" are not distinguishable by shape alone. In a domain whose central rule is that *silence is not deletion*, that is an unfortunate collision — history is slightly less precise about absence than the Event model itself is.

---

# State Machine

**There is none, and its absence is the point.**

A history entry has no lifecycle. It is created and then it is permanently what it is — no pending state, no confirmed state, no revision, no expiry. Introducing any state to a history entry would mean introducing mutability to the one thing in the domain whose entire value derives from not being mutable.

If a future requirement seems to call for a history entry that changes — a correction, a redaction, an annotation — that requirement is asking for **a new entry**, or for a separate record type layered beside history. It is never asking for this one to move.

---

# Core Algorithm

Conceptually trivial, and deliberately so — history is the one place in the system where cleverness has no upside.

1. **Compare.** For each aspect the incoming observation actually spoke about, determine whether it differs from what is currently believed. Aspects the observation was silent about are not candidates: *silence is not a change*.
2. **Record.** For each differing aspect, write one entry naming it, its prior value, its new value, and the time.
3. **Apply.** Update the Event to hold the new values.
4. **Commit.** Steps 2 and 3 succeed together or not at all.

The reasoning worth extracting: **the comparison happens against current belief, not against the previous observation.** History therefore describes the trajectory of the *system's belief*, not the trajectory of the incoming messages. Two observations that both say "the 17th" produce one entry, not two, because the belief moved once. This is what makes history a meaningful narrative rather than a transcript of inbound traffic.

---

# Atomicity

## Why the Event and its history must move together

They are two representations of one act. The Event holds the *result* of a revision; history holds the *fact* of it. A revision that produced only one of them is not a partial success — it is a corrupted record of something that did happen.

The two failure directions are not symmetric, and both are bad in distinct ways.

**Values applied, history missing.** The Event now says something no record explains. The prior value is destroyed with no trace, so the change is undiscoverable and unrecoverable. Worse, the system now *looks* consistent: a value with no history is indistinguishable from a value that has never changed. This is silent corruption of the audit trail — the failure mode an audit trail exists to prevent.

**History written, values not applied.** The Event claims a revision that never took effect. The record predicts rather than remembers. A reader reconstructing the past would derive a value the Event never held, which makes every subsequent inference from history wrong. **History must never contain a change that did not happen** — its trustworthiness is not statistical, it is absolute, and one fabricated entry devalues all of them.

## What breaks without atomicity

The entire proposition. History's only property of value is that it can be trusted *after* something has gone wrong. If the mechanism that writes it can itself fail halfway, then in exactly the circumstances where you need it — a crash, an error, an unexpected state — it is least likely to be correct. **A non-atomic audit trail is worse than none**, because it invites confident reasoning from a record that is wrong precisely when it matters.

This is why the recording and the application share one transactional boundary, and why nothing else may write an Event outside that boundary. Atomicity is not an optimization here; it is what makes the invariant expressible at all.

---

# Why History Is Immutable

**Append-only.** New facts about the past arrive only as new entries. The sequence grows at one end and never in the middle.

**No edits.** An entry recorded what the system believed at a moment. That belief was held; editing the entry would not change the past, it would only make the record lie about it.

**No deletes.** Removing an entry destroys the only evidence that a value ever existed — which is the precise capability history was created to provide.

**Corrections through new entries.** If a revision was wrong, the response is another revision, which produces another entry. The mistake and its correction both remain visible, and the sequence tells the more useful story: not just what the value is, but that the system got it wrong and when it recovered.

## Why immutability matters here specifically

Because history's audience arrives **after a failure**, and asks a question that only makes sense if the record is trustworthy. If entries could be edited, the same defect, deployment, or bad actor that corrupted an Event could have corrected its history — so the record would be least reliable in exactly the situation it exists for. Mutable audit trails do not degrade gracefully; they become worthless the moment anyone realises they *could* have been changed.

Immutability also removes a whole class of question. Nobody needs to ask whether a history entry is current, who last touched it, or whether two readers see the same thing. A fact about the past has no versions.

## The honest qualification

Immutability here is **a convention, not a constraint**. Nothing in the system prevents an entry from being edited or deleted; the property holds because only one code path ever writes history and none ever modifies it.

There is also one real deletion path: history is bound to its Event's existence, so removing an Event removes its memory. This is coherent — an Event's history has no meaning without the Event — but it means "no deletes" is accurate about *revising* history and not literally true about *destroying* it. Anyone who needs history to survive its Event needs a different arrangement, and should know that today it does not.

---

# History Boundaries

## What belongs inside a history entry

**Which Event.** An entry is meaningless unattached; it is a statement about one activity.

**Which aspect changed.** "Something changed" is not memory. The specific aspect is what makes an entry answerable.

**The prior value.** The reason the entry exists. Everything else can be reconstructed from the Event; this cannot be reconstructed from anything.

**The new value.** Redundant with the Event at the moment of writing, essential immediately afterwards — the next revision overwrites it, and the sequence must remain readable without the Event.

**When it was accepted.** Distinguishes "the round moved" from "our extractor changed its mind," which is the single most useful question history answers.

## What deliberately does not belong

**Raw observations.** The message that triggered a revision is evidence and lives with evidence. Embedding it would make each entry unbounded and fuse two lifecycles — evidence is retained on its own schedule, history forever.

**Extraction attempts.** What the system *tried* to conclude, with what confidence, from what text, is a record of interpretation. It is retained alongside the observation. Only accepted revisions reach history. Mixing them would mean history contained things that never took effect.

**Prompts and model behaviour.** How a conclusion was computed belongs to the interpretation layer. If the extraction strategy is replaced entirely, no history entry should change shape — that is the test of this boundary.

**Retry information and queue state.** How many times a job ran describes the pipeline, not the world. A round did not change because a worker retried.

**Transient failures.** A failed extraction produced no revision, so there is nothing to remember. Failures are operational events; they belong to logs and to the message's own status.

**Rejected updates.** An observation declined for insufficient trust changed nothing. Recording it would break the guarantee that every entry describes a real revision. This is the boundary most worth defending, and the one most likely to be argued against — see Engineering Decisions.

**Derived interpretation.** Whether a change constituted a reschedule, whether it was a correction or a first assignment, whether it looks suspicious — all derivable from the sequence. History stores facts; readers do inference.

---

# Relationship with Event

**Event = Present. History = Memory.**

```
   ┌──────────────────────┐         ┌──────────────────────────────┐
   │        EVENT         │         │          HISTORY             │
   ├──────────────────────┤         ├──────────────────────────────┤
   │ one per activity     │         │ many per Event               │
   │ mutable              │         │ immutable                    │
   │ answers "what now?"  │         │ answers "how did we get      │
   │                      │         │          here?"              │
   │ read constantly      │         │ read rarely, and only when   │
   │                      │         │ something has gone wrong     │
   │ must stay small      │         │ grows without bound          │
   │ authoritative        │         │ explanatory                  │
   └──────────┬───────────┘         └──────────────┬───────────────┘
              │                                    │
              └────────── one act ─────────────────┘
                    every accepted revision
                    writes both, atomically
```

They complement each other by having opposite properties on every axis, which is exactly why they are separate entities rather than one. The Event optimizes for a question asked constantly and answered in one read. History optimizes for a question asked rarely and answered by reading a sequence. Fusing them would force each to carry the other's costs: the Event would grow unbounded, and history would inherit mutability.

The relationship is **one-directional and non-operational**. The Event does not consult its history to answer anything. History explains the present; it does not produce it. This is a deliberate limitation and the clearest line between this design and event sourcing — see below.

---

# Relationship with Messages

**Messages are evidence. History entries are accepted belief revisions.** They are related but categorically different, and conflating them is the most common misreading of this model.

| | Message | History entry |
|---|---|---|
| Records | something was **said** | something was **decided** |
| Author | the outside world | the system |
| Truth value | true forever as a record of an utterance | true forever as a record of a decision |
| Relationship to belief | may or may not have changed anything | by definition changed something |
| Count per revision | zero, one, or many | exactly one per changed aspect |

The cardinality is where the distinction becomes concrete. A message may produce **no** history at all — it was rejected as too weak, it merely restated existing belief, or it concerned an Event that could not be identified. A message may produce **several** entries, if it revised a date and a venue at once. And a revision may be triggered by something that is not a message at all — a human confirmation, or a parsed document.

So neither direction is a mapping. **Evidence tells you what arrived; history tells you what the system did about it**, and most of what arrives changes nothing. A model that treated messages as the history would report enormous activity and almost no information.

---

# Relationship with Event Sourcing

Engineers see an immutable append-only sequence of changes attached to an entity and reach for the term. It is worth being precise, because the difference is architectural rather than cosmetic.

## What is genuinely similar

Both keep an append-only, immutable sequence describing how an entity changed. Both treat the past as something to preserve rather than discard. Both let you reconstruct, at least approximately, what an entity looked like at an earlier time.

## Why this is not event sourcing

**Authority is inverted.** In event sourcing the log is the system of record and current state is a *projection* — derived, disposable, rebuildable at any time. Here, the **Event is authoritative** and history is descriptive. If the two ever disagreed, the Event wins. Delete every history entry and the system continues to function, losing explanation but not truth. Delete an event-sourced log and you have lost everything.

**Reconstruction is conceptual, not operational.** Nothing in this system rebuilds an Event from its history, and nothing could reliably: rejected updates are absent, the recorded vocabulary is narrower than the Event's full set of aspects, and human confirmations currently write nothing. History is a *narrative* of change, not a *replayable* one. Event sourcing's defining property is that replay is authoritative; ours is that replay is illustrative.

**The records are decisions, not commands or facts-in-themselves.** An event-sourced event is the primary fact — "OrderPlaced" *is* what happened. A history entry is a *description of a mutation* the system performed on its belief. The primary fact lives outside the system entirely: a real placement round moved, and we noticed.

**Rejections are absent by design.** An event-sourced system would record the attempt, because the log is the truth of what the system did. We deliberately record only what took effect, because our log's job is to explain the Event, not to narrate the system's internal deliberation.

## What this actually is

**A mutable aggregate with an audit trail.** Ordinary, well-understood, and appropriate to the domain for a specific reason: **our inputs are untrusted inferences, not commands.** Event sourcing works beautifully when each input is an authoritative fact worth replaying. Here, most inputs are wrong, superseded, or ignored — and the interesting decisions are about *which inferences not to apply*. A log faithfully recording every inference we ever made would not be a foundation to rebuild truth from; it would be a record of noise, most of which the system correctly discarded.

If the domain ever changes such that inputs become authoritative — a structured feed from a placement office, say — event sourcing becomes a genuinely better fit. That is the condition to watch for.

---

# Philosophy

**1. Truth is revisable; memory is not.**
The Event is allowed to change its mind. History is not allowed to change its story.

**2. History explains belief; it does not produce it.**
The present is never derived from the past operationally. Explanation is a read concern.

**3. History records accepted belief, not attempted belief.**
If it never took effect, it never happened here.

**4. Rejected changes leave no history.**
An entry is a promise that something real occurred. Rejections belong in a different record, or nowhere.

**5. Every accepted change leaves exactly one trace.**
Not zero — the change would be unexplainable. Not many — the record would fabricate activity.

**6. A change and its memory are one act.**
Two writes, one boundary. A partial revision is a corrupted record of a real event.

**7. Silence is not a change.**
An observation that says nothing about an aspect revises nothing and records nothing.

**8. A correction is information, not an embarrassment.**
That the system was wrong and recovered is worth more to a reader than the appearance of never having been wrong.

**9. History serves humans, not machines.**
No code path depends on it. Its entire audience is a person asking why — which is why it is unfinished until it can be read.

**10. An Event without history cannot explain itself.**
And a system that cannot explain itself will be abandoned after its first visible mistake.

---

# Engineering Decisions

### Why append-only

**Decision** — History grows only by addition. Entries are never edited or removed.

**Reason** — Its sole value is trustworthiness after a failure. A record that can be revised is least reliable exactly when it is needed, because whatever corrupted the Event could have corrected the record.

**Trade-offs** — Wrong entries persist forever and are corrected only by appending, so a reader must interpret a sequence rather than read a value. Growth is unbounded. Both are the ordinary price of an audit trail, and cheaper than an unexplainable Event. Note the property is currently a convention rather than an enforced constraint.

### Why field-level rather than whole-Event history

**Decision** — Record one entry per aspect that changed, naming that aspect specifically.

**Reason** — The questions history exists to answer are aspect-specific: *what did the venue used to be?*, *when did the date change?* A whole-Event record forces every reader to diff two blobs to recover the fact the entry was written to convey. Field-level entries also make the common case — one aspect moved — precise and small.

**Trade-offs** — A single logical revision spanning three aspects becomes three entries with no grouping, so "these changed together" must be inferred from timestamps. That is a genuine loss of fidelity, and adding a revision identifier would recover it cheaply. Field-level also makes the recorded vocabulary explicit, which is how the gap in the previous section became visible: aspects nobody added to the comparison are silently unrecorded.

### Why not snapshots

**Decision** — Record deltas, not copies of the Event at each point in time.

**Reason** — Snapshots answer "what did it look like?" but bury the more useful question, "what changed?", inside a diff the reader has to perform. Since most revisions touch one aspect, snapshots would store overwhelmingly redundant data to express a small fact. Deltas also stay meaningful when the Event's shape evolves; snapshots become archaeological.

**Trade-offs** — Reconstructing the Event as of a past moment requires replaying deltas rather than reading one row, and — because the recorded vocabulary is narrower than the Event — that reconstruction is incomplete. Accepted, because point-in-time reconstruction is not a use case the domain needs; explanation is.

### Why not overwrite alone

**Decision** — Keep memory alongside the mutation instead of just replacing values.

**Reason** — Every value here is an automated inference. When one is wrong, the previous value is the most useful object in the system, and nobody has it in their head because nobody typed it.

**Trade-offs** — A write on every revision and unbounded growth, for data with no current reader. Deliberate: history cannot be reconstructed retroactively, so it must exist before the feature that reads it. Building the record first and the reader later is the correct order, even though it means carrying cost ahead of value.

### Why atomic writes

**Decision** — The Event's new values and its history entries commit together or not at all.

**Reason** — They are two halves of one act. Applied-without-recorded destroys the prior value with no trace and, worse, looks identical to a value that never changed. Recorded-without-applied makes history claim something that did not happen, which devalues every entry.

**Trade-offs** — Every revision pays for a transaction, and all writers must go through one boundary — no convenience path may touch an Event directly. That constraint is the mechanism by which the invariant is enforceable in one place, and it is exactly the constraint the manual-confirmation path currently violates.

### Why rejected updates disappear

**Decision** — An observation declined for insufficient trust leaves no trace in history.

**Reason** — History's guarantee is that every entry describes a revision that actually occurred. Admitting rejections would mean a reader could no longer assume an entry means something changed, which is the property that makes the record readable at all. Most observations are rejected or redundant, so recording attempts would bury the signal under traffic.

**Trade-offs** — Real and acknowledged: *"why didn't it update?"* is currently unanswerable, and a persistently rejected correct value is invisible. This is a genuine observability gap. The right fix is a **separate record of adjudication decisions** — attempted, rejected, why — rather than relaxing history's meaning. Two records with clear meanings beat one with a muddy one.

### Why accepted updates persist forever

**Decision** — No expiry, no pruning, no archival tier.

**Reason** — An entry's value is not uniform over time and is not highest when fresh. A two-year-old entry is what tells you an extractor has always mishandled a particular sender. Age-based pruning discards exactly the long-baseline data that makes patterns visible.

**Trade-offs** — Unbounded growth in a table nothing reads. Tolerable at current volume — entries accrue only on real revisions, which are a small fraction of observations — and revisitable if it stops being true. Note that permanence is bounded in one way already: history is bound to its Event's existence and does not survive it.

---

# Invariants

The architectural laws for change. Violating any is a domain error, not a behavioural change.

**1. Every accepted change produces exactly one history entry per changed aspect.**
Zero makes the change unexplainable; more than one fabricates activity that did not occur.

**2. A change and its history commit as one indivisible act.**
Neither half may exist without the other, in either direction.

**3. History never changes.**
Entries are appended, never edited or deleted. A record that can be revised is worthless at the moment it is needed.

**4. History records accepted belief, not attempted belief.**
Rejections, retries, and failures leave no entry. An entry is a promise that something real occurred.

**5. History never predicts.**
Every entry describes a revision that already took effect. Nothing is recorded in anticipation.

**6. Every entry belongs to exactly one Event.**
An unattached entry is not memory; it is noise.

**7. Every entry names a specific aspect and carries both its prior and its new value.**
"Something changed" answers no question history exists to answer.

**8. The present is derived from history conceptually, never operationally.**
No code path reads history to determine what is true. Reconstruction is a narrative capability, not a mechanism.

**9. Silence produces no entry.**
An observation that does not speak about an aspect revises nothing and records nothing.

**10. A no-op produces no entry.**
Restating an existing belief is not a change. History records movement, not traffic.

---

# Failure Handling

**Partial failures.** Prevented rather than handled: the entries and the values share one transactional boundary, so a mid-revision failure leaves both unwritten. The Event keeps its prior values and its memory stays consistent with them. **The safe outcome of a failed revision is that nothing happened** — the observation can be re-processed, and re-processing a revision that never applied produces the correct result.

**Atomicity failures.** If the boundary itself were violated — a writer touching an Event outside it — the damage is silent in the applied-without-recorded direction and corrupting in the recorded-without-applied direction. There is no automated detection of either. The mitigation is structural, not operational: exactly one code path may revise an Event, and reviewers should treat any new direct write as a defect.

**Recovery.** History makes a bad revision explicable and reversible in principle: the prior value is right there. Recovery is manual today — there is no read path, so it requires a direct query, and no automated rollback exists.

**Missing history.** Currently a live condition, not a hypothetical, because manual confirmation writes nothing. Its signature is a value with no entry explaining it, which is indistinguishable from a value that never changed. This is the failure mode an audit trail exists to prevent, and the system presently exhibits it on its most authoritative path.

**Duplicate history.** Two entries for one revision would overstate volatility and make an Event look unstable when it was not — a real risk once history is exposed, since volatility is one of the signals a reader will use. Structurally unlikely today: entries are written once per changed aspect inside a single boundary, and a retried job that finds values already applied detects no differences and writes nothing.

**Manual corrections.** A human correction is a revision like any other and *should* leave an entry naming the human as its source. It does not. Beyond the missing record, the aspects a human edits are not among those the comparison examines, so closing this requires widening the recorded vocabulary as well as routing confirmation through the recording path.

**Rollback philosophy.** There is no undo, and the omission is deliberate. **Reverting is a new revision, not the erasure of an old one.** Restoring a prior value produces a fresh entry recording the restoration, so the sequence shows the mistake and the recovery. A rollback that removed entries would be the system editing its own memory to make itself look correct — which is precisely what immutability exists to forbid.

---

# Consistency Guarantees

**Append-only.** Entries are added, never modified. Guaranteed by convention and single-writer discipline, **not enforced by a constraint** — an honest statement of the current strength.

**Atomicity.** An accepted revision and its entries commit together or not at all. Guaranteed structurally by the shared transactional boundary. This is the strongest guarantee in this part of the domain.

**Completeness, qualified.** Every change *made through the automated revision path* is recorded. Changes made through the manual confirmation path are **not**. The invariant is architecturally intended and currently not universally satisfied — the single most important qualification on this page.

**Ordering.** Entries carry the time a revision was accepted and are readable in that order. Ordering is by acceptance, **not by the order events occurred in the world** — a message about Monday processed after a message about Tuesday appears later in history. History is a record of when the system changed its mind, not of when reality changed.

**Idempotency.** Re-processing an observation that has already been applied produces no new entries, because comparison is against current belief and finds no differences. Re-processing is therefore safe and does not inflate history.

**Audit guarantees — precisely what is promised:**
- If an entry exists, the revision it describes **did occur**. (Strong.)
- If a revision occurred through the automated path, an entry **exists**. (Strong.)
- If a revision occurred through manual confirmation, an entry **does not exist**. (Known gap.)
- An entry's contents are **as written and never revised**. (Convention.)
- History for an Event that still exists is **complete for the automated path since the Event's creation**. (Strong.)
- History does **not survive its Event's deletion**. (Cascade.)

**Consistency boundary: one Event.** No cross-Event guarantee, no global ordering, no consistent snapshot across Events. Two Events revised by the same observation carry independent, unlinked entries.

---

# Related Components

```
   Evidence          Adjudication              Truth            Memory
   (messages,   ──►  (may this write?)  ──►   EVENT    ──┬──►  HISTORY
    documents)             │                              │
        │                  │                              └── one act,
        │                  ▼                                  one boundary
        │           rejected → nothing recorded
        │
        └── retained independently; the audit path when history
            is insufficient
```

- **Adjudication** is the only writer of history, because it is the only writer of Events. This is not a coincidence — it is the mechanism by which the atomicity invariant is enforceable in one place.
- **The Event** is history's subject and its owner. History has no meaning and no lifetime apart from it.
- **Evidence** is the deeper audit layer. When history says a venue changed at a time, evidence says what arrived that caused it. The two are complementary and deliberately not merged.
- **Presentation** is the intended consumer and currently does not exist. Until it does, this subsystem has no reader.

Dependency direction: **history depends on the Event; nothing depends on history.** That is what makes it safe — no behaviour changes if it is absent — and also what makes it easy to under-prioritize.

---

# Things This Subsystem Does NOT Do

- **It does not determine the present.** No code reads history to decide what is true.
- **It does not record rejections.** Declined updates changed nothing and leave nothing.
- **It does not record creation.** Nothing was revised.
- **It does not record confidence movement.** Trust is not a described value of the activity.
- **It does not store evidence.** The triggering observation lives elsewhere.
- **It does not know why a value changed.** It records that it did; causes come from evidence.
- **It does not group related changes.** Three aspects changing together produce three unlinked entries.
- **It does not support undo.** Reverting is a new revision.
- **It does not survive its Event.** Deleting the Event deletes the memory.
- **It does not currently record human decisions.** The most authoritative changes are the least recorded — a defect, not a boundary.

---

# Future Evolution

**Correctness**
- **Route manual confirmation through the recording path, and widen the recorded vocabulary to include the aspects humans edit.** Without both, the system's most authoritative changes remain invisible. This is the highest-value work in this part of the domain.
- **Enforce append-only structurally** rather than by convention — permissions or database-level constraints — so immutability survives a future contributor who has not read this page.
- **Record the source of a revision** (automated inference, human confirmation, document) so a reader can distinguish *the round moved* from *we changed our mind* from *I edited this myself*.

**Scalability**
- **Group entries by revision.** A shared identifier for aspects changed together restores fidelity lost to field-level granularity, cheaply.
- **Revisit unbounded growth** if entry volume ever becomes material. It is not today, since entries accrue only on real revisions.
- **Consider surviving deletion**, if regulatory or forensic requirements ever demand that memory outlive its subject.

**Product**
- **Give history a read path.** It is recorded and unreadable, so the capability exists and the feature does not. Until this ships, the domain's promise that an Event can explain itself is unmet.
- **Surface volatility.** An Event revised five times in two days is information the user should have; the data supports it and nothing exposes it.
- **Distinguish reschedules from corrections in the interface.** Both are date revisions; only one means the student's plans changed.

**Operational**
- **Detect missing history** — values that moved with no entry — which would have caught the manual-confirmation gap automatically.
- **Add a separate adjudication record** for rejected updates, answering *"why didn't it update?"* without weakening history's meaning.
- **Bound regression blast radius** by querying entries in a deployment window, which is the highest-leverage use of this data and needs only a query today.

---

# Interview Discussion

**Q: Why not just version the Event?**
Versioning fuses a mutable entity with an immutable record and makes the common read — current truth — pay for the rare one. It also gives the immutable thing the same lifecycle as the mutable thing, so immutability becomes a convention inside an entity built to be overwritten. Separating them lets each optimize for its own access pattern: one row read constantly, a sequence read rarely and only when something has gone wrong.

**Q: Why deltas rather than snapshots?**
The questions history answers are aspect-specific — *what was the venue?*, *when did the date move?* A snapshot buries that inside a diff the reader must compute, and stores mostly-redundant data since revisions typically touch one aspect. Deltas also stay readable as the Event's shape evolves. The cost is that point-in-time reconstruction requires replay and is incomplete — acceptable, because explanation is the use case and reconstruction is not.

**Q: Why is this not event sourcing?**
Authority is inverted. In event sourcing the log is the system of record and state is a disposable projection; here the Event is authoritative and history is descriptive. Delete all history and the system still works, losing explanation but not truth. Reconstruction here is conceptual, not operational — rejected updates are absent, the recorded vocabulary is narrower than the Event, and human confirmations write nothing, so replay could not reproduce the Event even in principle. It is a mutable aggregate with an audit trail, which fits a domain whose inputs are untrusted inferences rather than authoritative commands.

**Q: Why do rejected updates disappear?**
Because an entry's meaning is *this revision happened*. Admitting attempts would break the property that makes the record readable — a reader could no longer assume an entry means something changed — and since most observations are rejected or redundant, attempts would bury the signal. The gap it leaves is real: *"why didn't it update?"* is unanswerable today.

**Q: Would you ever record rejected updates?**
Yes, but not here. A persistently rejected correct value is invisible, and that is worth fixing — with a separate adjudication record capturing attempted, rejected, and why. Two records with clear meanings beat one with a muddy one. The moment rejections enter history, every consumer has to filter by "did this actually take effect," and someone eventually forgets to.

**Q: What breaks if the Event and its history are not written atomically?**
Both directions fail badly and differently. Values-without-history destroys the prior value with no trace and looks identical to a value that never changed — silent corruption of the audit trail. History-without-values makes the record claim something that never happened, so any reasoning from history becomes unsound. And a non-atomic audit trail is worse than none, because it is least reliable in exactly the crash-and-error circumstances it exists to explain.

**Q: How does this scale?**
Volume is not the concern: entries accrue only on real revisions, which are a small fraction of observations, and there are no readers to contend with. The scaling pressures are qualitative — field-level granularity loses the grouping of related changes, ordering is by acceptance rather than by real-world time, and there is no source attribution. All three become visible the moment history gets a UI, which is the event that will drive its next iteration.

**Q: How would data-protection requirements affect immutable history?**
This is the genuine tension in append-only design: an erasure obligation and a never-delete rule are in direct conflict. The workable answer is that immutability is a rule about *revising the record of decisions*, not a claim that personal data must live forever. History here stores changed values of activity attributes — company, round, time, venue — which are largely not personal data, so exposure is lower than in a typical audit log. Today the practical mechanism is the cascade: deleting an Event deletes its memory. If entries ever carry personal data — a human confirmer's identity, participant details — the design needs crypto-shredding or a separated store, decided before that data lands, not after.

**Q: What would you fix first?**
Manual confirmation writing no history. It is the inverse of a principled exclusion: a human decision is the most authoritative change the system can experience and the only one it forgets. It breaks the domain's own law, and it means the one revision a user would most want explained is the one that cannot be. Fixing it needs both routing confirmation through the recording path and widening the recorded vocabulary to the aspects humans actually edit.

---

# Confidence

**High** on structure and behaviour; **Medium** on one attribution; **explicitly qualified** where the implementation does not meet the documented law.

Derived directly from the source: entries are written inside the same transactional boundary as the values they describe; one entry per changed aspect; comparison runs against current belief so no-ops and silent aspects produce nothing; rejected updates return early and record nothing; creation records nothing; only date, time, and venue participate in comparison; a date change both records a revision and marks the relocation; values are stored as text with a literal marker for absence; entries are bound to their Event and removed with it. Verified by exhaustive search: there is **exactly one writer of history in the entire codebase**, inside the automated revision path, and **no reader anywhere**.

**The manual-confirmation gap is directly verified, not inferred.** The confirmation path updates the Event directly, outside the transactional boundary, and the single history writer is not on that path. Every statement in this document about that gap follows from those two facts.

**Medium confidence in attribution for immutability.** Nothing enforces append-only; the property holds because only one path writes and none modifies. Documented as a domain law because that is what it must be, and flagged as convention because that is what it currently is.

**Inferred rather than stated in code:** the reasoning attributed to past decisions — why deltas over snapshots, why rejections are excluded, why permanence has no expiry — reconstructs justification consistent with the implementation. It is sound engineering rationale for the design as it stands, not a transcript of the original discussion.

**Not covered by tests.** The revision path — the trust gate, field-level comparison, atomic recording, reschedule handling — has no direct test coverage. Its properties are guaranteed by reading, not by execution. Treat that as the operative caveat before changing any of it.
