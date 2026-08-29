# 07 — Database Design

Source of truth: `backend/prisma/schema.prisma` (**22 migrations** in
`backend/prisma/migrations/`, applied by hand from a workstation — no workflow or service
runs `prisma migrate deploy`). All ✅ **Current** unless tagged.

---

## Stack facts worth knowing

- **PostgreSQL 16**, local via `docker-compose.yml` (port 5435), **Neon** in production.
- **Prisma 7** with `@prisma/adapter-pg` over a `pg` connection pool
  (`src/lib/prisma.ts`).
- **Two connection strings**, and this is a real interview answer:

| Variable | Used by | Why |
|---|---|---|
| `DATABASE_URL` (**pooled**) | Prisma Client at runtime, via the adapter | Many short-lived queries across concurrent handlers — connection reuse is the point |
| `DIRECT_DATABASE_URL` (**unpooled**) | `prisma migrate` / `db` / `studio`, via `prisma.config.ts` | Migrate takes a **session-level advisory lock** to serialise concurrent deploys, and a transaction pooler (PgBouncer) can't hold one — it's acquired on one backend and released to another. Running DDL through a transaction pooler is unsafe for the same reason. |

> Prisma 7 removed `url` and `directUrl` from `schema.prisma` entirely (error P1012). So the
> split isn't expressed in the schema at all — it's expressed by *which side reads which
> variable*. That surprises people; it's a good detail to drop.

---

## The models, and what each one is for

| Model | Represents | Mutable? |
|---|---|---|
| `User` | A person, keyed on Google's `sub` | Profile refreshed on login |
| `GmailAccount` | A connected mailbox + refresh token + sync cursor | `refreshToken`, `historyId` |
| `Email` | One raw message + its processing lifecycle | status only |
| `EmailExtraction` | What was read out of one email + confidence | one row per email, **rewritten by a replay** (upsert, latest wins) |
| `Event` | The real-world round — the **only** thing users care about | **the only truly mutable row** |
| `EventUpdate` | One audit row per accepted field change | **append-only** |
| `Attachment` | File metadata + download lifecycle + parse output | lifecycle columns |
| `DocumentIntelligence` | What a parsed attachment **means** — classification, summary, and the event/participant facts it revealed | rewritten by a replay (upsert) |
| `StudentProfile` | Optional campus information about a User — currently a registration number, and nothing else | the one field |

Enum `MailProvider { GOOGLE }` — a discriminator so provider is *data*, not just the table's
name. No dispatch keys off it. `@default(GOOGLE)` exists so the expand migration needed no
backfill, and should be dropped if a second variant is ever added.

### Why `DocumentIntelligence` is its own table and not more columns on `Attachment`

Two separate reasons, and the first is the one worth leading with.

**They answer different questions.** `Attachment.text` / `parsedData` / `parsedMetadata`
record what a file *says*; this records what it *means*. Mixing them would put a model's
interpretation in the same row as the bytes it interpreted.

**`Attachment` is a hot row and Prisma selects every column by default.** It is read on every
processing job and in per-email list queries. `participantInformation` for a large shortlist
is sizeable, and it would be dragged into every one of those reads for no reason.

### Why `StudentProfile` is its own table and not columns on `User`

`User` is the **authentication identity**: it answers "who is signed in" and "who owns this
record". The product vision states it "does not model the student beyond the account" — no
course, branch, CGPA or placement-cell profile. Putting a campus attribute on `User` would
make the auth record start carrying institutional data and invite the rest to follow.
Keeping it separate makes that refusal **structural** rather than a convention.

And it is deliberately **not an identity and not a tenant key**. `User.id` remains the sole
ownership boundary. `registrationNumber` appears in no `eventKey`, no ownership predicate and
no tenant-scoping composite — it is information *about* a user, never a way of *finding*
their records. The shortlist lookup makes the distinction explicit: the tenant-scoped query
decides **which documents you may see**, and the registration number then decides **which of
those mention you**. A user with a wrong number sees fewer results, never someone else's
documents.

---

## Keys and constraints — each one, and the problem it solves

### `User.googleSub @unique`
**Problem:** what identifies a person?
Email is mutable — a Workspace admin can rename it, or reassign it to a different human.
Using it as an auth key means someone else can eventually inherit an account. `googleSub` is
opaque and immutable. `User.email` therefore has **no** unique constraint at all; it's
display data, indexed only for lookup.

### `User.publicId @unique @default(uuid())`
**Problem:** sequential integer ids leak information and are trivially enumerable.
`publicId` is the only identifier allowed to leave the backend. Internal `id` stays internal.

### `Event @@unique([userId, eventKey])`
**Problem:** two rows for the same round.
`eventKey = "company|stage|date"`. The unique index makes the identity claim a database
invariant, not a hope — a race between two workers ends with one `P2002` instead of two rows.

🕘 **This was `@@unique([eventKey])` — globally unique — until AC-5.9, and that was wrong.**
Two students receiving the *same* placement broadcast produce the *same* key. Under a global
constraint, the second student's create would silently resolve to the first student's event.
Scoping it per-owner is what makes multi-tenancy actually work.

### Composite anchors: `Event(id, userId)`, `Email(id, userId)`, `GmailAccount(id, userId)`
**Problem:** a child row that claims a different owner than its parent.
These unique indexes exist *only* so children can point at `(parent, owner)` as a pair.

### Composite foreign keys — the strongest idea in the schema
```
EventUpdate      (eventId,        userId) → Event(id, userId)          ON DELETE CASCADE
Attachment       (emailId,        userId) → Email(id, userId)          ON DELETE CASCADE
EmailExtraction  (emailId,        userId) → Email(id, userId)          ON DELETE CASCADE
Email            (gmailAccountId, userId) → GmailAccount(id, userId)   nullable
```

**Say it like this:**
> "A child row whose owner disagrees with its parent's owner isn't just incorrect — it's
> **unrepresentable.** Postgres rejects the insert. That's a different class of guarantee
> from 'the service layer remembers to check.'"

There's a nice side effect. In `createEmail`, `Attachment.userId` is **never written by
application code** — because both columns are relation scalars of the `email` relation,
Prisma fills them from the parent it just inserted. Passing `userId` explicitly is now
rejected as an unknown argument. The constraint didn't just validate the invariant; it
removed the code that could violate it.

`Email.gmailAccountId` stays nullable (manual `POST /email` has no mailbox), so its FK is
`MATCH SIMPLE`: a NULL leaves the constraint unchecked for that row, which is exactly right.

### `EmailExtraction @@unique([emailId, userId])` and `DocumentIntelligence @@unique([attachmentId, userId])`
**Problem:** the worker is replayed whenever it dies holding its BullMQ lock, and the insert
runs a second time.

A deterministic BullMQ jobId prevents a duplicate *job*; it says nothing about side effects a
job already committed, **because Redis cannot know what PostgreSQL did**. And an
application-side guard does not close it either: a `findFirst` before `create` is two
statements with a window between them, and it would appear to work only for as long as
concurrency stays at 1 — which is a scheduling accident, not an invariant.

So both writes are **upserts resolved on these constraints**, and the constraint holds
regardless of worker count, host restarts, or stalled-job overlap.

**Composite with `userId` rather than keyed on the parent alone**, and that is not decoration:
the relations are themselves composite, and keyed on `emailId` alone one tenant's replay could
address another tenant's row.

**Latest wins, deliberately** — and the update branch therefore sends explicit `null`s rather
than the input's `undefined`. Prisma reads `undefined` as "leave this column alone", which
would let a replay that extracted *less* silently retain a stale value from the previous
attempt, leaving the row describing **neither** run. With `USE_AI=true` extraction is
nondeterministic, so a replay can legitimately produce a different answer; the row should
describe the attempt that actually completed.

### `StudentProfile.registrationNumber @unique`, nullable
**Problem:** one number identifies one student — but only in one institution, and not every
student has one.

**Nullable**, because a profile may exist before the number is known and a user may never
supply one at all (off-campus opportunities carry none). PostgreSQL treats NULLs as distinct
in a unique index, so any number of profiles may hold NULL simultaneously; the constraint
binds only real values.

**Unique**, because this deployment serves a single college. State that limit out loud: it is
a property of *this deployment*, not a law of the domain, and it would not survive a second
institution. Widening it is a deliberate future change, not something to pre-build.

**Stored exactly as typed**, minus surrounding whitespace. There is deliberately no format
validation — a registration number is issued by an institution in whatever shape that
institution uses, and a format rule here would encode one college's convention as a
correctness property and refuse a student whose number is perfectly valid. An empty string
collapses to NULL, because otherwise both `""` and NULL would mean "absent" and only one of
them would be excluded from the unique index.

### `Email.gmailMessageId @unique`
**Problem:** ingesting the same Gmail message twice.
Still **globally** unique, not per-account. That's a documented compromise, not an oversight:
scoping it to `(gmailAccountId, gmailMessageId)` requires `gmailAccountId` to be reliably
populated, and rows predating account tracking have NULL there. Re-scoping before those rows
are resolved would re-ingest them.

Practical consequence: if two users are both on a TPO mailing list and both connect their
mailboxes, they get *different* Gmail message ids (each mailbox assigns its own), so this
doesn't actually collide across users. Worth knowing if pressed.

### `GmailAccount.email @unique`
One mailbox, one row. Combined with the read-then-write in `connectGmailAccount`, a reconnect
refreshes the token but never transfers ownership.

---

### `GmailAccount.reauthRequiredAt` — nullable timestamp, not a boolean
**Problem:** Google refuses a refresh token permanently (HTTP 400 `invalid_grant`), which its
documentation says requires the user to authenticate and consent again. Presenting the same
token cannot succeed.

So the background scheduler must skip that mailbox until a reconnect clears it — while an
explicit, user-triggered sync may still attempt it.

**Nullable rather than a status enum:** existing rows need no backfill, and the timestamp
records *when* authentication broke, which a boolean would lose. NULL means "eligible for
automatic sync". The token itself is **left in place** — Google has already invalidated it, so
deleting it protects nothing and only makes reconnect harder to reason about.

---

## Indexes — and why they're all composite

```
User            (email)
Event           (userId, date)      (userId, status)
Email           (userId, receivedAt)  (userId, processingStatus)  (gmailAccountId)
EventUpdate     (userId, eventId)
Attachment      (emailId)
GmailAccount    (userId)
```

**`userId` comes first in every composite index.** That's not stylistic. Every real query in
the system is already tenant-scoped — `WHERE userId = ? AND date BETWEEN ...` — so a
leading `userId` is what makes the index usable at all. An index on `(date)` alone would be
scanned across every tenant and then filtered.

Mapped to actual queries:

| Index | Serves |
|---|---|
| `Event(userId, date)` | `findNearbyEvents` / `findByCompanyAndStage` — the matcher's ±3d and ±30d windows; and the dashboard's date sort |
| `Event(userId, status)` | `GET /event?status=review` — the review queue |
| `Email(userId, processingStatus)` | pending / failed backlog queries |
| `Attachment(emailId)` | `getPendingAttachmentsByEmailId` when fanning out jobs |

**What's missing (honest):** there's no index on `Event(userId, company)`, yet
`findNearbyEvents` filters on `company` *and* a date range. Postgres will use the
`(userId, date)` index and filter company in memory. At this data volume that's irrelevant;
at scale I'd add `(userId, company, date)`. That's a good thing to volunteer when asked
"what would you optimise?"

---

## Transactions

**One place uses an explicit transaction:** `updateEventService`.

```ts
prisma.$transaction(async (tx) => {
  for (const change of changes) await tx.eventUpdate.create({ ... });
  return tx.event.update({ where: { id: eventId }, data: { ...updateData, confidence } });
});
```

**The problem it solves:** without it, two independent writes. Either
- the audit rows land and the event update fails → history claims a change that never
  happened, or
- the event updates and the audit insert fails → an event whose values moved with no record
  of why.

The second one is worse: an event that cannot explain itself. The domain doesn't permit
that, so the two writes are one business action and get one transaction.

**One place uses an implicit transaction:** `createEmail`'s nested create writes the Email
and all its Attachment rows atomically.

**Deliberately *not* in a transaction:** the OAuth callback's two writes (upsert User, then
link GmailAccount). Both are idempotent, and the only observable interleaving is "a User
exists with no mailbox linked" — which is a legitimate state anyway, since a user may own
zero mailboxes.

---

## Cascade behaviour

```
User          → GmailAccount   ON DELETE CASCADE
Email         → Attachment     ON DELETE CASCADE
Email         → EmailExtraction ON DELETE CASCADE
Event         → EventUpdate    ON DELETE CASCADE
```

`User → Email` and `User → Event` are **not** cascading. So deleting a user isn't a single
`DELETE`. That's consistent with the soft-delete design (`User.status`, `User.deletedAt`) —
`requireAuth` refuses a session whose user is deleted or non-active, so an account is
disabled rather than erased. Full account deletion is a separate, ordered procedure, not a
foreign key.

---

## Dates and timezones — the trap

**Three functions in `src/shared/utils/date.ts`:**

```ts
toUTCDate("2026-08-20")  → new Date(Date.UTC(2026, 7, 20))   // UTC midnight
toISTKey(date)           → date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
formatDateISTKey(date)   → manual +5:30 offset then slice     // ⚠ not used by the pipeline
```

**The design:**
- `Event.date` is a **calendar date**, stored as UTC midnight. It carries no clock time —
  the real time lives in the separate `time` string column.
- **Comparison happens on IST calendar keys**, not raw timestamps. `detectChanges` does
  `toISTKey(existing.date) !== toISTKey(toUTCDate(incoming.date))`.

**Why:** the users are in India. "20 August" means 20 August in IST. Comparing raw UTC
timestamps meant a date that was the same day for a human looked different to the system,
and the reverse. Normalising both sides to an IST calendar key before comparing makes the
comparison mean what a human means.

**And the frontend has the matching rule:** `formatDateTime` in `client/src/lib/eventDisplay.ts`
formats the date with `timeZone: "UTC"` explicitly. Reading UTC midnight in the viewer's zone
rolls the day backwards for anyone west of UTC, and makes midnight look like a real clock
time (05:30 in IST). The time is parsed as *text*, never through a `Date`, so no timezone
conversion can reach it.

One-line version: **store UTC, compare in IST, render in UTC, and never let a clock time
enter the date column.**

---

## Migration history — the shape of the story

18 migrations. The interesting arc is the last four:

| Migration | What it did |
|---|---|
| `20260802000000_add_user_model` | Add `User` |
| `20260802010000_add_user_ownership_columns` | Add **nullable** `userId` everywhere + relations |
| `20260802020000_backfill_ownership` | **Data only, no DDL** — fill every `userId` |
| `20260802030000_require_ownership` | `SET NOT NULL`, add composite anchors + composite FKs, replace the global `eventKey` unique with `(userId, eventKey)` |

**This is a textbook expand → backfill → contract migration**, and it's worth being able to
describe:

1. **Expand:** add the column as nullable so old and new code both work.
2. **Backfill:** fill it in a separate migration containing no DDL, so schema and data can be
   reasoned about, replayed, or rolled back independently.
3. **Contract:** make it mandatory once every row satisfies it.

Two constraints shaped the backfill, and they're good to mention:
- **Prisma replays the whole chain against an empty shadow database** to detect drift. So a
  data migration that *requires* data can't survive that replay — "nothing to backfill" has
  to be success, not an error.
- **The migration supplies its own owner.** It never waits for a real user to exist (a
  migration engine can't cause someone to complete OAuth). Rows derivable from a parent
  follow their parent exactly; root rows get a clearly-marked legacy owner.

There's also a supporting toolchain in `backend/scripts/migration/` — `migration:verify`,
`migration:cleanup`, `migration:claim` — for verifying and for claiming legacy data into a
real account after the fact.

---

## Design choices, each stated as a problem

| Choice | Problem it solves |
|---|---|
| `company` as plain `String`, no `companies` table | Premature normalisation. A companies table needs canonicalisation ("NVIDIA" / "Nvidia" / "NVIDIA Corp") — a whole subproblem. Consequence I accept: `findNearbyEvents` matches company **exactly** and case-sensitively; it works because extraction lowercases the whole body first. 💭 The `companies` table is in the old design notes and was never built. |
| `time` as `String` ("HH:MM"), not a SQL `TIME` | The date column is a calendar date; putting a clock time in a timestamp makes it timezone-sensitive again. A string is unambiguous, and `null` cleanly means "no time given". |
| `venue` as free text | Venues are `"tpo"`, `"hackerrank"`, `"nlhc 1"` — no useful closed set. 💭 Splitting `mode` (online/offline) from `venue` is in the notes, not built. |
| `status` as `String`, not an enum | Prisma enum changes are migrations; statuses were still moving. Values in use: `scheduled`, `rescheduled`, `review`, `confirmed`. |
| `eventKey` as a string column, not a DB-computed identity | It's generated in one function (`generateEventKey`) and it must be **rewritable** — a reschedule regenerates it. A generated column couldn't be rewritten independently of the date. |
| `EmailExtraction` separate from `Event` | "What was read" and "what is believed" are different facts that fail differently. Keeping both lets you tell an extraction bug from a decision bug. |
| Soft delete (`status`, `deletedAt`) on User | Hard-deleting a user with events and emails is a cascade you don't want to run by accident; and `requireAuth` re-reads the user on every request, so a disable takes effect on the *next request*, not the next login. |

**One dead column to know about:** `EmailExtraction.status` is nullable and the pipeline
never writes it — `getExtractionStatus()` computes `complete | partial | failed` but the
value isn't passed to `createExtraction`. Similarly `Event.isTimeEstimated` is never written
by the pipeline (see [ch. 02](02-DOMAIN-AND-DATA-MODEL.md)). Both are small, real gaps.
