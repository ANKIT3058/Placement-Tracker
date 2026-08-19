# 09 — Problems and Design Decisions

Thirteen stories, compressed from a much larger debugging log. Ordered by how strong they
are in an interview.

**Stories 1–5 are the ones to learn cold.** The rest are backups and follow-up material.

---

## 1. The false merge — a PPT and an OA became one event

### Problem
An email announced a Pre-Placement Talk in the morning and a separate email announced an
online assessment in the afternoon — same company, same day. The system merged them into one
event. Two genuinely different activities became one record, and the second one was gone.

### Why it happened
Recognition used a single weighted score to decide **both** whether a candidate was the same
event and which candidate to pick:

```
score = 0.5·dateProximity + 0.3·roundAgreement + 0.2·confidenceAlignment
accept if score >= 0.5
```

An exact date gives `0.5 × 1.0 = 0.5` — **exactly the acceptance threshold, from the date
term alone.** A mismatched round contributed `0`. And `0` in that function means *"no
support"*, not *"evidence against"*.

That's the whole bug, and it isn't a mis-tuned constant. The score is a sum of non-negative
terms, so it's monotone in each: no configuration of the other inputs can pull it back below
the threshold. **A weighted sum of corroboration cannot encode a veto.** The engine was
structurally incapable of disagreeing with itself.

Two things made it worse. Confidence alignment competed on the same scale as round
agreement, so a well-established *wrong-round* event could out-rank the correct one. And the
update path never compares round, so the merged event kept its original label and nothing
anywhere recorded that a contradicted attribute had been accepted.

### How I debugged it
I found it **by writing the specification, not from a failing test.** Documenting the domain
model forced me to write down that three attributes — company, round, time — individuate a
round, and that *any two are insufficient*. Then I looked at what the matcher actually
required and it was asserting identity from company + date. The defect fell out of the
contradiction between the two documents.

### Solution
Split recognition into two phases with **strictly separated authority** (ADR-006):

```
Phase 1  ADMISSION (categorical)
         classifyRoundIdentity(candidate, incoming) → AGREES | UNKNOWN | CONTRADICTS
         CONTRADICTS → vetoed. Never scored.
         UNKNOWN     → still eligible (silence is not denial)

Phase 2  RANKING (continuous)
         scoreEventMatch over survivors only. No authority to admit.
```

Plus a sentinel rule: the literal `"unknown"` that extraction substitutes for an unresolved
round maps to `null` and **never compares equal to itself.** It's a marker for "not
extracted", not a round any company runs.

### Why this solution
Because the failure was **representational**. Identity is categorical — it holds or it
doesn't — and forcing a categorical judgement through a continuous representation means the
contradiction has to be encoded as a small number, and small numbers get outvoted.

And it changes *how the system fails*. A scoring threshold fails toward the merge, because
every extra term pushes the total up. A constraint fails toward the duplicate, because a
candidate that doesn't qualify is simply absent. **The architecture now fails in the
recoverable direction by construction rather than by arithmetic** — and arithmetic is exactly
what a future retune silently undoes.

### Result
A contradicting round can never match, at any date proximity and any confidence. There's a
regression sweep in `matching.service.test.ts` that runs every combination of date delta and
confidence and asserts no match — **and asserts the scorer was never even called**, because
an assertion on the outcome alone can't distinguish "correctly vetoed" from "scored and
happened to lose."

### What I learned
Constraints and scores answer different questions. If the thing you're deciding is
categorical, the representation has to be categorical too. And: *a constraint is a rule; a
threshold is a coincidence a future retune removes.*

**Files:** `src/modules/matching/matching.utils.ts`, `matching.service.ts`,
`docs/06_ADR/ADR-006_Identity_Precedes_Similarity.md`

---

## 2. Partial updates destroying correct data

### Problem
Sequence:
```
Email 1: "Amazon OA on 20th Aug at 10 AM on HackerRank"   → time 10:00, venue hackerrank ✅
Email 2: "Amazon OA on 20th Aug"                          → time null, venue null ❌
```
A reminder email that mentioned neither time nor venue **wiped both.**

### Why it happened
The update wrote the whole extracted object:
```ts
if (existing.time !== incoming.time) updateData.time = incoming.time;   // incoming.time = null
```
Extraction returns `null` for "I didn't find one." The update layer read `null` as "set it to
null." The two layers had different meanings for the same value, and nothing translated
between them.

### How I debugged it
Ran a sequence of real emails in order and diffed the row after each one. The wipe was
immediately visible; the cause took longer, because each layer was individually correct.

### Solution
Two changes:
1. In `detectChanges`, a time only counts as a change when it's neither `undefined` nor
   `null` **and** actually differs.
2. In `updateEventService`, only fields present in the `changes` list are put into
   `updateData` at all.

```ts
if (changes.some(c => c.field === "time")) updateData.time = incoming.time;
```

### Why this solution
The second change matters more than the first. Gating on `changes` means **a field the email
didn't mention is not in the update payload — so there is no code path that can write it.**
The first change alone would still write on every update, just with the same value.

### Result
Partial emails became safe, which also made reprocessing the same email a true no-op — the
foundation of the system's idempotency. `changes.length === 0` returns early, writes nothing,
and creates no audit row.

### What I learned
When two layers disagree about what a value *means*, adding a check in one of them is a
patch. Making the absent case structurally unwritable is a fix.

**File:** `src/modules/event/event.service.ts`

---

## 3. "Not mentioned" vs "explicitly nothing" — the `VenueMeta` story

### Problem
An email said `Venue: PFA seating plan`. (PFA = "please find attached" — it's attachment
boilerplate, not a venue.) The extractor correctly refused to accept it and returned `null`.

But the event already had `venue: "auditorium"` from an earlier email — and it **stayed
there**, because story #2's fix means a `null` never overwrites. So a venue the email had
explicitly invalidated survived indefinitely.

Fixing #2 had created #3.

### Why it happened
The extractor's return type was `string | null`, which can represent *one* kind of absence.
The intent — *did the email speak about venue at all?* — was destroyed at the extraction
boundary and could not be recovered downstream.

### How I debugged it
Wrote out the truth table of what *should* happen:

| Email says | Stored | Should become |
|---|---|---|
| nothing about venue | auditorium | auditorium (preserve) |
| "Venue: PFA seating plan" | auditorium | null (clear) |
| "Venue: TPO" | auditorium | tpo (update) |

Rows 1 and 2 produce the same extracted value and require opposite behaviour. So no amount
of logic on that value can be correct. The type was wrong.

### Solution
```ts
export type VenueMeta = { value: string | null; isExplicit: boolean };
```
- explicit `venue:` keyword → `isExplicit = true`
- known platform (hackerrank, zoom…) → `isExplicit = true`
- invalid/noise phrase → `{ value: null, isExplicit: true }`
- inferred from `at <X>` or a known location → `isExplicit = false`
- no mention at all → `{ value: null, isExplicit: false }`

`detectChanges` then branches on `isExplicit`, and confidence scoring uses it too (explicit
real value 0.9, inferred 0.5 — neutral, not penalised — explicitly invalid 0.3).

### Why this solution
`venue` stays a plain `string | null` for the database and for display; `venueMeta` rides
alongside for the *decision*. Storage doesn't need the intent; the decision does.

### Result
All three rows of the table behave correctly, and there's a test pinning rows 1 and 2:
`"explicit null should clear venue"` / `"no mention should NOT change venue"`.

### What I learned
Handling `null` isn't enough in a real system. **Absence, unknown, and explicit-none are
three facts.** And this is the same lesson as story #1 in a different layer — `VenueMeta`
distinguishes silence from denial on the update path; `AGREES/UNKNOWN/CONTRADICTS` does it
on the identity path. Noticing that connection unprompted lands very well.

**Files:** `src/modules/email/email.parser.ts`, `extraction/extraction.utils.ts`,
`event/event.service.ts`

---

## 4. The AI invented a date that was never in the email

### Problem
An email mentioned a company would be hiring **"in 2027"**. No day, no month. The model
returned `"2027-01-01"`, and the system created an event on 1 January 2027.

Related and worse: an email said `"August 2027"` → the model returned `"2027-08-01"`.

### Why it happened
The prompt asked for `"YYYY-MM-DD" | null`, and the model filled in the missing parts to
satisfy the format. The output was **syntactically perfect and semantically fabricated** —
which is the specific failure mode of LLMs that makes them dangerous in a data pipeline.
Validating the shape catches nothing: `"2027-01-01"` is a well-formed date whether or not
January 1st was ever mentioned.

### How I debugged it
Compared the stored event dates against the raw bodies in `EmailExtraction.rawText`. That
table exists precisely so you can ask "what did the extractor read?" separately from "what
did the system decide?"

### Solution
Two layers, neither of which is "write a better prompt."

**Layer 1 — prompt.** Explicit rules: a standalone year is not a date; a month+year is not a
full date; never invent a missing day or month; return `null` when incomplete or ambiguous.

**Layer 2 — a deterministic guard.** `validateAIDate(candidate, sourceText)`: extract every
day+month(+year) mention from the source with `findDateEvidence`, and keep the AI's candidate
only if some mention corroborates it. Details that matter:
- checks **every** mention, so a legitimate second date in a multi-date email still passes
- runs `cleanEmail` first, so a date living only in the quoted thread cannot authorise it
- if the candidate has no evidence, it's **dropped, not replaced** — so `mergeExtraction`
  falls back to the regex date exactly as it would for any other missing AI field

### Why this solution
Because a prompt is a request and a check is a guarantee. The model can regress, be swapped,
or behave differently at a different temperature. The validator is deterministic and
testable, and it makes a specific claim: *this date must be corroborated by the source text.*

Note what it deliberately is **not**: a blanket rejection of `-01-01` dates. There's a test
called `"accepts a legitimate January 1st date"` for exactly that.

### Result
20 tests in `date-evidence.test.ts`. A standalone year, a month+year, and an uncorroborated
candidate are all rejected; a real date, a second date, and a January 1st that's genuinely
mentioned all pass.

### What I learned
Never let a model's output reach the database without a deterministic check on the part that
matters most. And note the interesting property: the check makes the AI **strictly safer than
regex-only**, because it can only ever *remove* an AI date, never add a wrong one.

**Files:** `src/modules/extraction/extraction.utils.ts`, `email.parser.ts`

---

## 5. The event on a date that appeared nowhere in the email

### Problem
A Bajaj Auto email produced an Interview event on **2025-07-29** — a date that appears
nowhere in the message anyone actually sent.

### Why it happened
It was a **reply**, and a reply carries the entire thread below it. Gmail's attribution line
was:
```
On Tue, Jul 29, 2025 at 2:30 PM ... wrote:
```
Both extractors read the whole body, so a date belonging to a *different, older* email was
indistinguishable from the current one. In this case the quoted header contained the only
explicit year in the entire body, so it won.

### How I debugged it
Read the raw body from `EmailExtraction.rawText`. The date was right there — 400 characters
below where the actual message ended.

### Solution
Cut the body at the first quote boundary, **before** any extraction. `QUOTE_BOUNDARY` in
`email.parser.ts` handles five shapes:
1. Gmail/Apple Mail attribution — `^On [\s\S]{0,300}?\bwrote:`
2. Gmail forward separator
3. Outlook `-----Original Message-----`
4. Outlook `From:` … `Sent:`/`Date:` header block
5. quoted lines `^>` and the RFC 3676 signature delimiter `^-- $`

Three details worth explaining:
- Pattern 1 **spans newlines** (`[\s\S]`) because the line wraps in practice — the real
  Bajaj body broke immediately before `wrote:`, so a single-line `^On .* wrote:$` misses it.
  It's lazy and length-bounded so it can't run away across the whole body.
- Pattern 4 requires the *second* line, so a prose sentence starting "From:" doesn't cut the
  message.
- **Fallback:** if cutting leaves nothing — a bare forward with no covering note — keep the
  full text. Never return less than nothing useful.
- It runs **before** the newline collapse, because every pattern is line-anchored.

### Why this solution
The quoted history isn't noise to filter, it's *a different document*. Cutting at the
boundary is the only operation that reliably separates them, and doing it once at the top
means every downstream extractor and `validateAIDate` all get the same, correct scope for
free.

### Result
Seven tests in `parser.test.ts` covering each boundary shape, plus tests asserting a normal
email is untouched and that prose merely *mentioning* the boundary words isn't cut.

### What I learned
Preprocessing decisions have to be made once, at the right layer. Every extractor patching
around quoted text independently would be five places to get wrong.

**Commit:** `dec0379 fix(extraction): strip quoted email chains before AI extraction`

---

## 6. Explicit year overwritten by inferred logic

### Problem
`"16th August 2025"` was stored as **2026**.

### Why it happened
Two mistakes compounding. The date regex didn't capture the year group at all, and there was
a "helpful" rule:
```ts
if (date < now) year += 1;    // "must mean next year"
```
That rule is fine for `"16th August"` with no year. Applied to a date that *stated its year*,
it silently corrupted explicit data.

### Solution
Capture the year as an optional group; use it when present; fall back to the current year
only when it's absent; **delete the future-bump rule entirely.**
```ts
const year = first.year ?? new Date().getUTCFullYear();
```

### Why this solution
The bump rule was solving a real problem (an undated "16th August" in December probably means
next year) at the cost of a much worse one. Deleting it means an undated past date stays in
the past — visibly wrong, and correctable — rather than an explicit date being silently moved.
Recoverable failure over silent corruption, again.

### What I learned
**Never override explicitly provided data with inferred logic.** If you're going to infer,
infer only into a gap.

**File:** `src/modules/email/email.parser.ts` → `extractExactDate`

---

## 7. Greedy regex — the venue was `"pfa seating plan"`

### Problem
`Venue: PFA seating plan` extracted as venue `"pfa seating plan"`. And `Venue: TPO\nNote:
Candidates must...` extracted as `"tpo note candidates must"`.

### Why it happened
Two separate causes that looked like one bug:
1. The pattern `/(?:at|venue:)\s*([a-zA-Z0-9\s]+)/i` has no bound. `\s` matches spaces, so it
   swallowed the rest of the line.
2. `cleanEmail` had already replaced newlines with spaces, so `[^\n\r]+` — which *should*
   have stopped at the line end — had no line end left to stop at.

### How I debugged it
Logged the input to `extractVenue` next to its output. The input had no newlines in it, which
made cause 2 obvious immediately.

### Solution
- Pass **raw text** to `extractVenue` inside `extractData` (everything else gets cleaned
  text). ⚠️ *Caveat worth knowing:* in the live pipeline `email.service` already calls
  `cleanEmail` before `extract`, so the newlines are gone before `extractVenue` ever sees the
  text. The raw-text path only truly holds when `extractData` is called directly, as the unit
  tests do. What actually carries the fix on the live path is the clause splitting below.
- Split off trailing clauses at keywords (`note`, `time`, `date`, `timing`, `register`) and at
  `,` / `;` — **before** the length check, so `"TPO Note: ..."` isn't rejected for length.
- A `VENUE_NOISE_WORDS` blacklist: `seating`, `plan`, `pfa`, `please`, `attached`,
  `attachment`, `find`.
- An invalid-venue regex: `will be|shared soon|tbd|tba|later|after (the )?ppt|to be
  (shared|announced|communicated)|will share`.
- Reject anything over 30 characters, strip punctuation, keep the first 2 words.

### Why this solution
Note the outcome for a rejected value: `{ value: null, isExplicit: true }`. It doesn't just
return nothing — it records that **the email spoke about venue and what it said isn't one.**
That's what feeds story #3's clearing behaviour.

### What I learned
Preprocessing can break downstream extraction. Sometimes you need the raw text, because
position and structure *are* information.

**File:** `src/modules/email/email.parser.ts` → `extractVenue`

---

## 8. The "unknown" event that swallowed everything

### Problem
`extractCompany` returns the literal string `"unknown"` when it can't resolve a company. The
pipeline's check was a truthiness check — and `"unknown"` is truthy. So it passed, an Event
literally named `"unknown"` was created, and **that event then became a matching candidate for
every subsequent unresolved observation.** One garbage row absorbed unrelated emails.

Compounding it: `scoreCompany` was
```ts
if (company.length > 2) return 1;
```
so `"unknown"` scored a perfect 1.0 for company. The confidence system, which existed
specifically to catch weak extractions, was rating the weakest possible one as certain.

### Solution
Three layers:
1. `scoreCompany`: `if (!company || company === "unknown") return 0;`
2. An extra `-0.1` penalty in `extract()` as a low-trust signal.
3. **The viability gate (AC-4)** — the real fix. Before the key is generated, before any
   candidate query, before any write:
```ts
if (!isResolvedCompany(data.company) || !data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
  await updateEmailStatus(owner, emailId, EMAIL_STATUS.IGNORED);
  return;
}
```

### Why this solution
Fixing the score alone would still have created the event, just with lower confidence — so it
would have gone to the review queue instead, and the review queue would fill with garbage.
The gate is the right layer because *an observation with no identity anchor cannot be reasoned
about at all.* Abandoning it keeps the placeholder out of the identity key, out of the
candidate queries, and out of the database.

Being marked `ignored` rather than `failed` matters too: it isn't an error, it's a decision.

### What I learned
A sentinel value is a type smuggled inside a string, and every consumer has to know about it.
`isResolvedCompany` is a type guard that makes that knowledge explicit and testable — and
there are tests asserting a company that merely *contains* the word "unknown" is still
processed normally.

**Files:** `src/modules/email/email.service.ts`, `email.parser.ts`,
`extraction/confidence.utils.ts`

---

## 9. Confidence computed but never delivered

### Problem
The confidence system was built, tested, and correct — and the confidence guard in the update
path never fired. Weak data kept overwriting strong data.

### Why it happened
```ts
const { data } = await extract(text);   // ← confidence destructured away and dropped
```
`extract` returned `{ data, confidence, status }`. The caller took only `data` and passed it
downstream. `existing.confidence ?? 0` vs `incoming.confidence ?? 0` therefore compared
`something` against `0`, so every update passed.

### How I debugged it
Added a log line at the boundary — `console.log("CONFIDENCE FLOW:", { extracted: confidence })`
— and another in `updateEventService` printing both sides of the comparison. The incoming side
was `undefined`. Both log lines are still in the code.

### Solution
```ts
const { data, confidence, status, isTimeEstimated } = await extract(cleanText);
const enrichedData = { ...data, confidence };
```

### Why this solution
Explicit enrichment at the boundary rather than threading confidence as a separate parameter
through four call sites — one object flows through the pipeline, and it's obvious where the
field is attached.

### What I learned
**A missing field is a silent failure.** No error, no crash, no test failure — the feature
just quietly doesn't exist. TypeScript didn't help because the downstream types had
`confidence?: number`. A required field would have caught it at compile time, which is the
real lesson: *optional fields hide integration bugs.*

**File:** `src/modules/email/email.service.ts`

---

## 10. Jest mocking — the dependency chain that reached Postgres

### Problem
A unit test for `email.service` failed with:
```
prisma.event.findUnique is not a function
```
even though Prisma was mocked.

### Why it happened
The mock covered what the test *thought* it needed. The real chain was:
```
email.service → matching.service → event.repository → prisma
                     ↑ not mocked
```
`extraction.service` and `event.service` were mocked. `matching.service` wasn't, so real code
executed and reached the real Prisma import.

There was a second, uglier version: the generated Prisma client is ESM (it uses
`import.meta`), and ts-jest transpiles to CommonJS — so merely *importing* it in a test threw
`Cannot use 'import.meta' outside a module`.

### Solution
- Mock every layer below the one under test.
- A shared manual mock at `src/lib/__mocks__/prisma.ts`, activated by `jest.mock("../../../lib/prisma")`.
- Where a test only needs one symbol from the generated client, stub exactly that:
  `jest.mock(".../generated/prisma/client", () => ({ Prisma: { DbNull: {...} } }))`.
- `jest.config.cjs` overrides the project tsconfig for the transform: `module: "commonjs"`,
  `moduleResolution: "node"`, `verbatimModuleSyntax: false`, and a `moduleNameMapper` that
  strips the `.js` suffix from relative imports (correct for NodeNext at runtime, unresolvable
  for ts-jest's CJS output).
- `jest.clearAllMocks()` in `beforeEach`, because mock call history leaks between tests and
  produces failures that have nothing to do with the code.

### Why this solution
The rule is simple and mechanical: **mock everything below the layer under test.** A unit test
that reaches a real repository isn't a unit test, and the failure it eventually produces
points at the wrong file.

### What I learned
ESM/CJS interop is a real engineering cost, not a footnote. And the shape of a test failure
tells you about your dependency graph — "why is this test touching Prisma?" is a design
question.

**Files:** `backend/jest.config.cjs`, `src/lib/__mocks__/prisma.ts`

---

## 11. Atomicity — the event that couldn't explain itself

### Problem
An update was two independent writes: insert audit rows, then update the event. If the second
failed, history recorded a change that never happened. If the first failed, the event's values
moved with no record of why.

### Solution
```ts
return prisma.$transaction(async (tx) => {
  for (const change of changes) await tx.eventUpdate.create({ ... });
  return tx.event.update({ where: { id: eventId }, data: { ...updateData, confidence } });
});
```

### Why this solution
They're **one business action**. The audit row isn't logging — it's part of the state change.
An event whose values moved without a matching record is a state the domain doesn't permit,
so the database shouldn't be able to hold it.

### Result
Testable, too: the manual-authority tests assert that when an update is *refused*, **zero**
`eventUpdate.create` calls happen. Asserting on absence is what proves a guard ran before the
write rather than after.

### What I learned
"Should this be a transaction?" is answered by asking whether the writes are one business
action, not by counting statements.

**File:** `src/modules/event/event.service.ts`

---

## 12. Production: the dashboard said "No events yet" with 39 rows in the database

### Problem
Deployed frontend on Vercel, backend on Render. Google sign-in reported success. The database
held 39 correctly-owned events. The dashboard rendered "No events yet" — **silently, with no
error.**

### Why it happened
**Two bugs, and the first masked the second.**

1. `VITE_API_URL` had a trailing slash, so the frontend requested `//event` and got a 404.
2. The real one: **the session cookie was minted on the wrong origin.** OAuth terminated on
   `…onrender.com`, so the browser filed `__Host-placement.sid` under the Render origin. Every
   API call came from a page on `…vercel.app`. Both `vercel.app` and `onrender.com` are Public
   Suffix List entries, so those are two different *sites*, not just two origins — and a
   `SameSite=Lax` cookie is withheld from cross-site subresource requests. Express saw no
   cookie and answered 401.

Nothing in the application code was wrong. Sessions, tenant scoping, the Redis store and the
database were all correct throughout.

It was invisible because `Dashboard.tsx` had no `catch`: a 404 HTML page, a 401 JSON body, and
a genuinely empty result all render identically.

### How I debugged it
Live request captures plus a server-side Redis witness (checking whether a `sess:*` key was
actually created and whether it was ever read back). That's what separated "the cookie isn't
being sent" from "the session isn't being created."

### Solution
Route **both planes** through one origin using a Vercel rewrite:
```json
{ "rewrites": [{ "source": "/api/:path*", "destination": "https://<backend>.onrender.com/:path*" }] }
```
- **Data plane:** `VITE_API_URL=/api`
- **Auth plane:** `GOOGLE_REDIRECT_URI` → the **Vercel** origin's `/api/gmail/callback`

Now the cookie is minted and read on the same origin, `SameSite=Lax` is satisfied, and CSRF
protection is retained.

### Why this solution
The alternative — `SameSite=None; Secure` third-party cookies — gives up CSRF protection and
is increasingly blocked by browsers anyway. Collapsing two sites into one is the correct fix,
not a workaround.

### What I learned
Five things, and this is the story's real value:
1. Fixing *a* cause is not fixing *the* cause — the first bug hid the second.
2. **A proxy fixes the data plane, not the auth plane.** Both need routing.
3. Build-time config is deployment state; **the built artifact is ground truth**, not the source.
4. When experiments can't discriminate between hypotheses, pick the fix that's correct under
   all of them.
5. **Silent empty states destroy diagnostic information at its cheapest point.**

One line to remember: **the origin that terminates the OAuth callback owns the session cookie.**

**Doc:** `docs/postmortems/vercel-render-oauth-deployment.md`

---

## 13. The AI Core — recognising a cross-cutting concern

### Problem
Four AI-powered services (email extraction, document classification, event extraction,
participant extraction) each independently implemented: build an OpenAI request, send it, get
raw text, strip markdown fences, `JSON.parse`, handle an empty response, handle malformed
JSON, handle provider errors, decide whether to retry.

The business logic differed. The plumbing was byte-for-byte identical.

### Why it happened
Each AI feature was added as a self-contained unit. That's the right call for the first one
and arguably the second. By the fourth it means any fix has to be made in four places, and
the fifth feature copies it again.

### Solution
A provider-agnostic AI Core (`src/modules/ai/`):
- `AIProvider` interface + `OpenAIProvider` (wrapping the *same* memoized client, not a
  second one)
- `structuredCompletion<T>()` — the single entry point
- `JsonResponseParser` — fence stripping + parse, one definition
- `RetryPolicy` — transient-only retries with linear backoff
- A typed error hierarchy: `AIError` → `EmptyResponseError` / `MalformedResponseError` /
  `ProviderError(retryable)`
- `ModelConfig` with a documented default

### Why this solution — and the discipline that matters
**It was introduced without changing the behaviour of any existing service.** The two migrated
callers pass `new RetryPolicy({ maxAttempts: 1 })`, which reproduces their previous
single-attempt behaviour *exactly*. An abstraction that changes behaviour while it's being
introduced can't be verified — you can't tell a refactoring bug from an intended improvement.

### Result
Honestly: **partially adopted.** `extraction.service` and `document-classifier` use it;
`event-extractor` and `participant-extractor` still call OpenAI directly. That's real, it's
visible in the code, and volunteering it is better than being caught by it.

### What I learned
Once a system has several AI features, the hard problem stops being "how do I call this API"
and becomes "how do I call it *consistently*." Separating provider communication, structured
completion, retry, parsing and error handling into an infrastructure layer lets each feature
be only its business logic.

**Interview framing** for *"what was your most difficult architectural decision?"*:
> "Recognising that the duplication across four AI services wasn't four small copies — it was
> one cross-cutting concern that hadn't been named yet. The hard part wasn't writing the
> abstraction, it was introducing it without changing behaviour, so I could prove nothing
> broke."

**Files:** `src/modules/ai/`

---

## Two more, briefly

**Prisma 7 stopped reading `.env`.** Prisma 7 removed `url`/`directUrl` from the schema
entirely and its CLI loads env differently. Fix: `import "dotenv/config"` at the top of
`prisma.config.ts`, and split the pooled runtime URL from the direct migration URL — because
`prisma migrate` takes a **session-level** advisory lock that a transaction pooler cannot
hold. Lesson: a major version bump is a change to your system, not just your dependencies.

**connect-redis v10 doesn't work with ioredis.** `connect-redis` v10 issues
`client.set(key, value, { expiration: { type: "EX", value } })` — the node-redis signature,
which takes an options object. ioredis takes variadic args and stringifies anything else, so
the command reached Redis as `SET <key> <value> [object Object]` and was rejected with
`ERR syntax error`. **The session store never wrote a single session**, silently. Fix: two
clients — node-redis for sessions, ioredis for BullMQ (which requires it). Two clients from
two libraries is the *correct* outcome here, not an inconsistency: each library is paired with
the client it's built for. And they need different Redis eviction policies anyway — BullMQ
requires `noeviction` because an evicted job key is a silently lost job, while a session store
is commonly deployed with LRU.
