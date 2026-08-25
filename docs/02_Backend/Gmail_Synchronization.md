# Gmail Synchronization

Engineering Handbook — Backend
Audience: engineers working on or around the ingestion path

---

# Executive Summary

**Purpose**

Gmail Synchronization is the ingestion boundary of the system. It answers one question repeatedly and without supervision: which messages have appeared in a connected mailbox that we have not yet ingested, and how does each get into the system exactly once? It converts a remote, mutable, rate-limited mailbox we do not control into a local, append-only stream of persisted messages and queued work. It performs no interpretation — it captures, de-duplicates, persists, and hands off.

**Core Idea**

Maintain a durable per-mailbox cursor so each cycle does work proportional to what changed rather than to mailbox size, and make ingestion idempotent so that re-reading is always safe and gaps never are.

**Primary Invariant**

At most one stored message exists per Gmail message id, enforced by a uniqueness constraint rather than by application logic alone.

**Primary Failure Mode**

A message that throws during a cycle is skipped while the cursor still advances past it, so the change feed never offers it again and the message is silently lost.

---

# Problem Statement

Synchronizing against a mailbox is harder than it appears. Five properties of the problem drive every decision in this subsystem.

**The source is remote, large, and not ours.** We cannot subscribe to a database. We poll a third-party API with quotas, against a mailbox that may hold years of mail. Re-reading everything each cycle is work proportional to mailbox size, forever — untenable on cost, latency, and quota.

**The delta mechanism can expire underneath us.** Gmail offers a change feed keyed by a history cursor, which is what makes incremental sync possible. That cursor has bounded server-side retention. After an outage, a crash, or a long deploy gap, the cursor we hold becomes meaningless and the API rejects it. The delta mechanism can therefore never be the only strategy.

**Reading and storing are not one atomic act.** Fetching a message and committing it locally are separate operations across a network boundary, with no distributed transaction available. A crash between them is always possible, so the subsystem cannot rely on "we read it, therefore we stored it." Everything must be safe to re-read.

**Duplicates are expensive far from where they are created.** A message ingested twice runs extraction twice (paid AI calls), enters reconciliation twice, and risks producing a second event for one real-world round — the exact failure the product exists to prevent. The cost lands downstream, so suppression must happen at the boundary.

**Nobody is watching.** This runs unattended on a timer. One malformed message must not abort a cycle, one broken mailbox must not stop others, and one failed cycle must not kill the scheduler. Every failure needs a bounded blast radius because there is no operator to restart anything.

---

# Responsibilities

## Owns

- **Change detection.** Determining what is new in a mailbox since the last successful cycle.
- **The cursor.** The durable per-mailbox watermark, its advancement, and its recovery when rejected.
- **Message capture.** Reducing a message to sender, subject, body text, and attachment metadata.
- **De-duplication.** Guaranteeing one stored record per Gmail message id.
- **Durable handoff.** Committing the message, then queueing it for processing — in that order.
- **Unattended operation.** The polling cycle and its failure containment.

## Does not own

- **Meaning.** No extraction, no confidence scoring, no matching, no event mutation.
- **Attachment content.** Metadata only; bytes are downloaded elsewhere, later, in another process.
- **Retry of processing.** Once queued, retry semantics belong to the queue.
- **Authorization.** It consumes a stored credential; it does not manage consent or account lifecycle.
- **Ordering.** It makes no attempt to deliver messages in any particular order.

---

# Workflow

Two entry points, one pipeline.

```
    ┌─────────────────┐          ┌─────────────────┐
    │ Scheduler       │          │ Manual trigger  │
    │ (every N ms)    │          │ (operator)      │
    └────────┬────────┘          └────────┬────────┘
             │ all mailboxes              │ most recently connected
             └─────────────┬──────────────┘
                           ▼
                  ┌─────────────────┐
                  │ per-mailbox sync│
                  └────────┬────────┘
                           │
              has cursor? ─┴─ no ──────────► BOOTSTRAP
                           │                (read cursor FIRST,
                          yes                then list recent)
                           ▼
                      INCREMENTAL
                  (changes since cursor, paged)
                           │
                  cursor rejected ─────────► BOOTSTRAP (recover)
                           ▼
                    ┌──────────────┐
                    │ message ids  │
                    └──────┬───────┘
                           ▼
        ┌──────────────────────────────────────┐
        │ sequentially, per message:            │
        │   fetch full message                  │
        │   parse: body, headers, file metadata │
        │   seen before? ──► skip as duplicate  │
        │   persist message + metadata ATOMICALLY│
        │   enqueue for processing              │
        └──────────────────┬───────────────────┘
                           ▼
                  ┌─────────────────┐
                  │ advance cursor  │  once, at end of run
                  └─────────────────┘
```

Everything past "enqueue" belongs to other subsystems.

A mailbox is connected once, with offline access and read-only scope, so a long-lived credential is available and the user never needs to be present again. A newly connected mailbox has **no cursor**, and that absence is what selects bootstrap — it is the initial state of the state machine, not an error.

Body extraction walks the MIME tree, preferring plain text, then stripped HTML, then the message snippet. Real placement mail is frequently multipart and often HTML-only; treating the top-level body as authoritative loses content silently.

---

# State

**Durable state is one value per mailbox: the cursor.** It is the entire synchronization state of the subsystem. Everything else — statistics, mode, in-flight message lists — is per-run and discarded.

Two consequences follow directly, and both are load-bearing:

- **Crash recovery requires no special path.** Because no durable progress lives in process memory, a restart resumes from the cursor. Recovery *is* the normal path.
- **Run statistics are not retained.** Counts of processed, duplicate, queued, and failed messages are computed and logged, then lost. "When did we last sync and what happened" is answerable only from logs.

Two pieces of state owned elsewhere are relied on: the stored mailbox credential, and the set of ingested message ids, which is what de-duplication reads.

**In-process state:** a boolean guarding against overlapping cycles. It is memory-only, which is why the single-instance assumption in Consistency Guarantees exists.

---

# State Machine

Three distinct machines run in this path. Conflating them is the most common source of confusion.

### 1. Mailbox sync mode

Encoded implicitly in whether a cursor exists.

```
        ┌──────────────────┐
        │  UNBOOTSTRAPPED  │   no cursor: newly connected
        └────────┬─────────┘
                 │ full read completes, cursor written
                 ▼
        ┌──────────────────┐
   ┌───►│   INCREMENTAL    │   steady state: delta reads only
   │    └────────┬─────────┘
   │             │ cursor rejected as expired
   │             ▼
   │    ┌──────────────────┐
   └────┤   RE-BOOTSTRAP   │   full read, fresh cursor
        └──────────────────┘
```

The machine is self-healing and has **no terminal error state**. Any mailbox in any condition converges back to INCREMENTAL without operator action, because cursor expiry is modelled as an expected transition rather than a fault.

### 2. Per-message outcome

```
   message id
        ├──► CREATED     persisted + queued
        ├──► DUPLICATE   already known, skipped
        └──► FAILED      threw, counted, skipped — no durable trace
```

These are counters, not persisted state. FAILED leaves nothing behind but a log line, which is the root of the primary failure mode.

### 3. Message lifecycle (downstream, for orientation)

`pending → processing → completed | failed | ignored`. Sync only ever creates messages in `pending` and never advances this machine. `ignored` is a success outcome assigned downstream when a message is understood but carries nothing actionable.

---

# Core Algorithm

Cursor-based delta synchronization with a full-read fallback.

**Bootstrap** establishes a baseline: read the current cursor position, then list the mailbox's messages, paging to exhaustion. Used on first connection and whenever the cursor is rejected. (It read a single bounded page until **Premise 2** below was superseded.)

**Incremental** is the steady state: ask for message-additions since the cursor, page until exhausted, and collect ids into a set so a message appearing in several change records is fetched once.

## The ordering rule that makes bootstrap correct

In bootstrap, the cursor is read **before** messages are listed. This is the single most important piece of reasoning in the subsystem, because the two orderings fail in opposite directions:

| Order | A message arriving mid-run | Result |
|---|---|---|
| Cursor read **after** listing | Absent from our list, but cursor is already past it | **Gap — permanently missed** |
| Cursor read **before** listing | Absent from our list, and cursor is still behind it | Re-offered next run, skipped as duplicate |

Stated as a principle: **overlap is safe, gaps are not.** Because de-duplication is cheap and reliable, the algorithm deliberately biases toward re-reading. Reversing this ordering reintroduces silent data loss — and the loss is undetectable, because nothing signals that a message which never arrived was supposed to.

## Cursor advancement

The cursor is written **once per run, after all messages have been attempted**, and is non-decreasing: in incremental mode it advances only if the change feed reported a newer position.

Note the asymmetry. Bootstrap's cursor is captured *before* work begins; incremental's comes from the response and is applied *after* work completes. Both are safe against gaps. Only bootstrap is safe against per-message failures — which is exactly the primary failure mode.

## Two-layer de-duplication

A pre-check looks for the message id before writing; a uniqueness constraint backs it at the storage layer. These are not redundant. The pre-check is an optimization that avoids a wasted write and produces a clean duplicate count. The constraint is the guarantee. The pre-check alone leaves a race window; the constraint alone makes duplicates indistinguishable from genuine errors.

---

# Engineering Decisions

### 1. Incremental synchronization with a full-read fallback

**Decision** — Track a durable per-mailbox cursor and read only changes since it, falling back to a bounded full read when the cursor is rejected.

**Why chosen** — Work becomes proportional to what changed rather than to mailbox size. This is the difference between a poll that costs a handful of API calls and one that costs hundreds, on every cycle, forever.

**Alternative** — Poll a fixed recent window every cycle (for example, the last N messages or messages newer than a stored timestamp) and rely on de-duplication to suppress everything already seen.

**Why rejected** — It burns quota proportional to window size regardless of activity, and it forces an unwinnable window-size choice: too small silently drops messages during a burst, too large wastes quota permanently. Worse, it makes correctness depend on a tuning parameter rather than on a mechanism. The change feed makes "what is new" an explicit server-side answer instead of something we approximate. The full read is retained only as a recovery path, which is the one place a window is acceptable because it is bounded in frequency rather than in correctness.

### 2. Bootstrap ordering: read the cursor before listing messages

**Decision** — Capture the cursor position first, then list messages.

**Why chosen** — A message arriving between the two operations must land on the safe side of the boundary. Reading the cursor first guarantees the next incremental run's window still includes anything missed by this run's listing.

**Alternative** — List messages first, then take the cursor, so the cursor reflects exactly the state after everything observed was processed.

**Why rejected** — It appears tighter and is in fact broken. A message arriving mid-run is absent from the list but behind the newly captured cursor, so it is never offered again — a permanent, silent gap. The chosen ordering trades a small amount of re-reading for the elimination of an entire class of undetectable loss. Since duplicates cost one indexed lookup and gaps cost a missed placement round, the trade is not close.

### 3. Cursor advancement once per run, after processing

**Decision** — Advance the cursor a single time at the end of a run, independent of per-message outcomes.

**Why chosen** — Simplicity and a single well-defined resumption point. A cycle either completes and moves the watermark, or fails and leaves it, so the next run's window is always unambiguous.

**Alternative** — Advance the cursor per message as each is committed, or hold it at the position of the oldest failure so failed messages are re-offered.

**Why rejected at the time** — Per-message advancement multiplies writes and creates ordering coupling, since the change feed is not strictly ordered per message. Holding at the oldest failure risks a poison message stalling the mailbox indefinitely.

**Consequence, stated plainly** — This decision is the source of the primary failure mode. A message that throws during an incremental run is skipped, the cursor advances past it, and nothing durable records it existed. **That message is lost.** The trade made here — availability of the watermark over completeness of the message set — is defensible in principle, but the current implementation takes the cost without the mitigation. Recording failed message ids for later replay would preserve the simple advancement rule and close the gap, and it is the highest-value correctness work in this subsystem.

### 4. Deferred attachment download

**Decision** — Capture attachment metadata during sync; download bytes later, on a separate queue, in a separate process.

**Why chosen** — Keeps cycle time proportional to message count, not payload size. A single large PDF cannot stall a mailbox poll, and download failures are isolated from ingestion entirely.

**Alternative** — Download attachment bytes inline while the message is being ingested, producing one complete record in one pass.

**Why rejected** — It couples ingestion latency to the largest attachment in the batch and makes cycle duration unpredictable, which matters because the scheduler skips ticks when a run overruns. It also puts a high-failure-rate operation (large binary transfer) inside the low-failure-rate path, so a transient download error would take the whole message with it. Deferral costs an extra queue and a later credential resolution — the download resolves its credential by walking from the attachment to its message to the mailbox that ingested it, so it always uses the correct authority.

### 5. Queue boundary between capture and interpretation

**Decision** — Sync commits a message and enqueues a job. Interpretation happens in a separate worker process.

**Why chosen** — Acquisition and understanding have unrelated failure profiles, latencies, and costs. Interpretation calls a paid external model with multi-second latency and its own failure modes. Putting that in the poll loop would make mailbox freshness depend on AI availability. The queue also supplies durable retry, which sync itself does not have.

**Alternative** — Interpret inline during sync, so a message is fully processed by the time the cycle ends.

**Why rejected** — It couples mailbox freshness to model latency, makes cycle duration unbounded, and — most importantly — makes a failure in extraction into a failure of ingestion. That is precisely backwards: a message we cannot yet understand is still a message we must not lose. The queue boundary means an extraction bug is replayable from stored messages instead of requiring a re-fetch from Gmail.

**Trade-off** — Processing is asynchronous, so a message is visible in the mailbox before it is visible as an event. The product accepts eventual consistency here.

### 6. Sequential processing, within and across mailboxes

**Decision** — Process messages one at a time within a mailbox, and mailboxes one at a time within a cycle.

**Why chosen** — Failure isolation stays trivial (a try/catch per message, per mailbox), and API usage stays predictable against rate limits.

**Alternative** — Fetch messages concurrently with bounded parallelism, and sync mailboxes in parallel.

> **⚠ SUPERSEDED ASSUMPTION — the credential-safety argument no longer applies.**
>
> *This decision previously read:* sequential processing is "what keeps the shared API client safe, since all calls in a process go through one mutable client whose credentials are re-set per call", and concurrency "would race on the shared mutable client, so credentials from one mailbox could be used for another". It closed by noting that the safety was maintained **by convention, not by construction** — "exactly the invariant that breaks quietly during an unrelated refactor."
>
> *That prediction was correct, and the invariant had in fact already broken.* See **Premise 1** under *Superseded premises* below. The shared mutable client is gone: each mailbox operation now builds its own client, so credential isolation is structural rather than a property of not running things at the same time.

**Why still rejected — the remaining reasons, restated.** One of the three original preconditions is now met, so the conclusion is re-derived rather than carried forward:

| Original precondition | Status |
|---|---|
| Concurrency would race on the shared mutable client | **Met.** One client per operation; no shared credential state exists to race |
| Rate-limit behaviour would become bursty and harder to reason about | **Still unmet.** Unchanged by anything since |
| It would widen the de-duplication race window, turning a benign constraint violation into a dropped message (with decision 3) | **Still unmet.** Unchanged |

Two of three still hold, so the decision stands — but it now stands on throughput-shaping and de-duplication grounds, **not** on credential safety. The distinction matters: the old argument implied concurrency was *unsafe*, and the current one only says it is *unjustified*. Anyone revisiting this should evaluate the two remaining preconditions on their own merits rather than re-reading a credential risk that no longer exists.

### 6a. Concurrency, stated precisely

Because the previous decision's framing invited a stronger reading than the code supports, the actual boundary is worth stating on its own.

**What is concurrent today**

- **The web process runs two independent timers** — the Gmail scheduler and the email reconciler — with separate `isRunning` guards. They overlap each other freely, and that is deliberate: a stalled Gmail request must not stop orphan recovery.
- **A background sync cycle and an explicit `POST /gmail/sync` genuinely overlap**, because the scheduler lives in the same process that serves requests. This is the case the per-operation client exists for.
- **Downstream processing is a separate process entirely.** Everything past the queue boundary is the email worker's, not sync's.

**What is serialized, and by what**

| Serialized | By | Guarantee |
|---|---|---|
| Messages within one mailbox | The `for` loop in the sync routine | Failure isolation per message |
| Mailboxes within one cycle | The `for` loop in the scheduler | One mailbox's failure never aborts the others |
| Overlapping runs of the *same* scheduler | An `isRunning` flag | A cycle that outlasts its interval skips rather than stacking |

**What protects correctness rather than ordering**

Serialization is not the safety mechanism; three constructions are:

- **Per-operation OAuth clients** — credential isolation by construction.
- **`gmailMessageId` uniqueness** — re-running a sync is safe regardless of order.
- **Deterministic BullMQ job ids** — a duplicate enqueue collapses into the existing job.

**The trade-off as it stands**

Throughput is bounded by sequential fetching, and a large mailbox therefore syncs slowly. The system accepts that because the pressure is not throughput.

**What would change with multiple concurrent workers or processes.** The `isRunning` guards are **in-process only** — plain module-scoped booleans, not distributed locks. A second API instance runs its own schedulers with its own flags, so both would sync the same mailboxes simultaneously. The de-duplication constraint and the deterministic job ids mean that produces duplicate *work*, not corrupted data, but cursor advancement is not coordinated and the concurrent-fetch precondition above remains unmet. **Horizontal scaling of the web process requires distributed coordination before it is safe** — this is an unresolved constraint, not a solved problem.

### 7. Idempotent persistence keyed on the provider's message id

**Decision** — Use the Gmail message id as the de-duplication key, enforced by a uniqueness constraint and checked before write.

**Why chosen** — It makes re-running a sync safe, which in turn makes the overlap bias in decision 2 affordable and makes "just run it again" a valid response to nearly any anomaly. Idempotency at the boundary is the mechanism that lets everything upstream be conservative.

**Alternative** — De-duplicate on a content hash of subject, sender, and body, or on a natural key derived from message content.

**Why rejected** — Content is not stable. The same message reaches us with different whitespace, encodings, and quoted history depending on how it is fetched and parsed, so a content hash produces false negatives (duplicates admitted) as parsing evolves. The provider id is stable, opaque, and already unique by definition. It also survives changes to our own parsing logic, which a content key would not.

**Related trade-off** — Manually submitted messages carry no provider id. Because the uniqueness constraint permits multiple absent values, the manual path is **not de-duplicated**. This is an accepted asymmetry between the two entry points, not an oversight.

### 8. Narrow error classification for the cursor fallback

**Decision** — Fall back to a full read only when the cursor is specifically rejected as expired; re-throw every other error.

**Why chosen** — A full read is expensive and, after a long gap, incomplete. It must be reserved for the one condition it actually addresses.

**Alternative** — Treat any failure of the change-feed read as a signal to fall back.

**Why rejected** — It turns an ordinary network blip into a full mailbox re-scan, and worse, it hides real errors behind an expensive success path. A transient failure should retry on the next tick with the cursor intact, not trigger recovery machinery. Broad catch clauses around a recovery path convert diagnosable faults into silent, costly behaviour.

---

# Invariants

**At most one stored message per Gmail message id.** Enforced by a uniqueness constraint, not only by the pre-check. Duplicates are expensive downstream and must be impossible, not merely unlikely.

**A message and its attachment metadata are committed atomically.** Written in one transaction, so a message never exists with partially recorded attachments — which would leave attachments permanently unqueued with no signal.

**Processing is enqueued only after the message is durably committed.** Otherwise a job can reference a row that does not exist, turning a crash into a permanent poison job.

**The cursor is non-decreasing per mailbox.** A moving-backward cursor would re-offer arbitrarily large windows and, in the worst case, loop.

**The bootstrap cursor is captured before messages are listed.** The gap-elimination argument in decision 2 depends entirely on this.

**At most one cycle runs at a time per process.** Prevents pile-up when a run exceeds the interval. Note this is process-local, which bounds deployment topology.

**Sync performs no interpretation.** No extraction, matching, event mutation, or attachment-byte download on this path. This is what keeps mailbox freshness independent of model availability.

**Every ingested message records the mailbox that ingested it.** Origin and credential remain resolvable later, when attachment download runs in another process at another time.

---

# Failure Handling

## Failure boundaries

Containment is layered, each layer bounding a different radius:

```
  cycle      ── a failed cycle logs and returns; the timer survives
    │
  mailbox    ── one mailbox's failure does not affect others in the cycle
    │
  message    ── one message's failure does not abort the run
    │
  queue      ── processing failures are retried and retained, not lost
```

The scheduler wraps its entire cycle so nothing escapes into the timer, including a failure to load the mailbox list. **The interval outlives every failure beneath it**, which is the property that makes unattended operation viable.

An expired cursor is classified specifically and handled by re-bootstrapping. Every other error is re-thrown deliberately (decision 8).

## Retry behaviour

**Sync has no retry.** A failed message is counted, logged, and skipped. **The queue has retry** — bounded attempts with exponential backoff, and failed jobs are retained rather than discarded so they stay inspectable. A duplicate-event constraint violation surfacing during processing is treated as success, since a concurrent path already reached the desired end state.

The asymmetry is worth internalizing: **retry lives past the queue boundary, not before it.**

## Recovery

All durable sync state is one cursor per mailbox, so a restart resumes from the last completed run and the scheduler runs a cycle immediately on startup rather than waiting an interval. Cursor loss self-heals via re-bootstrap. Because ingestion is idempotent, re-running is always safe and is the standard operational response.

**Recovery limit:** bootstrap now walks the mailbox listing to exhaustion rather than reading a bounded window, so the recovery limit is Gmail's own history retention rather than a message count — see **Premise 2** below.

**Recovery beyond sync.** An Email that was persisted but never enqueued is not a sync failure and sync cannot see it. That case has its own repair path — see *The email reconciler* below.

## Failure preferences

```
   ingested twice  >  ingested late  >  cycle fails loudly  >  silently dropped
```

The subsystem is built to prefer duplicate work over missed work, because de-duplication is cheap and gaps are undetectable. The primary failure mode is the one case where the implementation violates its own stated preference: a failed message is silently dropped rather than duplicated, delayed, or surfaced.

---

# Request Deadlines and Credential Failure

Two mechanisms that bound how badly a single mailbox can go wrong. Both are recent enough that the decisions above were written without them.

## Every request is bounded, from one place

`createOAuthClient` sets `transporterOptions: { timeout: GMAIL_REQUEST_TIMEOUT_MS }` — 10 seconds by default. google-auth-library builds its transporter from those options and uses that one gaxios instance for **both halves of every operation**: its own OAuth token refresh, and the Gmail API call dispatched through it. Configuring it there therefore bounds token refresh, every API request, every page of a paginated walk, and the attachment download — without repeating a deadline at six call sites, where one omission would silently reopen the hole.

**Why a deadline at all.** gaxios attaches one only when `opts.timeout` is supplied, and neither googleapis nor google-auth-library supplies it. An unanswered request otherwise waits forever — and because the scheduler awaits each account in sequence and clears its overlap guard in a `finally`, one stalled socket stopped Gmail sync for **every** user until the process restarted. A `finally` runs when its `try` settles; an await that never settles never gets there.

**Abort, not abandon.** gaxios turns `timeout` into `AbortSignal.timeout()`, which aborts the underlying fetch. Abandoning the promise instead would leave the socket open and the scheduler still holding work that never ends.

**Per attempt, not per operation.** gaxios re-arms the timeout on each retry and caps retries independently, so one HTTP operation's worst case is roughly three attempts plus backoff — about 30 seconds. That is comfortably inside the 120-second sync interval, so a stalled mailbox is detected and the cycle still finishes within one period. **A timeout is not retried indefinitely**, and a timed-out mailbox simply fails its cycle and is retried on the next one. Nothing is persisted.

## Three failure classes, kept distinct

The code classifies failures rather than treating them alike, and the distinction decides whether anything durable happens:

| Class | Example | Outcome |
|---|---|---|
| **Transient** | timeout, network, `429`, any `5xx` | Retried at the transport layer; the mailbox fails this cycle and is retried next. **Nothing persisted** |
| **Expired cursor** | `404` on the history call | Classified specifically, handled by re-bootstrapping to a full sync. Not an error condition |
| **Permanent authorization failure** | HTTP **400** carrying Google's **`invalid_grant`** | `reauthRequiredAt` is stamped on the mailbox; the error is then rethrown unchanged |

**Only the last class sets the flag.** `isPermanentGmailAuthFailure` is true for exactly `status === 400 && googleError === "invalid_grant"` — the one case Google documents as requiring the user to authenticate and consent again, so presenting the same token cannot succeed however many times it is tried. Everything else is false on purpose: `401` is ambiguous and routinely cured by the library's own refresh; `403` covers rate limiting as readily as a scope error and the status cannot tell them apart; a `400` without `invalid_grant` is this application's bug, not a revoked authorization. Excluding a mailbox on any of those would strand a user whose mailbox is perfectly healthy — a worse outcome than the futile retrying the flag prevents.

## What `reauthRequiredAt` means

A nullable timestamp on the mailbox record. A timestamp rather than a boolean because it records **when** authorization broke, which a boolean would lose; `NULL` means eligible.

- **The background scheduler skips the mailbox.** Its account query filters on `reauthRequiredAt: null`, so the mailbox drops out of automatic sync and stops burning a cycle on a token Google will not accept.
- **An explicit user-triggered sync still attempts it.** That path resolves mailboxes by owner alone, so a user who has just reconnected is never blocked by a stale flag.
- **The mailbox is *not* disconnected.** The record stays and the refresh token is deliberately left in place — Google has already invalidated it, so deleting it protects nothing and only makes reconnect harder to reason about.
- **Clearing it takes a real event.** A successful reconnect writes a new refresh token and clears the flag in the same update; a successful sync also clears it, written only when the flag was actually set so the ordinary success path stays at one write. `historyId` is untouched either way, so sync resumes incrementally rather than re-reading the mailbox.

The user-visible contract: **the mailbox stops syncing automatically until the user authorizes it again.** Nothing is deleted, and nothing else about the account changes.

---

# The Email Reconciler

Not part of sync, but the repair path for a failure sync creates and cannot see. Documented here because the inconsistency originates at this boundary.

**The invariant it restores:** *every persisted Email eventually reaches the queue.*

Ingestion commits the Email to Postgres and then enqueues to Redis. The two stores cannot share a transaction, so a failed enqueue leaves a committed row at `processingStatus: "pending"` with no job behind it. Sync cannot recover it: the de-duplication check short-circuits every replay of that message, and the cursor has already advanced past it. An email accepted through the manual route has no Gmail message to replay at all.

| | |
|---|---|
| Where it runs | The **API process**, on its own timer — not a worker, and deliberately not the Gmail scheduler's timer |
| Why separate | The failure that creates orphans is Redis being unreachable during ingestion, which is exactly the degraded moment when the rest of the system is least healthy. Recovery must not depend on the component most likely to be broken — and a stalled Gmail request can leave that scheduler's guard set for the life of the process |
| What it scans | `pending` Emails older than a configured minimum age (default 5 minutes), because a legitimately queued email is indistinguishable from an orphan until a backlog has had time to drain |
| What it does | Re-enqueues each row through the **normal producer**, carrying the row's own owner. It never writes `processingStatus` — the worker owns that lifecycle, and a second writer would make it ambiguous |
| Isolation | Per-row `try/catch`; one failure never aborts the sweep, and a failed row stays `pending` and eligible next pass |

**It is safe to re-enqueue a row that already has a job.** The reconciler cannot see Redis, so it must be. The deterministic job id is what makes it safe: BullMQ refuses a second `add` while a job with that id exists, so the duplicate collapses into the job already queued. Checking Redis first would race the exact window the sweep exists to close.

**The guarantee is eventual processing with at-least-once delivery — not exactly-once.** Exactly-once is not achievable across Postgres and Redis and is not claimed. The job id suppresses duplicate *jobs*; the one non-idempotent side effect that survives a genuine double run is absorbed at the database by the constraint that makes the extraction write an upsert.

See [`docs/deployment.md §11.6`](../deployment.md#116-the-email-reconciler) for its operational behaviour, and [`docs/03_Development/Development_Environment.md`](../03_Development/Development_Environment.md) for exercising it locally.

---

# Superseded Premises

Two premises this document was originally written on no longer hold. Both are preserved rather than deleted, because the reasoning that produced them still constrains changes here.

## Premise 1 — "one mutable client per process, credentials re-set per call"

> **SUPERSEDED**

**The old premise.** All Gmail API calls in a process went through a single shared OAuth client whose credentials were re-set before each call. Decisions 5 and 6 rested on this: sequential processing was described as what *kept that client safe*, and concurrency was rejected partly because it "would race on the shared mutable client, so credentials from one mailbox could be used for another." The document noted the safety held "by convention, not by construction."

**What changed.** The convention was already broken. Five of the six mailbox helpers survived only by accident — they issue one API call, and google-auth-library happens to capture the credential object synchronously before its first await. `getHistoryChanges` did not survive it at all: it set credentials once and then paginated, so every page after the first re-read whatever the shared client held by then and could walk a **different mailbox**. That is a real cross-tenant credential leak, and it was reachable because the scheduler runs in the same process that serves requests, so a background sync and an explicit user sync genuinely overlap.

**Current reality.** One client per **operation**. A helper builds its own client and its own Gmail service together, so no other operation can reach it and no interleaving can cross credentials. A single process-wide client remains for the three calls that act as the *application* rather than as a user — generating the auth URL, exchanging the code, verifying an ID token — and it must never hold mailbox credentials. Credential isolation is now structural, and does not depend on when things run.

## Premise 2 — "bootstrap reads a bounded window of recent messages"

> **SUPERSEDED**

**The old premise.** A full sync listed a single page of recent messages. *Failure Handling* stated the consequence as a recovery limit: recovery was complete "only while the gap is smaller than that window", and if the cursor expired while more than a page of messages arrived, the messages in between were "not recovered by any automatic path."

**What changed.** `maxResults` is a **per-page** limit, not a total, and a `nextPageToken` in the response means more messages exist. Reading one page and discarding the token dropped an unbounded remainder — and the caller then advanced the mailbox's cursor past everything it had never seen, putting those messages permanently beyond the reach of any later incremental sync. The bounded window was not a conservative limit; it was a silent gap, and it was worst in exactly the case bootstrap exists to handle.

**Current reality.** The listing walks to exhaustion, continuing on the **token** rather than on whether a page had messages — a page can come back empty while more remain behind it. There is deliberately **no page cap**, because a cap is the original defect wearing a different name; each request is independently bounded by the client timeout instead. A page that rejects propagates rather than being swallowed, so a partial listing can never be mistaken for a complete mailbox: the caller writes the watermark on success, and a swallowed page error would turn a retryable failure into a permanent gap.

**What the recovery limit is now.** Gmail's own history retention, not a message count. If the cursor expires, bootstrap re-reads the mailbox listing in full. There is still no backfill mechanism for mail that has aged out of what Gmail will return.

---

# Consistency Guarantees

**Delivery: at-least-once, conditionally.** For a message successfully fetched, parsed, and persisted, delivery to the processing queue is at-least-once; overlap between runs is expected and absorbed by de-duplication. For a message that throws during sync, delivery degrades to **at-most-once**. The subsystem is at-least-once on the happy path and lossy on its error path — an accurate summary of its current maturity.

**Persistence: effectively exactly-once per message id.** However many times a message is offered, at most one record exists. The constraint is the authority; the pre-check only avoids the write.

**Idempotency: guaranteed at the boundary, keyed on the provider id.** This is what makes re-running safe. It does not extend to the manual submission path, which has no provider id.

**Freshness: eventual, bounded by the poll interval.** Local state converges to mailbox state within roughly one interval plus processing time. There is no real-time guarantee.

**Ordering: none.** Messages are processed in whatever order the API returns them, and downstream work is queued and retried independently. Nothing here guarantees an older message is interpreted before a newer one. This is safe only because reconciliation is trust-aware rather than last-write-wins.

**Consistency boundary: one mailbox, one run.** No cross-mailbox transaction and no globally consistent sync point. A cycle can leave some mailboxes advanced and others not.

**Credential isolation: structural.** Each mailbox operation builds its own OAuth client, so no interleaving can cross one mailbox's credentials into another's request. This does not depend on sequential execution — see **Premise 1**.

**Single-writer assumption.** The overlap guard is in-process memory. Two API instances would run two schedulers with no mutual exclusion, permitting concurrent syncs of one mailbox. The uniqueness constraint still prevents duplicate rows, and credentials can no longer be crossed, but the losing writer's error is counted as a message failure — which, combined with cursor advancement, converts a benign race into a dropped message. **This subsystem still assumes a single instance.** Horizontal scaling requires a distributed lock first.

---

# Related Components

Dependency direction is strictly one-way: **sync depends on the mailbox credential store and the message store; everything else depends on sync.** Preserving that direction is what keeps the ingestion boundary meaningful.

```
  credential store ──┐
                     ├──► SYNC ──► message store ──► queue ──► interpretation
  scheduler ─────────┘                  │                          │
                                        └──► attachment metadata ──┴──► document
                                                                        pipeline
```

- **Account connection** produces the credential and the cursor-absent initial state.
- **Scheduler** drives unattended operation and owns cycle-level containment.
- **Message store** is sync's only write target and owns the uniqueness constraint that backs de-duplication.
- **Queue and workers** are the handoff point, and supply the retry semantics sync lacks.
- **Interpretation, reconciliation, and event layers** are pure downstream consumers; they never call into sync.
- **Attachment pipeline** consumes metadata sync captured, resolving credentials back through the ingesting mailbox.
- **Configuration** owns the poll interval, the primary tuning knob for freshness versus API cost.

---

# Things This Subsystem Does NOT Do

- **It does not interpret messages.** No extraction, confidence scoring, matching, or event mutation. Interpretation runs in workers past the queue boundary so mailbox freshness never depends on model availability.
- **It does not download attachment bytes.** Metadata only. Bytes are fetched later, elsewhere, so payload size cannot affect cycle time.
- **It does not retry failed messages.** Retry is a queue responsibility and begins only after handoff.
- **It does not manage consent or account lifecycle.** It consumes a stored credential and does not detect or handle revocation.
- **It does not guarantee ordering.** Deliberately delegated: reconciliation is designed to be order-insensitive.
- **It does not de-duplicate manually submitted messages.** Those carry no provider id, so the key that makes de-duplication work does not exist for them.
- **It does not coordinate across processes.** Its concurrency guard is process-local by design; distributed coordination is unimplemented, not merely unconfigured.
- **It does not retain run history.** Statistics are logged, not stored.

---

# Future Evolution

**Correctness**
- **Close the drop path (highest value).** Record failed message ids for later replay, preserving the simple cursor-advancement rule while eliminating silent loss. Alternatives — holding the cursor at the oldest failure, or per-message checkpointing — carry poison-message and write-amplification costs respectively.
- ~~**Bounded-window backfill** so recovery completeness stops depending on outage duration.~~ **Superseded** — bootstrap now pages to exhaustion (**Premise 2**), so completeness is bounded by Gmail's history retention rather than by outage duration. A backfill beyond that retention remains unbuilt.

**Scalability**
- **Distributed coordination** to replace the in-process overlap guard, removing the single-instance assumption. **Now the sole remaining blocker to running more than one API instance.**
- ~~**Per-request API clients** to replace the shared mutable client.~~ **Done** (**Premise 1**) — the convention-maintained invariant is now structural. It unblocked *credential safety* under concurrency, not concurrency itself; the other two preconditions in decision 6 still stand.
- **Bounded parallelism** within a mailbox, valid only once rate-limit shaping and the de-duplication race are addressed.

**Product**
- **Push notification instead of polling.** Collapses freshness from minutes to seconds and cuts quota substantially. The cursor machinery does not disappear — it becomes the reconciliation path for missed notifications, which is its correct long-term role.
- **Server-side filtering** to fetch only plausibly relevant mail, reducing fetch volume, storage, and downstream model spend — the last being the real cost driver.

**Operational**
- **Persist per-run statistics** so "when did we last sync and what happened" is answerable without reading logs. Prerequisite for operating this unattended at any scale.
- **Credential lifecycle handling** so revoked authorization becomes a visible mailbox state rather than a recurring per-cycle failure buried in logs.

---

# Interview Discussion

**Q: Why keep a full-read path at all if incremental sync works?**
Because the change feed's cursor has bounded server-side retention. After a long enough outage the cursor is rejected and there is no delta to compute from. The full read is a recovery mechanism, not an alternative strategy — and treating cursor expiry as an expected state transition rather than a fault is what makes the subsystem self-healing.

**Q: In bootstrap you read the cursor before listing messages. Isn't reading it after more accurate?**
It looks tighter and is actually broken. A message arriving between the list and the cursor read is absent from the list but behind the new cursor, so it is never offered again — a permanent, silent gap. Reading the cursor first means such a message falls inside the next window and is re-offered, where de-duplication discards it. Overlap is safe; gaps are not, and gaps are undetectable.

**Q: What happens to a message that fails mid-sync?**
It is counted, logged, and skipped — and the cursor still advances past it at the end of the run, so the change feed will not offer it again. Nothing durable records it existed. That message is lost. It is the subsystem's sharpest edge and the one place the implementation violates its own failure preference. The cheapest fix that preserves the current design is to record failed ids for replay.

**Q: You have a pre-check and a uniqueness constraint for de-duplication. Isn't one redundant?**
No. The pre-check is an optimization — it avoids a wasted write and produces a meaningful duplicate count. The constraint is the guarantee, and it is what holds under a race between concurrent syncs. Remove the pre-check and you lose observability and do extra work; remove the constraint and you lose correctness.

**Q: Why not de-duplicate on a content hash instead of the provider's message id?**
Content is not stable across fetches and parser versions — whitespace, encoding, and quoted history vary — so a content key produces false negatives as parsing evolves, admitting duplicates. The provider id is opaque, stable, and unique by construction, and it survives changes to our own parsing logic.

**Q: Why is processing behind a queue rather than inline?**
Acquisition and interpretation have unrelated failure profiles and latencies. Interpretation calls a paid model with multi-second latency; inline execution would make mailbox freshness depend on model availability and would turn an extraction failure into an ingestion failure. Since a message we cannot yet understand is still one we must not lose, capture has to be durable before understanding is attempted. The queue also supplies the retry that sync itself lacks.

**Q: Everything is sequential. Why not parallelize?**
Originally for three reasons; one of them is now gone. The credential argument — all API calls sharing one mutable client, so concurrency would race on credentials — no longer applies: each operation builds its own client, and that isolation is structural rather than a consequence of not running things at the same time. Two reasons remain: parallel fetches make rate-limit behaviour bursty and harder to reason about, and wider de-duplication races combine with cursor advancement to turn constraint violations into dropped messages. Throughput is not the binding constraint today, so the decision stands — but on those grounds, not on safety. The honest version of this answer distinguishes *unsafe* from *unjustified*, and this is now the second.

**Q: What breaks if you run two instances of this service?**
The overlap guard is in-process memory — a module-scoped boolean, not a distributed lock — so both schedulers run with no mutual exclusion and can sync one mailbox concurrently. Credentials can no longer be crossed, and the uniqueness constraint still prevents duplicate rows. But the losing writer sees a constraint violation, which is counted as a message failure, and the cursor advances past it: a benign race becomes a dropped message. The subsystem assumes a single instance; horizontal scaling needs a distributed lock first.

**Q: What happens when a Gmail request hangs?**
It is aborted after `GMAIL_REQUEST_TIMEOUT_MS` (10 s), configured once on the OAuth client so it covers token refresh, every API call, every page of a paginated walk, and attachment downloads. Before that deadline existed, one unanswered request stopped Gmail sync for every user until the process restarted — the scheduler awaits accounts in sequence and clears its overlap guard in a `finally`, and a `finally` never runs for an await that never settles. The timeout is per attempt, so one operation's worst case is roughly three attempts plus backoff, comfortably inside the sync interval.

**Q: When does a mailbox need reconnecting, and what happens to it?**
Only on HTTP 400 with Google's `invalid_grant` — the one failure Google documents as requiring fresh consent. That stamps `reauthRequiredAt`, which drops the mailbox out of the background scheduler's account query. It is not disconnected: the record and the (already-invalid) token stay, an explicit user-triggered sync still attempts it, and either a reconnect or a later successful sync clears the flag. `401` and `403` deliberately do not trigger it — `401` is routinely cured by the library's own token refresh, and `403` cannot be distinguished from rate limiting.

**Q: How would you migrate to push notifications?**
Add the subscription path and treat notifications as triggers for the existing per-mailbox sync rather than as a replacement for it. The cursor stays: notifications can be missed or delivered out of order, so the delta read remains the reconciliation mechanism and the periodic poll becomes a lower-frequency safety net. The valuable property is that idempotent ingestion already makes duplicate triggers harmless, so the migration does not require new correctness machinery.

---

# Confidence

**High.**

Every behavioural claim — the two sync modes, bootstrap ordering, single-point cursor advancement, two-layer de-duplication, atomic message-plus-metadata commit, enqueue-after-commit ordering, layered failure containment, narrow expiry classification, queue retry configuration, exhaustive bootstrap pagination, the request deadline and its per-attempt semantics, the `invalid_grant`-only reauthentication transition, the reconciler's scan and re-enqueue, and per-mailbox credential resolution for attachments — is derived directly from the source: the Gmail module in full, the message store, producer and reconciler, the processing worker and processor, queue and Redis infrastructure, configuration constants, and the attachment path.

The **primary failure mode** (a failed message dropped because the cursor advances regardless of per-message outcomes) is derived from code, not inferred: the failure counter, the unconditional cursor write at end of run, and the absence of any durable record of failed ids are each directly observable.

Two items are **architectural inference** rather than direct code reading, and are marked as such where they appear:

- The rationale attributed to past decisions (the "why rejected" arguments) reconstructs reasoning consistent with the implementation and its comments. It is sound engineering justification for the current design, not a transcript of the original discussion.
- The multi-instance failure analysis is deduced from the in-memory guard plus constraint behaviour plus cursor advancement. It has not been empirically reproduced.

**Test coverage has changed since this document was first written, and the caveat is now narrower.** It previously read that coverage was "limited to message parsing and attachment-metadata extraction" and that the synchronization algorithm was not covered at all. Four of the properties described above now have dedicated suites — credential isolation across interleaved operations, full-sync pagination, the request deadline, and the reauthentication lifecycle — alongside parsing and the OAuth routes.

What remains uncovered is the **algorithm's control flow**: mode selection, cursor advancement, and the per-message failure path. Those properties are still guaranteed by reading rather than by execution, which is the relevant caveat when changing this code — and the primary failure mode above sits squarely inside the uncovered part.
