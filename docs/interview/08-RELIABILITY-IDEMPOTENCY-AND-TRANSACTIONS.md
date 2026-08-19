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

The one non-idempotent write is `createExtraction` — reprocessing writes a second
`EmailExtraction` row. That's deliberate: it's an append-only log of *"the extractor was run
on this email and produced this"*, and a second run genuinely is a second event worth
recording.

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

**Problem.** Two jobs for the same round processed concurrently. Both call
`findByEventKey` → both get null → both insert.

**Naive.** Check-then-insert in the service. (This is exactly what `createEvent` does:
`findFirst`, then `create`.)

**Fails.** Classic TOCTOU. The window between the check and the insert is small but real.

**Code.** Two layers:
1. The `findFirst` fast path handles the common sequential case.
2. `@@unique([userId, eventKey])` makes the race *impossible to lose silently* — the second
   insert gets Prisma `P2002`, and the email worker catches it:
```ts
if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
  console.log("Duplicate event detected");
  return;    // success — do NOT retry
}
```

**Why it works.** The application-level check is an optimisation; the database constraint is
the guarantee. And treating `P2002` as *success* rather than *failure* is correct: the
desired end state — exactly one event — already exists. Retrying would just reproduce the
same violation three times before giving up.

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
