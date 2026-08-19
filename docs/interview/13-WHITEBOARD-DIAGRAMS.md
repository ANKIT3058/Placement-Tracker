# 13 — Whiteboard Diagrams

Eight diagrams you can reproduce on paper in 1–2 minutes. For each: **what to draw**, **what
each box means**, **what to say while drawing it**.

Rule for all of them: **draw and talk at the same time.** Silence while drawing is dead air.

---

## 1. High-level architecture

### What to draw
```
   Browser (React)
        │  /api
        ▼
   ┌──────────────────────────┐
   │  API  (Express)          │───► Gmail scheduler (every 2 min)
   │  auth · events · sync    │
   └───────┬──────────────────┘
           │ enqueue
           ▼
   ┌─────────────┐     ┌──────────────────┐
   │ email queue │     │ attachment queue │   BullMQ / Redis
   └──────┬──────┘     └────────┬─────────┘
          ▼                     ▼
   ┌─────────────┐     ┌──────────────────┐
   │ email worker│────►│attachment worker │
   └──────┬──────┘ after└───────┬─────────┘
          │        success      │
          ▼                     ▼
       ┌──────────────────────────┐
       │       PostgreSQL         │
       └──────────────────────────┘

   external: Gmail API · OpenAI (optional)
```

### What each box means
- **API** — HTTP, sessions, and the sync scheduler. Owns no pipeline logic.
- **Queues** — durability + retries + burst absorption.
- **Email worker** — the whole interpret → recognise → decide pipeline.
- **Attachment worker** — download and parse, kept off the critical path.

### What to say
> "Three processes. The API handles HTTP and also runs the Gmail scheduler in-process. Two
> BullMQ workers do the actual work. The arrow between the workers is important — attachments
> are only enqueued *after* the email has been processed successfully, so a failed email
> doesn't download anything."

---

## 2. Gmail synchronization

### What to draw
```
   scheduler (every 2 min)
        │
        ▼
   for each connected mailbox (sequential)
        │
        ├── no historyId? ────► FULL SYNC
        │                        1. capture watermark  ◄── BEFORE listing
        │                        2. list last 100 messages
        │
        └── has historyId? ───► INCREMENTAL
                                 history.list(startHistoryId)
                                        │
                                   404? ─┴──► fall back to FULL SYNC
        │
        ▼
   for each message id
        │
        ├── gmailMessageId exists? ──► skip (duplicate)
        │
        └── fetch → parse MIME → save Email + attachment metadata → enqueue
        │
        ▼
   write the new historyId
```

### What each box means
- **historyId** — Gmail's per-mailbox cursor. Missing means "never synced."
- **watermark before listing** — the ordering that makes the failure safe.
- **duplicate check** — the unique `gmailMessageId`.

### What to say
> "Each mailbox has its own cursor and syncs independently, sequentially, so one failure never
> aborts the others. The detail I'd point out is capturing the watermark *before* listing. If
> you capture it after, a message arriving during the listing gets a history id below the new
> cursor and is never seen again. Capturing first means it's re-fetched next run — and
> re-fetching is free, because dedupe catches it. **Overlap is safe; gaps are not.**"

---

## 3. Email processing pipeline

### What to draw
```
   Email row (saved)
        │
        ▼
   [ CLEAN ]     cut quoted reply chains, collapse whitespace
        │
        ▼
   [ EXTRACT ]   regex  +  optional LLM   → merged field by field
        │                                   AI dates validated against source
        ▼
   [ CONFIDENCE ]  weighted score, 0–1
        │
        ▼
   save EmailExtraction   ◄── always, even if we abandon below
        │
        ▼
   [ VIABILITY GATE ]  no real company OR no full date ──► email = "ignored"  ■ STOP
        │
        ▼
   [ MATCH ] ──► [ DECIDE ] ──► create | update | review
        │
        ▼
   enqueue attachments
```

### What each box means
- **Clean** — separates *this* message from the thread below it.
- **Extract** — five fields; two independent sources merged.
- **Viability gate** — an observation with no identity anchor can't be reasoned about.
- **EmailExtraction saved before the gate** — so you can debug what was read even for
  abandoned emails.

### What to say
> "Clean first, and that's not cosmetic — a reply carries the whole thread, and those quoted
> dates are real dates belonging to *other* events. I had an event land on a date that
> appeared nowhere in the message anyone actually sent.
>
> Then extract, score, and record. The extraction row is written even when we abandon,
> because when something looks wrong I need to tell an extraction bug from a decision bug.
>
> Then the gate. Extraction substitutes the literal string 'unknown' when it can't find a
> company — and that string is truthy, so it once passed a truthiness check, created an event
> literally named 'unknown', and that event became a matching candidate for every later
> unresolved email."

---

## 4. Extraction → Matching → Decision

**The most important diagram. Practise this one.**

### What to draw
```
                     { company, stage, date, time, venue, confidence }
                                        │
   ═══════ RECOGNITION ═══════════════════════════════════════════
                                        │
   TIER 1   exact key  "company|stage|date" ──── hit ──► MATCH (1.0)
                                        │ miss
   TIER 2   same company, ±3 days
              │
              ├─ IDENTITY GATE (categorical) ──────────────┐
              │    AGREES     → eligible                   │
              │    UNKNOWN    → eligible                   │  CONTRADICTS
              │    CONTRADICTS→ ✖ VETOED, never scored     │      │
              │                                            │      ▼
              └─ SCORE eligible only:                      │   dropped
                   0.5·date + 0.3·stage + 0.2·min(conf)    │
                   best ≥ 0.5 ──► MATCH                    │
                                        │ miss
   TIER 3   same company + stage, ±30 days
              exactly 1 candidate ──► MATCH (0.6)
                                        │ miss
                                     NO MATCH
   ═══════ DECISION ══════════════════════════════════════════════
                                        │
        confidence < 0.6 ──────────────►  create Event, status "review"
        match found      ──────────────►  guarded update + audit row (1 txn)
        no match         ──────────────►  create Event, status "scheduled"
```

### What each box means
- **Tier 1** — all three identity attributes agree. Nothing to judge.
- **Identity gate** — categorical admission. Runs to completion *before* any scoring.
- **Score** — ranks survivors. Has no authority to admit.
- **Tier 3** — identity from uniqueness alone, hence the bound.

### What to say
> "Three tiers of decreasing evidential strength, stopping at the first sufficient answer.
>
> The part I'd emphasise is tier two, and specifically the order. The gate runs to completion
> before any scoring. Originally there was one weighted score deciding both *whether* a
> candidate was the same event and *which* candidate to pick — and the date term alone was
> worth exactly the acceptance threshold. So same company, same date, different round was
> accepted: a morning PPT and an afternoon test merged into one row.
>
> That's representational, not a mis-tuned constant. A weighted sum of non-negative terms is
> monotone — every term can only push the score up, so nothing can veto. A contradicted round
> contributed zero, which means *no support*, and the function had no way to say *evidence
> against*.
>
> Tier three is bounded for a similar reason. Its whole identity claim is 'there's exactly one
> candidate' — and uniqueness is only meaningful inside a plausible range. Unbounded, a
> company's first OA is trivially unique, so the tier fired most confidently exactly where it
> had the least evidence."

---

## 5. Database relationships

### What to draw
```
                    ┌────────┐
                    │  User  │   googleSub (unique)
                    └───┬────┘
          ┌─────────────┼─────────────────┐
          ▼             ▼                 ▼
  ┌──────────────┐  ┌───────┐      ┌─────────────┐
  │ GmailAccount │─►│ Email │      │    Event    │  @@unique(userId, eventKey)
  │ refreshToken │  │       │      │  confidence │
  │ historyId    │  │       │      │  status     │
  └──────────────┘  └───┬───┘      └──────┬──────┘
                        │                 │
              ┌─────────┴────────┐        ▼
              ▼                  ▼   ┌─────────────┐
     ┌────────────────┐   ┌──────────┴──┐  EventUpdate│
     │   Attachment   │   │EmailExtractn│  field
     └────────────────┘   └─────────────┘  old → new

   NOTE:  no FK between Email/EmailExtraction and Event
          the link is behavioural (the pipeline), not relational
```

### What each box means
- Left branch = **evidence** (append-only). Right branch = **belief** (mutable) + its history.
- Every child FK is composite: `(parentId, userId)`.

### What to say
> "Two branches from User. Evidence on the left — mailbox, emails, attachments, extractions —
> all append-only. Belief on the right — the Event, which is the only genuinely mutable row —
> plus its audit trail.
>
> I'd point out the gap deliberately: there's no foreign key between an Email and the Event it
> produced. The link is behavioural, not relational. If I wanted provenance in the UI I'd add
> an `event_emails` join table.
>
> And every child foreign key is composite — `(emailId, userId)` referencing `Email(id,
> userId)`. That makes a child disagreeing with its parent's owner *unrepresentable*, not just
> incorrect. Postgres rejects the insert."

---

## 6. Queue and worker architecture

### What to draw
```
   producers                    Redis (BullMQ)                consumers

   Gmail sync ────┐
                  ├──► email-processing ──────────► email worker
   POST /email ───┘      { emailId, userId }             │
                         attempts: 3, exp backoff        │ on success
                                                         ▼
                         attachment-processing ◄────  fan out
                         { attachmentId }                 │
                         jobId: attachment-<id>           ▼
                                                  attachment worker

   failure paths:
     any throw        → markFailed(reason) → rethrow → retry ×3 → failed set
     P2002 duplicate  → swallow, return success (no retry)
     owner mismatch   → UnrecoverableError (no retry)
```

### What each box means
- **`{ emailId, userId }`** — the `userId` is a *hint*, cross-checked, never trusted.
- **`{ attachmentId }`** — carries nothing else, on purpose.
- **`jobId: attachment-<id>`** — deterministic, so the enqueue is idempotent.

### What to say
> "Two queues because the work has different characteristics — attachments download big files
> and parse PDFs, and I don't want a 10 MB PDF blocking emails behind it.
>
> The payloads are the interesting bit. A queue isn't an authenticated channel — anything with
> Redis access can enqueue a job — so a `userId` in a payload is a *claim*. The worker derives
> the real owner from the persisted row. The email payload carries the claim anyway, purely so
> a disagreement is detectable, and a mismatch fails permanently because no retry fixes a
> forged payload. The attachment payload carries only the id, and there's a test asserting
> that.
>
> Two failures deliberately aren't retried: a unique-constraint violation, because the desired
> end state already exists, and an ownership mismatch, because it's not transient."

---

## 7. Attachment processing

### What to draw
```
   Gmail sync
      collect metadata only  (filename, mimeType, gmailAttachmentId)
      │  saved WITH the Email, one transaction
      ▼
   ── email job succeeds ──
      │
      ▼
   enqueue (skip already-completed)
      │
      ▼
   DocumentProcessingService.process(id)
      │
      ├─ load attachment + email + gmailAccount   (one query)
      ├─ already completed? → return               ◄── idempotent
      ├─ derive owner from the row
      ├─ resolve refreshToken: Attachment → Email → GmailAccount
      ├─ DOWNLOAD ──fail──► markFailed + RETHROW    (retryable)
      ├─ store under randomUUID + ext
      ├─ markCompleted                              ◄── before parsing
      │
      └─ ParserRegistry.findParser(mimeType)
             │
        ┌────┴────┐
     PdfParser  SpreadsheetParser        none → skip
             │
          parse ──fail──► markParsingFailed, NOT rethrown
             │
          updateParsedResult
```

### What each box means
- **Metadata at sync, bytes later** — sync stays fast, and irrelevant emails never download.
- **markCompleted before parsing** — two independent failure domains.
- **ParserRegistry** — the only place that knows MIME → parser.

### What to say
> "Metadata only at sync time; the bytes come later, so sync stays fast and we don't download
> files for emails that turn out to be irrelevant.
>
> Two things I'd highlight. First, the attachment is marked completed the moment the
> *download* succeeds, before parsing is even attempted — so a later parse failure can never
> flip a successful download back to failed. Download failures rethrow so BullMQ retries them;
> parse failures don't, because they're deterministic and retrying just re-downloads.
>
> Second, the registry. `DocumentProcessingService` contains zero MIME-type conditionals.
> Adding DOCX is one new class and one line in the registry array."

---

## 8. Event update flow

### What to draw
```
   matched event + incoming observation
        │
   ┌────▼─────────────────────────────────────┐
   │ 1. status === "confirmed"?  ──► STOP     │  human authority is categorical
   ├──────────────────────────────────────────┤
   │ 2. detectChanges()                       │
   │      date  → IST key compare (+reschedule)│
   │      time  → only if not null AND differs │
   │      venue → isExplicit? compare vs value │
   │               else only if not null       │
   │    no changes ──► STOP                   │  ← makes reprocessing a no-op
   ├──────────────────────────────────────────┤
   │ 3. newConf < existingConf?  ──► STOP     │  highest trust wins, not last write
   ├──────────────────────────────────────────┤
   │ 4. build updateData from CHANGED fields  │
   │    only. rescheduled? → status +          │
   │    regenerate eventKey                    │
   ├──────────────────────────────────────────┤
   │ 5. TRANSACTION                           │
   │      INSERT EventUpdate × N              │
   │      UPDATE Event                        │
   └──────────────────────────────────────────┘
```

### What each box means
- **Guard 1** — status, not confidence, and that's the point.
- **Guard 2** — the fix for partial emails destroying data.
- **Guard 3** — replaces "last write wins".
- **Guard 5** — an event that can't explain itself is a state the domain forbids.

### What to say
> "Five gates in order, and each one exists because something broke.
>
> The first is a **status** check, not a confidence check — because manual confirmation sets
> confidence to 1.0 and so does a maximally confident extraction, so the numeric comparator
> literally can't tell 'a person settled this' from 'the extractor was very sure.' Authority
> is a kind, not a quantity.
>
> Step two is where partial emails get handled: a field the email never mentioned isn't in
> the changes list, so it's never in the update payload, so there's no code path that can
> blank it. And when nothing changed, we return before writing — which is what makes
> reprocessing the same email a true no-op.
>
> Step four regenerates the identity key on a reschedule. The key contains the date, so
> without regenerating it the next email about the new date wouldn't find this event and
> would create a second one at the slot it vacated.
>
> And step five is one transaction, because an event whose values moved without a matching
> audit row would be an event that can't explain itself."

---

## Cheat sheet — the phrases worth memorising

Say these verbatim; they're compact and they land.

- *"A weighted sum of non-negative terms cannot encode a veto."*
- *"Identity precedes similarity. Similarity ranks; it never admits."*
- *"Silence is not denial."*
- *"Highest trust wins, not last write."*
- *"Authority is a kind, not a quantity."*
- *"A duplicate is visible and recoverable. A false merge is silent and destroys the
  information you'd need to undo it."*
- *"Overlap is safe; gaps are not."*
- *"A queue is not an authenticated channel."*
- *"The origin that terminates the OAuth callback owns the session cookie."*
- *"A constraint is a rule; a threshold is a coincidence a future retune removes."*
