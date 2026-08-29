# 08 — Reliability, Idempotency, and Transactions

This is the chapter that turns the project into an LLD / system-design conversation. Every
item follows the same shape:

**Problem → naive approach → how it fails → what the code does → why that works.**

All ✅ **Current**.

---

## 1. Idempotent email ingestion

**Problem.** Gmail's history API can report the same message more than once, a full sync
overlaps with what incremental sync already fetched, and the scheduler can fire while a
previous run is still finishing.

**Naive.** Insert every fetched message.

**Fails.** Duplicate `Email` rows, each producing a duplicate `EmailExtraction`, each
enqueuing a job, each racing to create the same `Event`.

**Code.** `Email.gmailMessageId @unique`, and `syncSingleMessage` looks it up *before*
inserting:
```ts
const existing = await getEmailByGmailMessageId(parsed.messageId);
if (existing) return { status: "duplicate", emailId: existing.id };
```
Plus `getHistoryChanges` collects ids into a `Set`, and the scheduler guards overlapping
runs with an `isRunning` flag.

**Why it works.** The unique constraint is the real guarantee; the lookup is the fast path
that avoids relying on an exception. And the sync watermark is captured **before** listing,
so the failure mode is re-fetching a message (which dedupe absorbs) rather than skipping one
(which nothing absorbs). **Overlap is safe; gaps are not.**

---

## 2. Idempotent email *processing*

**Problem.** A worker can crash mid-job, and BullMQ will re-deliver it. A job can be retried
after a partial failure.

**Naive.** A `processed` boolean, set at the end. Or a dedupe table keyed by job id.

**Fails.** Both are extra state that can itself be wrong, and neither helps when the job
crashed *after* writing but *before* setting the flag.

**Code.** No dedupe table at all. The pipeline is idempotent **by construction**:
- extraction is a pure function of the email body
- matching finds the same event by exact `eventKey`
- `detectChanges` compares field by field and returns `[]` when nothing differs
- `changes.length === 0` → return early, write nothing, create no audit row

**Why it works.** A re-run recomputes the same values, finds the same event, detects no
change, and does nothing. Idempotency is a *property of the operation*, not a flag you have
to remember to set. Nothing can drift out of sync with it.

🕘 **This used to have one hole, and it is now closed.** `createExtraction` was a plain
insert, so reprocessing appended a second `EmailExtraction` row. It was defended as an
append-only log of *"the extractor was run and produced this"* — but every crash point in
the email path converged on the same symptom: the insert ran, the job died before BullMQ
acknowledged it, the stalled checker replayed it, and the row was written twice.

**What closed it:** a `@@unique([emailId, userId])` constraint plus an upsert resolved on
that key. Convergence is enforced by the **database**, not by the repository remembering to
check. That distinction is the point — a `findFirst` before `create` is two statements with a
window between them, and it would appear to work only for as long as worker concurrency
stayed at 1, which is a scheduling accident rather than an invariant.

Composite with `userId` rather than keyed on `emailId` alone, because `emailId` is unique
only within an owner and the relation itself is composite. Keyed on the email alone, one
tenant's replay could address another tenant's row.

**LATEST WINS**, deliberately: the update branch rewrites the row, so it describes the
attempt that actually completed rather than the one that crashed part-way through.

---

## 3. Deterministic event identity

**Problem.** "Is this the same round?" has to be answerable cheaply and consistently.

**Naive.** Fuzzy-match every new observation against every stored event.

**Fails.** Expensive, non-deterministic, and unpinnable — the same email can match
differently as the data grows.

**Code.** `eventKey = "company|stage|date"` (`event.utils.ts`), enforced by
`@@unique([userId, eventKey])`, looked up first by tier 1 of the matcher.

**Why it works.** It turns the common case — an email repeating what you already know — into
a single indexed lookup with no judgement involved. Fuzzy matching is then only needed for
the cases where identity genuinely *is* ambiguous.

**The subtlety worth stating:** the key contains the date, so a reschedule *changes the
identity string*. `updateEventService` regenerates it on a date change, rebuilding it from
`existing.company` / `existing.stage` (identity attributes are preserved) and the new date.
Without that, the next email about the new date wouldn't find the event and would create a
second one at the vacated slot.

---

## 4. Duplicate prevention when two workers race

**Problem.** Two jobs for the same round processed concurrently. Both look up the key →
both get null → both insert.

**Naive.** Check-then-insert, and stop there.

**Fails.** Classic TOCTOU. The window between the check and the insert is small but real,
and it is genuinely reachable: a stalled BullMQ job returned to `wait` by the stalled
checker can run alongside the original attempt.

### 🕘 SUPERSEDED — how this used to be handled

> **The old model.** `createEvent` did `findFirst` then `create`, and that was the whole of
> its concurrency story. The loser of the race got a `P2002`, which propagated all the way
> out of the repository, out of the service, and was caught in the **email worker**:
>
> ```ts
> if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
>   console.log("Duplicate event detected");
>   return;    // success — do NOT retry
> }
> ```
>
> **Why it was considered reasonable.** The application check is an optimisation; the
> database constraint is the guarantee. Treating the violation as *success* is
> directionally right — the desired end state already exists, and retrying would only
> reproduce the violation three times before giving up.
>
> **The problem discovered.** The loser learned nothing. It aborted the whole job at
> whatever point the insert failed, returning `undefined` instead of the Event the winner
> had just created — so any work the job still had to do with that Event simply did not
> happen. Worse, the catch matched **any** `P2002` from anywhere in the job, not just this
> constraint: an unrelated unique violation was silently reported as a duplicate event and
> swallowed. Recovery lived three layers away from the operation that needed it.

### Current model — recover at the repository boundary

`createEvent(owner, data, eventKey)` now handles its own race and always returns an Event:

```
findUnique({ userId_eventKey })        ← real unique lookup, not an approximation
   │
   ├─ found  ────────────────────────► return it
   │
   └─ not found → create(...)
         │
         ├─ succeeds ────────────────► return the new row
         │
         └─ throws
               │
               ├─ P2002 naming (userId, eventKey)
               │     → re-read findUnique({ userId_eventKey })
               │           ├─ found → return the winner's row
               │           └─ not found → rethrow
               │
               └─ anything else → rethrow unchanged
```

**Three things changed, and each matters:**

**1. The lookup is a real unique lookup.** `findUnique` on the composite selector
`userId_eventKey`, not `findFirst` on a pair of columns. Since ownership landed, the key is
unique *per owner*, so the composite selector is exactly the constraint — see *Deterministic
event identity* above.

**2. The recovery is constraint-specific.** The handler does not catch "a `P2002`". It
checks that the error's `meta.target` names **both** `userId` and `eventKey`:

> ⚠️ **Not all `P2002` errors are duplicate events.** Any other unique violation this insert
> could in principle raise is a different conflict entirely and is rethrown unchanged. A
> catch-all would swallow real defects and report them as benign.

**3. The database is the concurrency authority, and the loser reads the answer.** On a
conflict on *this* constraint, the other execution's row is the correct answer, so the loser
re-reads and returns it. Both callers end up holding the same Event and both proceed
normally.

**The precise guarantee: idempotent convergence, not exactly-once.** The race is not
prevented — it is *recovered from*. Two concurrent executions can both attempt the insert;
the constraint decides, and the loser converges on the winner's row rather than failing.
Repeating `createEvent` with the same `(owner, eventKey)` converges on one Event however
many times it runs.

**The worker's `P2002` catch still exists** and is unchanged. It is now a residual safety
net rather than the mechanism: the eventKey race is resolved inside the repository before it
can reach the worker at all.

### Cross-tenant collisions are not collisions

Uniqueness is `@@unique([userId, eventKey])` — **per owner, not global**:

```
User A  +  "amazon|OA|2026-08-20"   ─┐
                                     ├─ two valid, independent rows
User B  +  "amazon|OA|2026-08-20"   ─┘
```

Two students receiving the same placement broadcast produce the *same* key and must still
hold two distinct Events. `createEvent` scopes both the lookup and the recovery re-read by
owner, so one user's Event is never returned to another. This is asserted by a dedicated
regression test.

🕘 The key was globally unique until the ownership migration
(`20260802030000_require_ownership`), which dropped `Event_eventKey_key` and created
`Event_userId_eventKey_key`. Under the old index the second student to receive a broadcast
collided with the first and was handed back **another person's Event**.

---

## 4a. Derived state — the consistency problem that was designed away

**Problem.** The dashboard needs to know whether a round is still ahead of the student or
already gone. Time moves; the database does not.

**Naive.** Store it. Add an `isExpired` boolean or a `temporalStatus` column and keep it
current.

**Fails.** A stored answer to a question about *now* is wrong the moment "now" moves. It
needs a background job to sweep and update rows, that job is another thing that can be down
or lagging, and every row it has not reached yet is silently stale — in a system whose whole
premise is that the user trusts it enough not to double-check.

**Code.** Nothing is stored. `classifyTemporalStatus(event, now)` is a pure function, and
`getEventsService` attaches its result on the way out.

```
STORED FACTS  (authoritative, in the database)
   date              DateTime   — UTC midnight standing in for a calendar day
   time              String?    — as extracted, e.g. "14:30"
   isTimeEstimated   Boolean    — was that time inferred from a vague phrase?
        │
        │  classifyTemporalStatus(event, now)      pure, no I/O
        ▼
DERIVED STATE  (computed per read, never persisted)
   temporalStatus    "upcoming" | "expired"
```

**There is no `temporalStatus` column.** It does not appear in the Prisma schema, no
migration creates it, and nothing writes it. It exists only on the object the read path
returns.

**The consequence to say out loud:** *the same row can be `upcoming` on one request and
`expired` on the next, with no write in between.* That is the correct behaviour, not a bug —
the Event did not change; the clock did. And it means there is no cache to invalidate, no
sweep job to keep running, and no row that can be stale.

**No background job maintains this.** There is no expiry sweeper anywhere in the codebase.

### How the classification actually works

Two rules, and which one applies depends on whether the Event has a time worth trusting:

| Case | Expiry rule |
|---|---|
| **Reliably timed** — `time` present, **not** estimated, and matching `HH:MM` | Expired once `now >= the scheduled instant`. The event has begun, so it is no longer something to be reminded is coming |
| **Everything else** | Expired once its **IST calendar day has ended**, so a date-only Event stays upcoming for the whole day |

**A guessed time must not expire anything.** `isTimeEstimated` marks a time the extractor
inferred from a vague phrase — "morning" may have become `09:30`. Treating that as the
moment the event starts would hide a real event on the strength of a guess. An unparseable
time is handled the same way and for the same reason: absence of a usable clock value is
never evidence that the event is over. Both fall back to the whole-day rule.

**Boundary behaviour, exactly as the code has it:**

- **`now` exactly at the scheduled instant** → **expired**. The comparison is `>=`.
- **Date-only, today** → **upcoming**, all day. The comparison is `<` on IST day keys.
- **Timezone** — the day is recovered in IST before the time is attached. Combining the raw
  UTC instant with the time would shift the day for every event between 00:00 and 05:30 IST.
- **Missing date** — not a case. `date` is non-nullable, and the viability gate refuses an
  observation without one long before an Event exists.
- There is no start/end pair. An Event has one instant, not an interval, so there is no
  "ongoing" state and no equal-start-and-end case.

**One `now` classifies a whole list.** It is a parameter rather than read inside the
function, so two Events either side of a boundary can never be judged against different
instants within a single response.

**Where it is attached:** the list read (`getEventsService`) only. `getEventByIdService`
returns the stored row without it. Worth knowing before assuming every Event-shaped object
in the system carries the field.

---

## 5. Partial-update protection

**Problem.** Most emails are partial. "Amazon OA on 20th Aug" mentions no time and no venue.

**Naive.** `update({ data: extractedObject })`.

**Fails.** `time: null` and `venue: null` are written, destroying values a previous email
set correctly. This actually happened.

**Code.** `detectChanges` produces a list of changed fields, and only those fields are put
into `updateData`:
```ts
if (changes.some(c => c.field === "time")) updateData.time = incoming.time;
```
plus, inside `detectChanges`, time only counts as a change when `incoming.time` is neither
`undefined` nor `null`.

**Why it works.** A field the email never spoke about is **not in the update payload at
all**. It can't be blanked by accident, because there's no code path that writes it.

---

## 6. Intent-aware nulls

**Problem.** Sometimes an email *does* speak about a field and the correct outcome *is* to
clear it — `"Venue: will be shared after the PPT"`.

**Naive.** Both cases produce `null`, so you either always overwrite (destroying data) or
never overwrite (leaving stale data forever). You cannot have both.

**Fails.** You have to pick one wrong behaviour.

**Code.** Carry the intent alongside the value:
```ts
type VenueMeta = { value: string | null; isExplicit: boolean };
```
`isExplicit: true, value: null` = "the email spoke about venue, and there isn't one" → clear.
`isExplicit: false` = silence → preserve.

**Why it works.** The information was being *lost at the extraction boundary*. Once the type
can carry it, the decision layer can act on it. **When you can't distinguish two cases, the
problem is usually the representation, not the logic.**

Same shape as the identity gate's `AGREES / UNKNOWN / CONTRADICTS`. Point that out.

---

## 7. Confidence-aware updates (highest trust wins, not last write)

**Problem.** Every write is an inference, and inferences vary in quality.

**Naive.** Last write wins.

**Fails.** A later email saying "sometime next week" overwrites an exact date from an earlier
one. And since emails arrive out of order, "later" is arbitrary anyway.

**Code.**
```ts
if (newConfidence < existingConfidence) return existing;
```
plus the admission gate (`confidence < 0.6` → don't touch anything, create a review event)
and the manual-authority guard (`status === "confirmed"` → never overwrite).

**Why it works.** It replaces a temporal ordering with a quality ordering. **And it buys
order-independence for free:** a weak late arrival is rejected on its merits, not because of
when it arrived — so the final state doesn't depend on job scheduling.

Note `<` and not `<=`: equal confidence *does* update, because two automated inferences of
equal quality should let the newer one through. Only *worse* information is refused.

---

## 8. Manual authority is categorical

**Problem.** A human fixes an event in the review queue. Then another automated email arrives
about it.

**Naive.** Give manual confirmation confidence `1.0` and let the existing comparator handle
it.

**Fails.** A maximally confident *extraction* also reaches `1.0`, and `1.0 < 1.0` is false —
so the automated update goes through and silently undoes the human's fix. Tightening the
comparator to `<=` would express the intent as a numeric coincidence, *and* would break
equal-confidence automated updates, which is unrelated behaviour.

**Code.** A guard on **status**, checked before anything else:
```ts
if (existing.status === "confirmed") return existing;
```
`updateEventManuallyService` (the human path) is deliberately unaffected.

**Why it works.** **Authority is a kind, not a quantity.** Encoding a categorical fact as a
number and hoping the comparison works out is exactly the mistake ADR-006 is about — this is
the same lesson in the update layer.

---

## 9. Atomic update + audit

**Problem.** An update is two writes: N audit rows and one event row.

**Naive.** Two independent statements.

**Fails.** Two ways, one much worse than the other:
- audit lands, event fails → history claims a change that didn't happen
- event lands, audit fails → **an event whose values moved with no record of why**

**Code.** `prisma.$transaction(async tx => { ...create updates...; return tx.event.update(...) })`

**Why it works.** They're one business action, so they get one atomic unit. Either the event
moved and can explain itself, or nothing moved.

**Follow-up you'll get:** *"What isolation level? What about a concurrent update to the same
event?"* Honest answer: Postgres default, Read Committed, and there's no row lock or optimistic
version check. Two concurrent updates to the same event could interleave — last commit wins on
the row, but **both** audit rows are still written, so the history is complete even if the
final value isn't the one you'd predict. At one email at a time per event this hasn't
occurred; the fix would be `SELECT ... FOR UPDATE` on the event inside the transaction, or a
`version` column with an optimistic check.

---

## 10. Ownership derivation — never trust the channel

**Problem.** A worker needs to know who owns the work it's doing.

**Naive.** Put `userId` in the job payload and use it.

**Fails.** **A queue is not an authenticated channel.** Anything that can reach Redis can
enqueue a job. A `userId` in a payload is a *claim*, and claims get checked, not trusted.

**Code.** Two roots, deliberately unscoped, each documented as such:
- `getEmailById(id)` — the email worker reads the row and takes `userId` off it
- `getAttachmentById(id)` — same, for attachments

Then:
```ts
const owner: OwnershipContext = { userId: email.userId };

if (claimedUserId !== undefined && claimedUserId !== email.userId) {
  throw new UnrecoverableError(`Ownership mismatch on email ${emailId}: ...`);
}
```

The attachment payload goes further: it carries **only** `{ attachmentId }`, and there's a
test that asserts it has no `userId` — because a claim sitting next to the authoritative
answer is a second, weaker source of truth.

**Why it works.** One derivation, one place, one answer per job. The payload's `userId` isn't
removed entirely — it's kept purely so a *disagreement is detectable*, and a disagreement is
treated as unrecoverable (no retry can fix a forged payload or a broken invariant).

**Why the roots are safe despite being unscoped:** neither is reachable from an HTTP request.
Their only callers are workers, keyed by an id from a job the system enqueued itself.
Requiring an owner there would be circular — the caller would have to already know the answer
the call exists to provide.

---

## 11. Tenant scoping at the persistence boundary

**Problem.** Once there's more than one user, every query is a potential leak.

**Naive.** Check ownership in the controller.

**Fails.** It's a check you have to remember, in every handler, forever. The one you forget
is the bug.

**Code.** Three reinforcing layers:

1. **An explicit parameter type.** `TenantContext` is threaded as a required argument, never
   read from ambient state:
   > *"A service that takes a TenantContext cannot be called without one, while a service
   > that reaches for ambient state compiles and runs identically whether or not the state
   > was set — and that indistinguishability is precisely what makes tenant bugs invisible."*

2. **Scoped queries.** Reads use `findFirst({ where: { id, userId } })` rather than
   `findUnique({ where: { id } })`. Writes use `updateMany({ where: { id, userId } })` — which
   returns `{ count: 0 }` on a refused cross-tenant write, so a refusal is **observable**
   rather than silent.

3. **Database constraints.** The composite foreign keys from [ch. 07](07-DATABASE-DESIGN.md).

**Why it works.** Ownership isn't a check that can be forgotten — it's the shape of the
query, and behind that, a constraint the database enforces regardless of what the code does.

**And the API contract matches:** `GET /event/:id` answers **404** both for "no such event"
and "not yours". A 403 would confirm the existence of a record the caller may not see, and
event ids are sequential and trivially enumerable.

---

## 11a. The dual-write gap, and the two sweeps that close it

**Problem.** A row is committed to PostgreSQL and *then* a job is added to Redis. The two
stores cannot share a transaction, so there is a window where the row exists and the job does
not. Nothing recovered that state: the Gmail dedupe short-circuits every replay of the
message, the sync watermark has already advanced past it, and a manually ingested email has
no Gmail message to replay at all. **The email was stored and never processed, with nothing
recording that anything had gone wrong.**

This is the classic dual-write problem. Name it as such — and be equally clear that the
proper fix (a transactional outbox: write the job intent into the same database transaction,
and relay it to Redis afterwards) is **not** what this codebase does.

**What it does instead:** two reconcilers, running on their own timers **inside the always-on
API process**.

| Sweep | Every | Selects | Bound |
|---|---|---|---|
| `reconcilePendingEmails` | 60 s | `processingStatus = pending` AND `createdAt < now − 5 min` | none |
| `reconcileOrphanedAttachments` | 60 s | `pending`/`processing`, **or** `completed` with `parsedAt` and `parsingError` both NULL, AND `createdAt < now − 15 min` | 100 rows |

Five design points, and each is a question an interviewer can pull on:

**1. They are deliberately blind to Redis.** No `getJob`, no `getJobCounts`, no
check-then-enqueue. A row stays `pending` until a worker picks it up, so a row whose enqueue
*succeeded* is indistinguishable from an orphan — and that is fine, because
`jobId: email-${id}` means BullMQ refuses a second `add` while a job with that id exists.
**Checking Redis first would race the exact window the check was meant to close**, and would
put a second, weaker answer beside the one the queue already enforces.

**2. They write nothing.** `processingStatus`, `parsedAt` and `parsingError` belong to the
worker. A row a sweep fails to enqueue is left exactly as it was, so it stays eligible for
the next pass — the only durable record that the work is still owed. A second writer would
make the lifecycle ambiguous.

**3. The cutoff is the caller's, never computed inside.** How long to wait before treating a
row as abandoned is a deployment decision — long enough to clear a normal backlog, short
enough to matter. The 15-minute attachment cutoff is deliberately longer than the 5-minute
email one: an email job is regex plus at most one API call; an attachment job is a Gmail
download plus a full PDF or spreadsheet parse, at concurrency 1.

**4. Getting the cutoff wrong is cheap in one direction only, and it is the safe one.** Too
short wastes a little Redis traffic (the duplicate collapses into the existing job); too long
delays recovery.

**5. The attachment sweep is batch-bounded and the email sweep is not**, and the asymmetry is
the point. An orphaned *email* requires a failed enqueue to exist at all, so that sweep
normally finds nothing. The attachment queue currently holds a standing backlog of
legitimately queued work — every row of which the recovery predicate deliberately
over-selects — so unbounded it would attempt one Redis round trip per backlogged row every
60 seconds. Rows beyond the bound stay eligible for the next sweep.

### The state the attachment sweep exists for

The third branch of its predicate — `completed` with both parse columns NULL — is the one
that could not be reached any other way:

```
markAttachmentCompleted   ← commits after the DOWNLOAD, before the parse
        ↓
   ✗ worker killed here
        ↓
row reads "completed", nothing parsed, removeOnComplete deleted the job
        ↓
the normal enqueue filter (getPendingAttachmentsByEmailId) excludes "completed"
        ↓
NOTHING can reach this row
```

The reconciler then applies one filter the query cannot: it asks the **parser registry**
whether this MIME type has a parser at all, and skips it if not. Without that, a completed
download with no parser — which `isSettled` already considers finished — would be enqueued,
no-op'd, completed, freeing the deterministic id, and re-selected on the very next sweep:
**unbounded churn, forever, growing with the corpus.** The registry answers it because the
registry is the single authority on MIME-to-parser routing; a MIME list in the recovery query
would be a second one, free to drift.

### The guarantee, stated exactly

> **At-least-once recovery with convergent effects.** Not exactly-once — that is not
> achievable across PostgreSQL and Redis, and it is not claimed anywhere in this repository.

Convergence comes from three things that already exist: `isSettled` makes a replay *resume*
rather than restart, `updateParsedResult` overwrites in place, and both
`saveDocumentIntelligence` and `createExtraction` are upserts on database-enforced unique
keys. **Two non-idempotent effects survive a duplicate run and are accepted:** a replay stores
the file under a fresh UUID, orphaning the previous one, and it repeats the Document
Intelligence call when `USE_AI=true`.

### What this does NOT recover

A job that exhausted its three attempts. `removeOnFail: false` retains the failed job
permanently — which is right, it keeps the evidence — but combined with a deterministic jobId
that means the job **occupies its own id forever**, so `add` is a silent no-op and no sweep
can revive it. `backend/scripts/recovery/retry-failed-attachments.ts` is the one-off tool that
closes this for attachments. There is no email equivalent. Volunteer this: it is the sharpest
follow-up available on this section.

---

## 12. Graceful, layered failure

**Problem.** Where should each failure stop?

**The rule the system follows:** *failures degrade to **staleness**, which is visible and
recoverable, never to **corruption**, which is neither.*

| Failure | Blast radius |
|---|---|
| One Gmail message fails to sync | That message. Counted, logged, loop continues. |
| One mailbox fails to sync | That mailbox. Its `historyId` isn't advanced, so the next run retries the same window. |
| The AI call fails | Nothing. Regex-only path, silently. |
| The AI returns an unsupported date | That field. Dropped, regex date used instead. |
| Extraction produces nothing viable | That email. Marked `ignored`. Event table untouched. |
| Confidence too low | Nothing existing. A review event is created. |
| Matching finds nothing | A duplicate event — the recoverable failure, chosen on purpose. |
| The update transaction fails | Nothing. Rolled back. |
| Attachment download fails | That attachment. The email and its event are already done. |
| Attachment parse fails | Only the parse columns. Download stays `completed`. |
| Redis unreachable at enqueue | That row's job. The row is committed and stays `pending` → recovered by the reconciler after its cutoff (§11a). |
| A required env var is missing at worker start | The whole process, on purpose. `assertWorkerEnv` prints the missing **names** — never values — and exits 1 before the Worker is constructed, because every alternative is a process that comes **up** and then misbehaves quietly. |
| The worker receives SIGTERM/SIGINT | Nothing in flight. It stops accepting jobs, **waits for the active job**, closes Redis and exits 0. Never `close(true)`, which would abandon the running job — the precise outcome the handler exists to prevent. |
| A worker-level error (lock lapse, failed reconnect) | Nothing. Logged as safe scalars and **not** a shutdown trigger: ioredis reconnects and BullMQ's stalled checker recovers a lapsed lock. Exiting would turn a recoverable blip into a restart. |
| The worker is interrupted **twice** mid-job | That job, permanently. `maxStalledCount` defaults to 1, so the second stall fails it — and `removeOnFail: false` then keeps its deterministic id occupied. **The one place a failure is not recoverable by any sweep.** |

**And crucially:** attachment processing runs *after* the email pipeline, so a failure in the
expensive, external, slow part can never affect the event that was already correctly derived.

---

## 13. The failure asymmetry — the philosophy behind all of it

Say this if you get a "how did you think about trade-offs" question:

> "The two ways recognition can fail aren't symmetric.
>
> A **duplicate** is visible, embarrassing, and one delete away from fixed.
>
> A **false merge** — two distinct rounds collapsed into one record — is invisible, entirely
> plausible-looking, and destroys the information you'd need to undo it. You can't recover
> the second round; there's no record it ever existed.
>
> So every threshold and every refusal in the system is set to fail toward the duplicate.
> And I tried to make that structural rather than arithmetic: bounded date windows, a
> uniqueness requirement at the weakest tier, a categorical veto that runs before any
> scoring, and field-level writes that can't collaterally blank an unrelated field. A
> threshold is a number a future retune quietly removes. A constraint isn't."
