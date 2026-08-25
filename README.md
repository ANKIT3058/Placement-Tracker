# Placement Tracker

Campus placement runs on email. A placement cell announces a round, moves it three days later, assigns a venue in a third message, and attaches the shortlist in a fourth — to a few hundred students, under time pressure, with no schema and no notification that anything changed. No single message contains the truth; the truth is the accumulation of them, and today every student performs that accumulation by hand across ten to thirty concurrent company processes.

Placement Tracker performs it instead. It connects to a mailbox once, reads placement announcements as they arrive, and maintains a single reconciled answer to *what is happening, and when* — recognising when a new message describes a round it already knows, updating it in place, recording what changed, and refusing to act when the evidence is too weak to trust.

---

## Why this project exists

The failure this solves is rarely "I never heard about it." It is almost always **"I heard about it, and I was working from the version that got superseded."**

That failure is not fixed by storing emails, because the problem is not access — it is reconciliation. Four properties of the input make ordinary CRUD insufficient:

- **Announcements are incremental.** Any single message is a fragment of a round's description.
- **Announcements are inconsistent.** The same company, round, and venue are written differently by different senders on different days. Deciding that two messages describe one real-world round is a judgement call, not a lookup.
- **Announcements are partial.** A venue correction names no date. A schedule names no company. *Absence of a field is not a statement about that field* — and a system that collapses that distinction erases good data on every partial message, which is most of them.
- **Announcements arrive out of order.** A correction may be processed before the announcement it corrects.

A CRUD system has one write behaviour: last write wins. That assumption holds when a human types a value. Here every write is an **inference of varying quality** — a date read from "Interview on 16 August 2026" and one read from "sometime next week" are not equally good, and treating them as equally good means the second silently destroys the first.

So this is not an email viewer, and not a parser with a database attached. It is an **event intelligence system**: the durable entity is the real-world placement round, messages are evidence, and every write is adjudicated. Its central design constraint is an asymmetry — a **duplicate** is visible, correctable, and embarrassing; a **false merge** (two distinct rounds collapsed into one record) is invisible, plausible, and destroys the information needed to undo it. Every threshold and every refusal in the recognition path is an expression of that preference.

> **Inbox = source of information · Event = source of truth · Confidence = permission to act**

---

## Core Capabilities

Everything listed here is implemented and exercised by the test suite.

**Gmail synchronization** — one-time OAuth grant (`gmail.readonly`, offline access), then unattended cursor-based sync on a background scheduler. Full-sync bootstrap captures the watermark *before* listing messages so nothing arriving mid-run is skipped; an expired `historyId` falls back to full sync automatically; overlapping runs are guarded; accounts sync sequentially so one failure never aborts the others.

**Intelligent event recognition** — three tiers of decreasing evidential strength, stopping at the first sufficient answer: exact identity key (company · round · date), bounded near-date matching, and sole-candidate matching within a 30-day window. Ambiguity produces no identity claim at all.

**Identity-gated matching** — a candidate whose round *contradicts* the observation is vetoed categorically before any similarity score is computed. Similarity ranks eligible candidates; it can never admit one. See [ADR-006](docs/06_ADR/ADR-006_Identity_Precedes_Similarity.md).

**Confidence-aware decisions** — every extraction carries a scalar derived from *how* the information was obtained, not what it says. It gates admission (act or escalate), protects incumbents (a weaker inference cannot overwrite a stronger belief), and contributes to ranking.

**Event updates and rescheduling** — updates are field-level and apply only to fields the observation actually spoke about. A changed date is treated as a distinct outcome: the event is marked rescheduled and its recognition key is regenerated so later messages find the moved round rather than the slot it vacated.

**History tracking** — every accepted change is written as an immutable `field / oldValue / newValue / timestamp` record, in the same database transaction as the change it describes.

**Human review** — observations below the acting threshold are parked for a person without disturbing anything already believed. A human confirmation sets values, raises confidence to certainty, and is **final**: automated inference may not revise a confirmed event, at any confidence.

**Attachment processing** — attachments are enqueued after their email is processed, downloaded to opaque storage keys, and parsed by a MIME-routed registry (PDF, spreadsheets). Download and parsing are separate failure domains: a parse failure records an error without reverting the download.

**Background processing** — two BullMQ queues (`email-processing`, `attachment-processing`) with dedicated worker processes, deterministic job IDs for idempotent enqueue, and exponential backoff retries.

**Replaceable extraction** — deterministic regex patterns and an optional LLM path merge field-wise. The model is off by default (`USE_AI=false`); when enabled, a provider failure degrades silently to patterns rather than failing the message. A shared AI core owns the provider interface, retry policy, JSON parsing, and typed errors.

---

## System Architecture

```
   Gmail ──OAuth──►┌──────────────┐        POST /email
                   │ Gmail Sync   │        (manual entry point)
                   │ scheduler    │               │
                   └──────┬───────┘               │
                          │  durable capture      │
                          ▼                       ▼
                   ┌──────────────────────────────────┐
                   │  email-processing queue (BullMQ) │
                   └──────────────┬───────────────────┘
                                  ▼
                   ┌──────────────────────────────────┐
                   │ INTERPRETATION                   │
                   │ regex + optional LLM → claims    │
                   │ confidence scoring               │
                   └──────────────┬───────────────────┘
                                  ▼
                   ┌──────────────────────────────────┐
                   │ VIABILITY GATE                   │  no company / no date
                   │                                  │──────► abandon
                   └──────────────┬───────────────────┘
                                  ▼
                   ┌──────────────────────────────────┐
                   │ RECOGNITION                      │  identity gate,
                   │ exact → near-date → sole         │  then ranking
                   └──────────────┬───────────────────┘
                                  ▼
                   ┌──────────────────────────────────┐
                   │ ADJUDICATION                     │  the only write point
                   │ create · update · reject · defer │
                   └──────┬───────────────────┬───────┘
                          ▼                   ▼
                   ┌─────────────┐     ┌─────────────┐
                   │ Event       │     │ Review      │──► human confirms
                   │ + History   │     │ queue       │    (authoritative)
                   └──────┬──────┘     └──────┬──────┘
                          └────────┬──────────┘
                                   ▼
                            React dashboard

   attachments ──► attachment-processing queue ──► download · parse · persist
```

Two properties worth noticing: **the pipeline has exactly one write point** — everything upstream proposes, only adjudication commits — and **every path either improves an event or leaves it untouched.** There is no path that degrades one.

---

## Tech Stack

| Layer | Choices |
|---|---|
| **Backend** | Node.js · TypeScript (strict, ESM/NodeNext) · Express 5 |
| **Database** | PostgreSQL 16 · Prisma 7 with `@prisma/adapter-pg` over a `pg` pool · 21 migrations |
| **Queue** | BullMQ over Redis (ioredis) · two queues · two dedicated worker processes |
| **AI** | OpenAI `gpt-4o-mini` at `temperature: 0`, behind a provider interface with retry policy and typed errors. Optional — the system runs on deterministic patterns alone |
| **Ingestion** | Google APIs (`gmail.readonly`), OAuth 2.0 with offline access and refresh tokens |
| **Documents** | `pdf-parse` · `exceljs`, routed by a MIME-type parser registry |
| **Frontend** | React 19 · Vite 8 · TypeScript · hand-written CSS |
| **Testing** | Jest 30 · ts-jest · supertest — 38 suites, 620 tests, dependency-mocked (no database or Redis required) |
| **Infrastructure** | Docker Compose (PostgreSQL); Redis provisioned separately |
| **Authentication** | Google OAuth sign-in (PKCE + state), server-side sessions, double-submit CSRF on writes. Separately, a Google OAuth grant per connected mailbox (`gmail.readonly`) |
| **Multi-tenancy** | Every record carries its owner. Each user's Events, emails, attachments and mailboxes are isolated to their account, enforced at the persistence boundary rather than by callers remembering to filter |

---

## Engineering Highlights

Interesting decisions, not features.

**Identity precedes similarity.** The original matcher summed weighted signals — date proximity, round agreement, confidence alignment — and accepted above a threshold. The date term alone was worth exactly the threshold, so *same company, same date, different round* was accepted: a morning pre-placement talk and an afternoon assessment merged into one record. The defect was representational, not a mis-tuned constant. **A weighted sum of non-negative corroboration cannot encode a veto** — a contradicted attribute contributed `0`, which means *no support*, and the engine had no way to express *evidence against*. Recognition is now two phases with strictly separated authority: categorical admission (`AGREES` / `UNKNOWN` / `CONTRADICTS`), then continuous ranking over the survivors. A constraint is a rule; a threshold is a coincidence a future retune silently removes.

**Contradiction is not silence.** The domain already forbade collapsing *silence* into *denial* on the update path — a message omitting a venue says nothing about it. The old scorer committed the inverse collapse on the identity path, encoding both "different round" and "no round stated" as zero. Both directions are now explicit, including a sentinel for unresolved attributes that never compares equal to itself.

**Highest trust wins, not last write.** Recency is a poor proxy for correctness when every write is an inference. A weaker observation does not get to degrade a stronger record merely by arriving later — which also buys order-independence for free, since a weak late arrival is rejected on its merits rather than because of when it arrived.

**Human authority is categorical, not numeric.** Manual confirmation sets confidence to `1.0` — and so does a maximally confident extraction, so the incumbent comparator cannot tell "a person settled this" from "the extractor was very sure." The guard is therefore on *status*, not on the confidence comparison. Authority is a kind, not a quantity.

**Failure is biased toward the recoverable direction — structurally.** Every mechanism in the recognition path fails toward a visible duplicate rather than a silent merge, and does so by construction rather than by arithmetic: bounded windows, a uniqueness requirement at the weakest tier, a trust gate that runs before anything existing can be touched, and field-level writes that cannot collaterally blank an unrelated field.

**History is written atomically with the change it records.** An event whose values moved without a corresponding record would be an event that cannot explain itself — a state the domain does not permit.

**Failure domains are separated end to end.** A failure in one message does not affect others; a failure in interpretation cannot corrupt existing belief; a parse failure does not revert a successful download; a failure anywhere in processing does not stop ingestion. The worst outcome of most failures is *staleness*, which is visible and recoverable, rather than *corruption*, which is neither.

**ADR-driven development with an architecture conformance process.** Architectural decisions are recorded as ADRs; the work that brings the implementation in line with them is tracked separately as Architecture Conformance issues (`AC-n`), each shipping with regression tests that assert the invariant *cannot* be violated — including assertions on absence, since an assertion on the outcome alone cannot distinguish "correctly refused" from "considered and happened to lose."

**The specification documents its own gaps.** Every handbook document carries a Confidence section separating what was verified from what was inferred, and known divergences are catalogued as `D-n` (implementation contradicts intent) or `G-n` (intent not yet built) rather than quietly rewritten to match the code. The defect that motivated ADR-006 was found by writing the specification, not by a failing test.

---

## Repository Structure

```
Placement-Tracker/
├── docs/          Engineering Handbook — start at docs/README.md
├── backend/       Node + Express + TypeScript API, workers, Prisma schema
│   └── src/modules/   gmail · email · extraction · matching · event
│                      attachment · document-intelligence · ai
├── client/        React + Vite dashboard
└── CONTRIBUTING.md    how engineering work is done here
```

Three packages, installed and run independently — there is no workspace root.

---

## Engineering Handbook

The repository carries a written specification, not just code. It is the internal document the implementation is expected to conform to, and where the *why* behind every threshold lives.

- **Product Vision** — what the system is for, what it refuses to own, and the failure-preference ordering used as a tie-breaker
- **Domain Model** — `Event.md` and `EventUpdate.md`, both canonical: what individuates a placement activity, why the recognition key is not the identity, and how belief is allowed to change
- **Backend Handbook** — the reasoning layer, the exhaustive recognition decision matrix, and the Gmail ingestion boundary
- **Development Guide** — the setup contract, verified against the working tree
- **ADRs** — decisions that are settled, with the alternatives rejected and why

Start at **[docs/README.md](docs/README.md)**, which states the reading order.
Contributing? Read **[CONTRIBUTING.md](CONTRIBUTING.md)** first.

---

## Getting Started

```bash
git clone <repository-url>
cd Placement-Tracker

# install (no workspace root — each package independently)
cd backend && npm install
cd ../client && npm install

# infrastructure
cd ../backend
docker compose up -d                                  # PostgreSQL on :5435
docker run -d --name placement-redis -p 6379:6379 redis:7   # not in compose

# configure
cp .env.example .env        # then edit; client/.env needs VITE_API_URL

# database (the generated Prisma client is gitignored — this is required)
npx prisma generate
npx prisma migrate dev
```

Then run four processes, each in its own terminal:

```bash
npm run dev               # backend/  API + Gmail scheduler
npm run worker:email      # backend/  email-processing worker
npm run worker:attachment # backend/  attachment-processing worker
npm run dev               # client/   dashboard on :5173
```

Verify with `GET http://localhost:3000/health`. Tests run with `npm test` from `backend/` and need neither database nor Redis.

Without a mailbox connected, `POST /email` accepts a pasted email body and exercises the full pipeline — the faster loop when working on extraction or matching. To connect a mailbox, visit `GET /gmail/auth` with the backend running.

> **On Windows, the Visual C++ 2015–2022 Redistributable (x64) is a hard prerequisite for the test suite.** Without it Jest 30's native resolver cannot load and reports a misleading "transform module not found" error.

Full setup contract — every environment variable, the `DATABASE_URL` resolution model, platform notes, and troubleshooting — is in **[docs/03_Development/Development_Environment.md](docs/03_Development/Development_Environment.md)**.

---

## Current Status

Multi-user and owner-scoped, and correct on the paths the handbook specifies. Each user signs in with Google and sees only their own placement Events.

- ✅ **Project Foundation** — event model, extraction, confidence scoring, matching, review queue, React dashboard
- ✅ **Gmail Ingestion** — OAuth, incremental cursor sync, scheduler, idempotent capture, attachment download and parsing
- ✅ **Engineering Handbook** — product vision, canonical domain model, backend reasoning documentation, recognition decision matrix, development contract
- ✅ **Architecture Conformance (Phase 2)** — AC-1 bounded the weakest recognition tier in time; AC-2 implemented ADR-006's identity gate; AC-3 made human confirmation authoritative over inference; AC-4 stopped placeholder companies from becoming matchable events. Each shipped with regression tests
- ✅ **Authentication & Multi-user Foundation (Phase 3)** — Google sign-in, ownership on the Event, and tenant isolation enforced at the persistence boundary. Deliberately deferred until the reconciliation problem was solved, then delivered as AC-5 under [RFC-001](docs/rfcs/RFC-001-authentication-multi-user-foundation.md). The Event's recognition key became unique per owner rather than globally, so two students receiving the same placement broadcast each keep their own Event
- ⬜ **Frontend Evolution** — surface change history, confidence and doubt, and attachment understanding, none of which currently have a user-facing expression
- ⬜ **Production Readiness** — CI, retained sync and adjudication statistics, recognition-quality measurement, credential revocation as a visible account state

---

## Future Work

Realistic next phases, in roughly the order they matter.

**Wire document intelligence into adjudication.** The classifier and the event/participant extractors are built and tested but invoked from no path — attachment processing currently terminates at parse and persist. This is the largest built-but-unused capability in the system, and the boundary is already drawn to accept it.

**Eliminate the ingestion drop path.** A message that fails during sync is logged and dropped, with nothing durable recording that it existed. It is the one place the system's failure preference is violated: the outcome is *absent* with no signal.

**Make the system observable.** Its central risk — a false merge — currently emits no error, no flag, and no anomaly. Recognition decisions now carry their basis (tier, attribute relation, candidate count, score); retaining and measuring them is what converts an invisible failure into a visible one.

**Surface change history.** It is recorded faithfully and read by nobody. Until it has a surface, the one mechanism designed to explain a wrong answer cannot be used by the person who needs it.

**Calibrate the acting threshold** against real review outcomes rather than intuition — which requires recording those outcomes first.

---

## Design Philosophy

- **Architecture before implementation.** The handbook is the specification; the code conforms to it. When they disagree, that is a defect or an acknowledged gap — never a licence to rewrite the specification to match what shipped.
- **Deterministic reasoning wherever possible.** The model is one replaceable input. The reasoning is not, and the system runs without it.
- **Human decisions override automated inference.** Otherwise review is theatre and the user learns to distrust the system.
- **Uncertainty is represented, never resolved by guessing.** "I don't know" stays expressible end to end; ambiguity terminates in a refusal or a human, never in a selection.
- **Express rules structurally, not numerically.** A constraint is a rule; a threshold is a coincidence that a later retune undoes without anyone noticing.
- **Bias toward the recoverable failure.** A duplicate is visible and fixable in seconds. A false merge destroys the information needed to fix it.
- **Small, verifiable architectural changes.** One decision per ADR, one conformance issue per correction, regression tests that assert the invariant cannot be violated.
- **Gaps are documented, not hidden.** A specification describing only the parts that work is worth nothing at the moment it is needed.

---

**Ankit Kumar Anand** · B.Tech CSE · Backend & Systems
