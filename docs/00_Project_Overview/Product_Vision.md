# Product Vision

Engineering Handbook — Project Overview
Audience: engineers, and anyone (human or otherwise) making design decisions in this repository

---

# Executive Summary

**Purpose**

Placement Tracker converts the stream of placement announcements arriving in a student's mailbox into a single, current, machine-readable answer to the question "what is happening, and when?". The announcements are written by humans for humans, arrive incrementally, contradict each other over time, and carry a large part of their payload in attachments. No individual message contains the truth; the truth is the accumulation of them, and today every student performs that accumulation manually and privately. The system performs it instead, and — because it is inferring rather than being told — it also tracks how much it trusts each conclusion it reaches.

**Core Idea**

Treat the inbox as an unreliable, incremental feed of claims about the world, and maintain a reconciled model of what is currently true, with the system's own uncertainty represented as data rather than hidden.

**Primary Invariant**

Information the system trusts less never overwrites information it trusts more.

**Primary Failure Mode**

A confidently wrong answer — a superseded date or misattributed round that the user acts on without re-checking — which is worse than showing nothing at all.

---

# Problem Statement

Campus placement runs on email. A placement cell announces which company is visiting, which round is happening, when and where, who is shortlisted, and what changed since yesterday, by mailing a few hundred students. These messages are written under time pressure by people whose job is not data entry.

The result has four properties that make manual tracking fail:

**Announcements are incremental.** The first message announces a round. A second moves it. A third assigns a venue. A fourth attaches the shortlist. Any single message is a fragment.

**Announcements are inconsistent.** The same company, round, or venue is written differently by different senders on different days. Recognising that two messages refer to the same real-world event is a judgement call, not a lookup.

**Announcements are partial.** A venue correction names no date. A schedule names no company. Absence of a field is not a statement about that field.

**Announcements carry structure in attachments.** Shortlists, seating plans, and schedules arrive as files, where the information is least accessible and most consequential.

The student is expected to integrate all of this by hand, across ten to thirty concurrent company processes. The failure mode this produces is specific. It is rarely "I never heard about it." It is almost always **"I heard about it, and I was working from the version that got superseded."** Missed slots, duplicate entries for one round, and stale venues are all the same underlying gap: nobody maintains a reconciled view of current truth.

Placement portals exist and students still miss rounds. That observation is the premise of this project, and it locates the gap precisely: announcements are published in a channel built for human attention, while acting on them reliably requires a machine-readable model of state. Nobody bridges the two, so every student bridges it privately, badly, and repeatedly.

---

# Product Thesis

This product exists because the information a student needs is already published, but only in a form that requires a human to integrate it. Email is the source of information because it is where announcements actually arrive, and — critically — because building on the receiving side is the only approach that requires no cooperation from the sender; any design that depends on the placement cell adopting a format or a tool is a design that never ships. The Event is the source of truth because a placement round is a single real-world thing that many messages describe partially and revise over time; modelling messages alone leaves the reader to reconcile them, which is exactly the work we are removing. Uncertainty is first-class because the system is *inferring* rather than being *told*: an inference without an attached degree of trust cannot be safely acted on, cannot be safely overwritten, and cannot be safely escalated to a human. Confidence is therefore not a quality metric or a debugging aid — it is the input to every decision the system makes about whether to act automatically, hold back, or ask. A system that hides its uncertainty is forced to guess; a system that represents it can decline to.

> **Inbox = Source of Information**
> **Event = Source of Truth**
> **Confidence = Permission to Act**

Architecture philosophy: **acquisition, interpretation, and belief are separate concerns, and uncertainty flows between them as data rather than being resolved at the boundary.**

---

# One product, many independent students

Placement Tracker is account-based. A student signs in with Google, connects their own mailbox, and gets **their own event universe** — their Events, their review queue, their history. Nothing they hold is shared with, visible to, or revisable by another user.

The consequence worth stating at product level, because it looks like a bug and is not:

**The same real-world placement opportunity appears independently for every student who hears about it.** A placement cell announces one round to three hundred students; each of those students who uses the product forms their own belief about it, from their own inbox, at their own confidence. Three hundred Event records describing one round is the correct outcome, not duplication — the product's unit is *one student's* answer to "what is happening, and when", and two students' answers must be able to differ. One may confirm a venue by hand that the other never received.

This also sets a boundary the product will not cross without a separate decision: there is no cross-student view, no shared canonical event, and no aggregation across users. Each student's timeline is derived from what *they* were told, which is the only thing the product can honestly claim to know.

---

# Responsibilities

## What the product owns

- **The reconciled event timeline.** The current answer to "what is happening and when," maintained across an arbitrary number of partial, contradictory messages.
- **Identity resolution.** Deciding that a new message describes an event already known, rather than a new one. This is the capability that separates a timeline from a pile of near-duplicates.
- **Trust.** Quantifying how much each conclusion should be relied on, and using that to gate every write.
- **The uncertainty escalation path.** A defined queue and workflow for interpretations the system will not act on alone.
- **Provenance.** A record of what changed on an event and when, so any current value can be explained after the fact.

## What the product does not own

- **The placement process itself.** Applications, eligibility, offers, and institutional records live in the placement portal. This system reads what that process broadcasts; it does not administer it.
- **The announcement channel.** We do not control message format, cadence, or content, and we never ask the sender to change. This constraint is deliberate and defines the product's shape.
- **Ground truth.** The mailbox is authoritative, not us. When we disagree with the mailbox, we are wrong.
- **Institutional adoption.** The product delivers value to a single student with a single mailbox and no cooperation from anyone else. That is a statement about the *unit of value*, not about capacity: the product serves many students, each independently, and no student's use depends on any other's.

---

# Workflow

Three workflows. The first is the product; the others exist to support it.

```
  ┌──────────────────────────────────────────────────────┐
  │  A. INGESTION — unattended, continuous, default path │
  └──────────────────────────────────────────────────────┘

     mailbox connected once
              │
              ▼
     ┌──────────────────┐
     │ announcements    │  arrive on their own schedule
     └────────┬─────────┘
              ▼
  ┌──────────────────────────────────────────────────────┐
  │  B. INTERPRETATION AND RECONCILIATION                 │
  └──────────────────────────────────────────────────────┘

     what does this message mean?
              │
              ▼
     what does it mean RELATIVE TO WHAT WE ALREADY BELIEVE?
              │
     ┌────────┼─────────────────┬──────────────────┐
     ▼        ▼                 ▼                  ▼
  new      known event      known event        not confident
  event    + new facts      + weaker facts       enough
     │        │                 │                  │
     ▼        ▼                 ▼                  ▼
  create   update in place   decline to        defer to
           (+ record what    overwrite         human review
            changed)         (protect trust)   (leave existing
                                                data untouched)
              │
              ▼
  ┌──────────────────────────────────────────────────────┐
  │  C. REVIEW — human adjudication of uncertainty        │
  └──────────────────────────────────────────────────────┘

     student confirms or corrects
              │
              ▼
     human decision becomes authoritative
     (outranks all subsequent machine inference)
```

**Workflow A is the product's promise.** The student does nothing. Every feature that requires the user to remember to take an action is a partial retreat from it. A manual submission path exists for forwarded or one-off mail; treat it as a supporting entry point, not the main way the product is used.

**Workflow B is where the value is.** Recognising that "Technical Interview, 14th, moved to LT-3" refers to the same real-world event as last week's "Tech round on the 14th" is the difference between a timeline and a growing pile of near-duplicates.

**Workflow C is designed behaviour, not an error path.** Review is what allows the automated path to be aggressive elsewhere without risking the user's trust.

---

# State

The product's durable state is **belief about the world**, held in three parts:

**The event timeline** — the current reconciled answer for each known placement round, and the product's central artifact. Everything else exists to produce or explain it.

**Trust attached to each belief** — every event carries how much its content should be relied on. This is not metadata; it is what determines whether the next message may modify it.

**Change history** — what changed on an event, from what, to what, and when. This exists so the question "why does it say this?" always has an answer. It is recorded faithfully today and not yet shown to users.

All three are held **per user**. Every piece of durable state above belongs to exactly one account and is read, written and reasoned about within that account's boundary.

Two supporting pieces of state matter architecturally: the **mailbox connection**, which is what makes unattended operation possible, and the **ingested message record**, which is what makes ingestion idempotent. Both are likewise per user.

---

# State Machine

An event's status is the product's one meaningful state machine. It encodes how much human and machine agreement stands behind the current values.

```
                  first message about an event
                            │
              ┌─────────────┴──────────────┐
              │                            │
      confident enough              not confident enough
              │                            │
              ▼                            ▼
      ┌───────────────┐            ┌───────────────┐
      │   SCHEDULED   │            │    REVIEW     │
      └───────┬───────┘            └───────┬───────┘
              │                            │
   later message moves the date    human confirms/corrects
              │                            │
              ▼                            │
      ┌───────────────┐                    │
      │  RESCHEDULED  │                    │
      └───────┬───────┘                    │
              │                            │
              └────────► ┌──────────────┐ ◄┘
   human confirms        │  CONFIRMED   │
                         └──────────────┘
                     terminal for automation:
                  human decision is authoritative
```

Two properties are worth stating explicitly. **REVIEW is an entry state, not a degraded one** — an uncertain interpretation is parked there without disturbing anything already believed. **CONFIRMED is terminal with respect to inference** — once a human has adjudicated, later machine conclusions do not silently override them.

---

# Core Algorithm

At product level the system runs one loop: *interpret, reconcile, decide.*

**Interpret.** Turn an unstructured message into a set of claims about an event, and attach a degree of trust to those claims. Trust is derived from how the information was obtained — an explicitly stated date is worth more than one inferred from "next Tuesday"; a stated venue is worth more than one guessed from context.

**Reconcile.** Determine whether these claims concern an event already known. This is identity resolution over inconsistent human-written text, so it cannot be an exact-match lookup. It is a scored judgement, and it is deliberately biased: failing to match produces a visible duplicate, while matching incorrectly corrupts a good record silently. The first failure is recoverable, the second is not.

**Decide.** Compare the trust of the incoming claims against the trust of what is already believed:

- Nothing matched, and trust is sufficient → this is a new event.
- Something matched, and incoming trust is at least as high → update in place, and record what changed.
- Something matched, but incoming trust is lower → decline the update. A weaker claim does not get to degrade a stronger one merely by being newer.
- Trust is below the acting threshold → do not touch existing belief; route to human review with the reason.

The reasoning behind the third branch is the part most engineers find counter-intuitive. Most systems are last-write-wins. This one is **highest-trust-wins**, because for this user, silently degrading a known-good record is worse than declining to update it.

One further distinction runs through the whole algorithm: **silence and denial are different statements.** A message that says nothing about a venue is not a message saying the venue is unknown. The first must leave existing information alone; the second must clear it. Pipelines that collapse this distinction quietly destroy good data.

---

# Engineering Decisions

### Build on the receiving side, not the sending side

**Decision** — Read the student's mailbox rather than integrating with the placement cell.
**Reason** — The receiving side is the only side we control. A solution requiring the sender to adopt a format or tool has an adoption dependency it cannot satisfy, and delivers nothing until that dependency is met.
**Trade-offs** — We inherit maximum input entropy: no schema, no guarantees, no notification of change. Every hard problem in this system (extraction, identity resolution, confidence) is a direct consequence of this decision. We accept them because the alternative is a product that never launches.

### Model the Event, not the message

**Decision** — The durable unit is the real-world placement round, not the email that described it.
**Reason** — Messages are fragments and revisions of a thing. Storing messages alone leaves reconciliation to the reader, which is precisely the work we exist to remove.
**Trade-offs** — Requires identity resolution, which is the hardest correctness problem in the system and the source of its worst failure (a wrong match corrupts a good record). Messages are retained alongside events so a bad reconciliation remains diagnosable.

### Make confidence a first-class input to control flow

**Decision** — Every inference carries a degree of trust, and that value gates writes, escalation, and display.
**Reason** — A system that infers must be able to represent not knowing. Without it, there are only two possible behaviours — act on everything or act on nothing — and both are wrong.
**Trade-offs** — Adds a threshold that must be tuned, and a tuning error is quiet in both directions: too high floods the review queue and erodes the "user does nothing" promise; too low lets bad data through automatically. This is the system's most sensitive parameter.

### Treat human review as designed behaviour

**Decision** — Uncertainty routes to a human queue with a stated reason; the human's answer becomes authoritative.
**Reason** — The student is the only party who can resolve genuine ambiguity, and they are already in the loop. Making that explicit lets the automated path be aggressive elsewhere without risking trust.
**Trade-offs** — Every item in the queue is a partial failure of automation and a direct cost to the user. Queue volume is the honest measure of extraction quality.

### Protect trusted data from untrusted data

**Decision** — Highest-trust-wins, not last-write-wins.
**Reason** — For this user, a silently corrupted good record is worse than a missed update: they will act on it without re-checking.
**Trade-offs** — A genuinely correct low-confidence correction can be rejected. Accepted knowingly — the failure ordering below prefers stale-but-flagged over confidently-wrong.

### Retain change history

**Decision** — Record what changed on an event, from what, to what, and when.
**Reason** — Placement information is a claim revised over time. A system that stores only current values cannot explain itself when it is wrong, and an unexplainable system is one users stop trusting after the first error.
**Trade-offs** — Storage and write cost on every update, for data that currently has no user-facing surface. Deliberate: the record must exist before the feature that reads it, since history cannot be reconstructed retroactively.

### ~~Defer multi-user support~~ — **superseded; multi-user is implemented**

*Kept as a record of a decision that was made, honoured, and then discharged. The sequencing it argues for is the reason the product has the shape it does.*

**Decision** *(then)* — One student, one mailbox, no accounts or identity model.
**Reason** *(then)* — The full product thesis is testable with a single user. Introducing identity and ownership before the reconciliation problem is solved would spend the project's hardest effort on the least uncertain part.
**Trade-offs** *(then)* — Multi-tenancy is not retrofittable cheaply — it touches ownership, authorization, and isolation everywhere. This is real, accepted debt, not an oversight. Any work assuming multiple users needs a product decision first.

**Superseded by** — user accounts, ownership on every record, and tenant isolation, specified in RFC-001 and delivered as AC-5. The trade-off above was accurate: the retrofit did touch ownership, authorization and isolation everywhere, and it was paid deliberately once the reconciliation problem it was deferred behind had been solved.

**Current model** — the product is account-based. A user signs in with Google, and every record they produce carries their identity. See *One product, many independent students* above.

---

# Invariants

**Trusted information is never overwritten by less-trusted information.** The user acts on this data without verifying it; a silent downgrade is the most expensive thing the system can do.

**Silence is not denial.** A message that omits a field says nothing about that field. Collapsing this distinction destroys good data on every partial message — which is most of them.

**A human decision outranks subsequent machine inference.** Otherwise review is pointless: the user would correct the same field repeatedly and stop trusting the system.

**Every current value is explainable.** Any field must be traceable to what changed it and when, because an unexplainable wrong answer is unrecoverable trust damage.

**No sender cooperation is required.** The moment a feature depends on the placement cell behaving differently, it is outside the thesis and the product stops working for its actual user.

**Uncertainty is always represented, never resolved by guessing.** "I don't know" must remain expressible end to end; a pipeline stage that silently picks a value destroys information every downstream stage needs.

---

# Failure Handling

**Failure preference, in order:**

```
   correct  >  flagged as uncertain  >  absent  >  confidently wrong
```

This ordering is the tie-breaker whenever a trade-off has no other guidance. It is asymmetric on purpose: a blank field sends the user to their mail, an uncertain flag sends them to review, but a confidently wrong date makes them miss a round with no signal that anything was wrong.

**Failure boundaries.** A failure in one message must not affect other messages; a failure in interpretation must not corrupt existing belief; a failure anywhere in processing must not stop ingestion. The system is built so that the worst outcome of most failures is *staleness*, which is visible and recoverable, rather than *corruption*, which is neither.

**Recovery.** Ingestion is idempotent per message, so re-running is safe and is the standard response to most anomalies. Belief is rebuildable from retained messages. Human corrections are authoritative and survive later inference.

**The known gap.** A message that fails during ingestion is currently dropped rather than retried, and nothing durable records that it existed. This is the one place where the failure preference above is violated — the outcome is *absent* with no signal. It is documented in the Gmail Synchronization handbook and is the highest-value correctness work outstanding.

---

# Consistency Guarantees

**Eventual consistency with the mailbox, bounded by the poll interval.** The system converges to the mailbox's state within roughly one polling period plus processing time. There is no real-time guarantee; anything built on top must tolerate a message being visible in Gmail before it is visible here.

**The mailbox is authoritative.** Local state is a derived view. Divergence is always our error.

**Ordering is not guaranteed.** Messages may be interpreted out of order. This is safe only because reconciliation is trust-aware rather than last-write-wins — under a naive model, out-of-order delivery would silently corrupt records.

**Idempotency at the ingestion boundary.** A given message produces at most one ingested record no matter how many times it is offered, which is what makes re-running safe.

**Consistency boundary: one event.** Reconciliation reasons about a single event at a time. There is no cross-event or cross-company transaction, and no globally consistent snapshot.

**Human decisions are durable.** A confirmation is not subject to later automatic revision.

---

# Related Components

Dependency direction is one-way, and preserving it is what keeps the boundaries meaningful:

```
  Ingestion  ──►  Interpretation  ──►  Reconciliation  ──►  Event + History
  (mailbox)       (extraction,          (identity            (belief,
                   confidence)           resolution)          provenance)
                                                                  │
                                                                  ▼
                                                          Review (human)
                                                                  │
                                                                  ▼
                                                          Presentation
```

- **Ingestion** knows nothing about events, confidence, or matching. Its job ends when a message is durably captured and queued. See `docs/02_Backend/Gmail_Synchronization.md`.
- **Interpretation** turns text and documents into claims plus trust. It has no knowledge of existing belief.
- **Reconciliation** is the only component permitted to decide that two descriptions are the same event.
- **Event and History** own belief and its provenance. Nothing upstream may write to them directly.
- **Review** is the only path by which a human overrides inference.
- **Presentation** is a pure consumer. Nothing depends on it, which is why it can lag the platform without blocking anything.

---

# Things This Product Does NOT Do

- **It is not a placement portal.** It holds no applications, eligibility rules, offers, or institutional records. It sits downstream of whatever system does.
- **It does not administer the placement process.** It observes and reconciles; it never becomes the mechanism by which the process runs.
- **It does not ask the sender to change.** No format, no template, no admin panel, no cooperation.
- **It does not decide what a message means at the boundary.** Ingestion captures; interpretation decides. Collapsing these would couple mailbox availability to AI availability.
- **It does not resolve ambiguity without a human.** When trust is insufficient, it escalates rather than guessing.
- **It does not model the student beyond the account.** A user is an authenticated identity that owns records. The product holds no course, branch, CGPA, eligibility, or placement-cell profile — those belong to the placement portal it deliberately sits downstream of.
- **It does not require a registration number.** A student's college registration number is not a user identity and is not a prerequisite for using the product. Off-campus opportunities — which a student pursues without the placement cell involved at all — have no registration number attached, and the product must remain fully usable for them. Where it becomes relevant is on-campus: a registration number identifies a student *to their institution*, so it is the kind of detail that matters for eligibility or participation in an on-campus process. That makes it optional, opportunity-specific information — never the thing that says who a user is or which Events are theirs. Ownership is the account; nothing else.
- **It does not notify.** It knows when things change and currently has no way to tell anyone; the user must come and look.
- **It does not attempt to be authoritative over the mailbox.** When the two disagree, the mailbox wins.

---

# Future Evolution

**Correctness**
- Eliminate the ingestion drop path so a failed message is retried or recorded rather than lost.
- Surface change history to users. It is recorded but invisible, so the system cannot currently explain itself to the person who needs it most.
- Calibrate the confidence threshold against real review-queue outcomes instead of intuition.

**Scalability**
- ~~Multi-user support: identity, ownership, isolation.~~ **Delivered** (RFC-001 / AC-5). Accounts, ownership on every record, and tenant isolation are implemented; it is no longer outstanding work.
- Reduce interpretation cost per message via server-side filtering, so volume growth does not translate directly into AI spend.

**Product**
- Surface attachment understanding. The platform already classifies shortlists, seating plans, schedules, and job descriptions and extracts both event facts and participant information from them, with no user-facing expression. This is the largest available value in the system today.
- Answer participant-level questions ("am I on this shortlist, and where do I sit?"), which is what the participant extraction was built for.
- Notifications, so the system can tell the user something changed instead of waiting to be visited.

**Operational**
- Retain and expose sync and processing statistics, so "when did we last sync and what happened" is answerable without reading logs.
- Make credential revocation a visible account state rather than a recurring silent failure.

---

# Interview Discussion

**Q: Why not just use the placement portal's data?**
The portal holds what was entered, not what is currently true for a given student. Announcements and revisions travel by email; the portal is not updated in real time and is not addressable programmatically by a student. Building on the receiving side also removes the adoption dependency — the product works for one student with zero institutional cooperation.

**Q: Why is confidence part of the domain model rather than a logging or quality metric?**
Because it determines control flow. It decides whether a write is applied, rejected, or escalated to a human. A system that infers must be able to represent not knowing; without that, its only options are to act on everything or act on nothing.

**Q: Highest-trust-wins instead of last-write-wins — isn't that surprising for a data pipeline?**
Yes, deliberately. Last-write-wins assumes writes are authoritative. Ours are inferences of varying quality, so recency is a poor proxy for correctness. Given a user who acts on this data without verifying it, silently degrading a good record costs more than declining an update. The cost of the trade is that a correct low-confidence correction can be rejected — which the review queue exists to catch.

**Q: What's the hardest correctness problem here?**
Identity resolution — deciding that a new message describes an event already known, over inconsistent human-written text. Its failure modes are asymmetric: a missed match produces a visible duplicate the user can spot; a false match silently corrupts a good record. That asymmetry, not accuracy in aggregate, is what the matching design optimizes for.

**Q: Why treat "no venue mentioned" differently from "venue is unknown"?**
Because most messages are partial. If absence is read as a negative assertion, every partial message erases good data — a venue correction with no date would wipe the date. Distinguishing silence from denial is what makes incremental accumulation safe, and it is the single most common place pipelines lose data quietly.

**Q: What breaks first if usage grows?**
Not throughput, and no longer the data model — ownership and isolation are implemented, so an additional user is an ordinary account rather than an architecture change. What remains is per-message AI cost, which scales linearly with mailbox volume and is the reason server-side filtering sits on the roadmap. Ingestion also assumes a single running instance for its concurrency guard, so horizontal scaling requires distributed coordination before it is safe.

**Q: How would you know the system is wrong?**
Today, incompletely. Change history is recorded but not surfaced, and sync statistics are logged but not retained. You can reconstruct what happened from logs; you cannot ask the system. That is the main observability gap and the reason it is listed under operational evolution.

---

# Confidence

**High.**

Statements about system behaviour — the status machine, the trust-gated update rule, the silence-versus-denial distinction, the review path, change-history retention, the account-based ownership model and its per-owner Event uniqueness, and the attachment-understanding capability — are derived directly from the source, including the Gmail, email, extraction, matching, event, and document-intelligence modules, the data model, and the client.

Statements about **users and their priorities** — student workload, the "superseded version" failure mode, the failure-preference ordering — are inferred from the system's design choices and the repository's own documentation. They are consistent with the code but are not independently validated by user research. Treat them as the product's operating hypothesis, and revise them if evidence contradicts them.

The gap between platform capability and user-facing surface (attachment understanding, change history) is stated from direct reading of both sides and is current as of this document's writing.
