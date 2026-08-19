# 02 — Domain and Data Model

Source of truth: `backend/prisma/schema.prisma`. Everything here is ✅ **Current** unless
tagged otherwise.

---

## The six nouns, in plain English

### What is a **User**?
A person who signed in with Google. Identity is keyed on `googleSub` — Google's opaque,
immutable subject id — **never on email**, because a Workspace admin can rename or reassign
an email address to a different human. `email` has no unique constraint for exactly that
reason; it is display data, indexed only for lookup.

Also carries `publicId` (a UUID) — the only identifier allowed to leave the backend.
Internal `id` is a sequential int and stays internal.

### What is a **GmailAccount**?
A connected mailbox. Stores the mailbox address, the **refresh token**, and `historyId` —
the Gmail sync cursor. It does *not* store access tokens: those expire in an hour and can
always be re-minted from the refresh token. Store renewable credentials, not temporary ones.

One user can own several mailboxes. A mailbox belongs to exactly one user, and a reconnect
never transfers ownership to whoever authorized most recently.

### What is an **Email**?
One raw message that entered the system — subject, body, sender, plus `gmailMessageId` for
deduplication and `gmailAccountId` for provenance. It also carries its own processing
lifecycle: `pending → processing → completed | failed | ignored`, with a `failureReason`.

An Email is **evidence**, not truth. It is never edited by the pipeline.

`gmailAccountId` is nullable — emails from the manual `POST /email` route have no mailbox.

### What is an **EmailExtraction**?
What the extractor *read* out of one email, plus the confidence it assigned, plus the raw
text. Written on **every** processed email, including ones the pipeline then abandons.

Why a separate table? Because "what the system read" and "what the system believes" are
different facts and fail differently. When an event looks wrong, this table tells you
whether extraction was wrong or the decision was wrong. It is the debugging and analytics
layer.

### What is an **Event**?
The real-world placement round: company, stage, date, time, venue. This is the only thing
the user actually cares about, and the only thing that gets updated over time.

It also carries the machinery that makes it defensible:
- `eventKey` — the identity string `company|stage|date`
- `confidence` — how much the current values are trusted
- `status` — `scheduled | rescheduled | review | confirmed`
- `reviewReason` — why a human needs to look at it

### What is an **EventUpdate**?
One immutable audit row: `field`, `oldValue`, `newValue`, `updatedAt`. Written in the *same
transaction* as the change it describes, so an event can always explain how it reached its
current values. Never updated, only inserted.

### What is an **Attachment**?
Metadata about a file on an email — Gmail's attachment id, filename, MIME type, size. The
bytes are downloaded later by a separate worker and stored under an opaque UUID key
(`storagePath`). It carries a download lifecycle (`processingStatus`) and, separately,
parse results (`text`, `parsedData`, `parsedMetadata`, `parsedAt`, `parsingError`).

Those two are deliberately independent: a parse failure records `parsingError` but leaves
the download `completed`.

---

## Relationship diagram (only relations that exist in the schema)

```
                          ┌──────────┐
                          │   User   │  identity = googleSub
                          └────┬─────┘
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
 ┌──────────────┐        ┌──────────┐          ┌──────────────┐
 │ GmailAccount │        │  Email   │          │    Event     │
 │ refreshToken │───────►│          │          │  eventKey    │
 │ historyId    │  0..1  │          │          │  confidence  │
 └──────────────┘        └────┬─────┘          └──────┬───────┘
                              │                       │
                 ┌────────────┴────────────┐          ▼
                 ▼                         ▼   ┌──────────────┐
        ┌────────────────┐        ┌──────────┐ │ EventUpdate  │
        │   Attachment   │        │  Email   │ │ field/old/new│
        │  storagePath   │        │Extraction│ └──────────────┘
        └────────────────┘        └──────────┘
```

**Read this carefully — it's the thing interviewers probe:**

> There is **no foreign key between EmailExtraction (or Email) and Event.**

The connection between an email and the event it produced is **behavioural**, not
relational: the pipeline reads the email, matches, and writes the event. Nothing in the
database records "this event came from these emails."

Say that honestly. The natural follow-up is *"how would you add it?"* — answer: a join
table `event_emails(event_id, email_id, match_type, score)`, which was in the original
design (💭 designed, never built) and would also let you show provenance in the UI.

**Every child that has a tenant-scoped parent reaches it through a composite foreign key on
`(parentId, userId)`**, not just `parentId`:

| Child | Foreign key | Effect |
|---|---|---|
| `EventUpdate` | `(eventId, userId) → Event(id, userId)` | cascade delete |
| `Attachment` | `(emailId, userId) → Email(id, userId)` | cascade delete |
| `EmailExtraction` | `(emailId, userId) → Email(id, userId)` | cascade delete |
| `Email` | `(gmailAccountId, userId) → GmailAccount(id, userId)` | nullable → unchecked when NULL |

That makes "a child row whose owner differs from its parent's owner" **unrepresentable**,
not merely incorrect. More in [ch. 07](07-DATABASE-DESIGN.md).

---

## What prevents duplicates

Three different mechanisms, at three different levels. Know all three — this is a very
common question.

| Level | Mechanism | Prevents |
|---|---|---|
| **Ingestion** | `Email.gmailMessageId` is globally unique, and `syncSingleMessage` looks it up before inserting | The same Gmail message being ingested twice |
| **Identity** | `@@unique([userId, eventKey])` on Event | Two rows for the same company+round+date, per user |
| **Recognition** | The three-tier matcher | Two rows for the same round described *differently* (e.g. dates 1 day apart) |

The first two are database-enforced. The third is a judgement call, and is where all the
interesting engineering lives.

---

## What represents history vs current state

| Table | Role |
|---|---|
| `Email` | Immutable raw input. Never edited. |
| `EmailExtraction` | Immutable append-only record of what was read, per email. |
| `EventUpdate` | Immutable append-only record of every accepted change. |
| **`Event`** | **The only mutable row.** Current believed state. |
| `Attachment` | Mutable lifecycle columns; parse output written once. |

One sentence for the interview: *"Everything is append-only except the Event, and every
mutation of the Event writes its own audit row in the same transaction."*

---

## Ownership

Every tenant-scoped table carries `userId NOT NULL`. Ownership flows in one direction and
is never guessed:

```
Google identity  →  User
User             →  GmailAccount   (whoever authorized it)
GmailAccount     →  Email          (the mailbox that synced it)
Email            →  Attachment, EmailExtraction
Event            →  EventUpdate
```

For `Event` itself, the owner comes from the Email being processed, which came from the
mailbox. Manual `POST /email` takes the owner from the session.

Two functions are **deliberately unscoped** — `getEmailById` and `getAttachmentById`. They
are the *ownership derivation roots*: they are where the pipeline learns who owns a unit of
work. Requiring an owner there would be circular. They are safe because neither is
reachable from a request — their only callers are workers keyed by an id the system
enqueued itself. See `src/modules/email/email.repository.ts`.

---

## Important constraints and indexes (and why)

**Unique**
- `User.googleSub` — the authentication key
- `User.publicId` — external identifier
- `Event(userId, eventKey)` — identity, **per owner**. It was globally unique until AC-5.9;
  that was wrong, because two students receiving the same broadcast produce the same key
  and must still hold two distinct events.
- `Event(id, userId)`, `Email(id, userId)`, `GmailAccount(id, userId)` — these exist *only*
  as anchors so children can point at (parent, owner) together.
- `Email.gmailMessageId` — ingestion dedupe. Still **global**, not per-account. That is a
  known, documented compromise: scoping it to `(gmailAccountId, gmailMessageId)` requires
  `gmailAccountId` to be reliably populated, and rows predating account tracking have NULL.
- `GmailAccount.email` — one mailbox, one row.

**Indexes**
- `Event(userId, date)` — the dashboard's main read, and the matcher's date-window queries
- `Event(userId, status)` — the review queue
- `Email(userId, processingStatus)` — finding pending/failed emails
- `Email(userId, receivedAt)`, `Email(gmailAccountId)`, `EventUpdate(userId, eventId)`,
  `Attachment(emailId)`, `GmailAccount(userId)`, `User(email)`

Notice they're all **composite with `userId` first**. That's not decoration: every real
query is already tenant-scoped, so a leading `userId` is what makes the index usable.

---

## Enum: `MailProvider`

One value: `GOOGLE`. It is a discriminator, not an abstraction — there is no strategy
interface and no dispatch on it. It exists so integration code can *assert* the provider
instead of assuming it, and so a second provider wouldn't require renaming a table that
already carries foreign keys from three others.

---

## Things the old Notion docs describe that do NOT exist

Be ready for this — the old design doc is much bigger than the real schema.

| Table in old notes | Status |
|---|---|
| `companies` (normalized company names) | 💭 Future idea — company is a plain `String` on Event |
| `event_emails` (many-to-many email ↔ event) | 💭 Future idea — never built |
| `user_events` (applied / interested flags) | 💭 Future idea — never built |
| `role` (internship / full-time), `event_type`, `round` columns | 💭 Future idea — not in the schema |
| `mode` (virtual / offline) separate from venue | 💭 Future idea — only `venue` exists |
| Postgres trigger for `updated_at` | 🕘 Not used — Prisma's `@updatedAt` handles it |

**Known gap in the current schema (be honest if asked):** `Event.isTimeEstimated` exists as
a column and the frontend renders "(estimated)" from it — but the pipeline never writes it.
`createEvent` in `src/modules/event/event.repository.ts` doesn't set it, so it stays at its
`false` default. The flag *is* computed and *is* persisted on `EmailExtraction`. It just
never reaches the Event. A two-line fix, and a good answer to "what would you fix next?"
