# 10 — Testing

Source: `backend/jest.config.cjs` and everything under `src/**/__tests__/`.
All ✅ **Current** unless tagged.

---

## The setup

Jest 30 + ts-jest + supertest. **No database, no Redis, no OpenAI key required** — the whole
suite runs on mocks.

`jest.config.cjs`, and every line in it exists for a reason:

| Setting | Why |
|---|---|
| `maxWorkers: 1` | The suite is verified leak-free (`--detectOpenHandles` reports nothing). In multi-worker mode ts-jest occasionally fails to tear a worker down in time and emits a flaky "worker process failed to exit" warning that isn't a real leak. Running in-band removes the worker so the warning can't occur — while keeping `--detectOpenHandles` meaningful for catching genuine leaks later. |
| `roots: ["<rootDir>/src"]` + `testMatch: ["**/__tests__/**/*.test.ts"]` | Jest's default `testMatch` also picks up any file literally named `test.ts` — including the manual Redis smoke script `src/infrastructure/redis/test.ts` — plus compiled copies under `dist/`. |
| `moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" }` | Production sources use ESM-style `"../event/event.repository.js"` imports, correct for the NodeNext runtime. ts-jest emits CommonJS and can't resolve them, so the trailing `.js` is stripped at resolution. |
| `transform` overrides `module: "commonjs"`, `moduleResolution: "node"`, `verbatimModuleSyntax: false` | The project tsconfig targets ESM (correct for the app). Jest runs CommonJS. |

## The suites

11 files, **125** explicit `it`/`test` declarations, **~214** test cases at runtime once the
parametrized `.each` suites and generated loops expand.

| Suite | What it covers |
|---|---|
| `matching/__tests__/matching.service.test.ts` | **The big one.** All three tiers, the identity gate, the 30-day bound, tenant scoping. ~37 tests. |
| `extraction/__tests__/date-evidence.test.ts` | `validateAIDate`, `findDateEvidence`, quoted-history handling. ~20 tests. |
| `email/__tests__/parser.test.ts` | `extractVenue`, company placeholder behaviour, `cleanEmail` quote-boundary cutting. ~18 tests. |
| `attachment/__tests__/document-processing.service.test.ts` | Ownership derivation and the full download/parse lifecycle. ~15 tests. |
| `event/__tests__/event.service.test.ts` | `detectChanges` venue logic, the confidence guard, manual authority, tenant refusal. ~13 tests. |
| `email/__tests__/email.service.test.ts` | Low-confidence routing and the viability gate. ~7 tests. |
| `attachment/__tests__/attachment.queue.test.ts` | Pins the job payload shape. ~4 tests. |
| `attachment/__tests__/attachment.repository.test.ts` | Cross-tenant write refusal, against an in-memory fake table. |
| `extraction/__tests__/confidence.test.ts` | `computeConfidence` sanity. 3 tests. |
| `gmail/__tests__/gmail.service.test.ts` | `parseMessage` attachment discovery in nested MIME. 3 tests. |
| `__tests__/email.api.test.ts` | The one HTTP-level test: `POST /email` returns 202 / 400. 2 tests. |

> The README says "7 suites, 115 tests" — that's stale. Count the files if you want a number,
> or just say "around a dozen suites, mostly around matching and extraction."

---

## What is unit-tested, what is integration-tested

**Unit (the vast majority).** Pure functions and services with every dependency below them
mocked:
- extraction: `extractVenue`, `cleanEmail`, `extractExactDate`, `validateAIDate`, `computeConfidence`
- matching: `matchEventV2` with a mocked repository
- decisions: `detectChanges`, `updateEventService`, `updateEventManuallyService`
- attachments: `DocumentProcessingService` with mocked Gmail, storage, registry and repository

**Integration (one).** `email.api.test.ts` uses supertest against the real Express app, with
Prisma, the queue and `requireAuth` mocked. It exercises route wiring → controller →
validation → response contract.

**Not tested at all** (say this if asked; it's a fair answer):
- real Prisma queries against a real Postgres
- real BullMQ job execution
- real Gmail API calls
- real OpenAI calls
- the React frontend

---

## What is mocked, and why

| Mocked | Reason |
|---|---|
| `lib/prisma` (manual mock at `src/lib/__mocks__/prisma.ts`) | No database in unit tests. Its `$transaction` mock invokes the callback with the same mock as `tx`, so transactional code paths execute for real. |
| `infrastructure/queue/queues` | Importing the real one constructs a BullMQ `Queue`, which auto-connects ioredis and leaks an open socket that stops Jest exiting. |
| `event.repository` (in matching tests) | Matching is being tested, not persistence. |
| `matching.service`, `event.service`, `extraction.service` (in email.service tests) | Mock everything below the layer under test. |
| `auth.middleware.requireAuth` (in the API test) | That suite is about the ingestion contract, not authentication. The stub supplies a caller. |
| The generated Prisma client (`Prisma.DbNull` only) | It's ESM and uses `import.meta`, which the CommonJS transform can't parse. Stubbing the single symbol needed avoids dragging the real client into the test runtime. |

**Why mock the repository rather than test through it?**
A repository is a thin translation to Prisma. Testing it without a real database tests
Prisma's mock, not your code; testing it *with* one is an integration test with different
setup costs. The interesting logic — "when do I refuse this update?" — lives in the service,
and that's what the tests target.

**The exception that proves the rule:** `attachment.repository.test.ts` *does* test the
repository, and it uses a hand-rolled in-memory table instead of bare `jest.fn()`s. The
reasoning is stated in the file and it's excellent:

> Cross-tenant safety is a statement about **what the database ends up holding**. An unscoped
> `update WHERE { id }` is indistinguishable from a scoped `updateMany WHERE { id, userId }`
> if you only inspect call arguments — both are "called with the right id". Applying the
> WHERE predicate for real is what makes *"the other tenant's row did not change"* an
> observation instead of an assumption.

That's the general principle: **match the fidelity of the fake to the claim you're making.**

---

## Test isolation

`jest.clearAllMocks()` in `beforeEach` everywhere. Mock call history persists between tests
otherwise, and produces failures with no relationship to the code — story #10 in
[ch. 09](09-PROBLEMS-AND-DESIGN-DECISIONS.md).

---

## The three techniques worth showing off

### 1. Asserting on **absence**, not just outcome

`matching.service.test.ts` wraps the real scorer instead of replacing it:

```ts
jest.mock("../matching.utils", () => {
  const actual = jest.requireActual("../matching.utils");
  return { ...actual, scoreEventMatch: jest.fn(actual.scoreEventMatch) };
});
```

The real scoring still runs — but its call history becomes observable. Then:

```ts
expect(scoredCandidateIds()).not.toContain(contradictingId);
```

**Why this matters:** the identity gate's contract is that a contradicted candidate is
*never scored at all*. An assertion on the return value alone cannot distinguish **"correctly
vetoed"** from **"scored and happened to lose"**. Only asserting on what the scorer was never
asked to evaluate proves the gate ran.

The same idea appears in the manual-authority tests: `"writes no history when an automated
update is refused"` asserts `eventUpdate.create` was called **zero** times. That proves the
guard runs *before* the write, not after.

### 2. A parametrized regression sweep

```ts
describe("D-1 regression sweep: a contradicting round can never match", () => {
  for (const delta of [...]) for (const confidence of [...]) {
    it(`Δ=${delta}, c=${confidence} -> no match, never scored`, ...);
  }
});
```

The original bug was that *some* combination of date proximity and confidence crossed the
threshold. So the test sweeps the space rather than picking one example. **A regression test
for a threshold bug has to cover the space, not a point.**

### 3. Refactoring safely by keeping assertions byte-identical

When tenant scoping was added, `matchEventV2` gained a first parameter. Instead of editing
forty call sites, the suite wraps it:

```ts
const matchEventV2 = (data: any) => matchEventV2Scoped(TENANT, data);
```

Stated reasoning: *"rewriting forty assertions to thread a parameter would be a diff large
enough for a real behavioural change to hide inside."* That's a genuinely good instinct to
articulate.

---

## Important edge cases actually covered

- Explicit-null venue clears; no-mention venue preserves
- Lower confidence skips the update; higher confidence applies it; **no changes → repository
  never called**
- A `confirmed` event is not revised even by an equally confident observation, and not
  rescheduled by a different date
- An event in `review` or with no status **is** still updated (the guard isn't too broad)
- A human *can* still edit a confirmed event
- A caller who doesn't own an event gets a refusal
- A contradicting round never matches, at any Δ and any confidence
- An unresolved round on the **stored** event is UNKNOWN, not agreement
- The right round is selected even when the wrong one scores higher
- Loose tier: matches at exactly ±30 days, not at ±31; doesn't match when two candidates exist
- `validateAIDate` accepts a **legitimate** January 1st (not a blanket `-01-01` rejection)
- A date appearing only in a quoted reply chain is not evidence
- A body that is *only* quoted history falls back to the full text
- Attachment: an already-completed attachment is a no-op; a parse failure leaves the download
  completed
- A company that merely *contains* the word "unknown" is still processed

---

## Tests I should mention in an interview

Pick two or three, not the whole list.

1. **The D-1 regression sweep with the wrapped scorer.** Best single test in the project —
   it proves a *negative* about control flow, not just an output.
2. **`"writes no history when an automated update is refused"`.** Proves ordering: the guard
   runs before the write.
3. **`attachment.repository.test.ts`'s in-memory table.** Shows you thought about what the
   fake has to actually simulate for the assertion to mean anything.
4. **The venue explicit-null pair.** Two tests, three lines apart, that pin the entire
   intent-aware design.
5. **`date-evidence.test.ts`'s "accepts a legitimate January 1st".** Shows the guard is a
   corroboration check, not a heuristic ban.

---

## Testing questions you'll get

**"How would you test the extraction system?"**
> Three layers. The pure functions — `extractVenue`, `extractExactDate`, `cleanEmail` — are
> plain input/output tests with real email snippets, and they're where the regression tests
> for every parsing bug live. `computeConfidence` is tested on relative assertions ("vague
> date scores lower than exact") rather than exact numbers, so retuning weights doesn't break
> the suite. The AI path isn't tested against a live model — instead `validateAIDate` is
> tested exhaustively, because that's the deterministic guard that actually protects the
> database. If I wanted more, I'd inject a fake `AIProvider` through `structuredCompletion`,
> which the AI Core already supports.

**"How would you test that duplicate emails don't create duplicate events?"**
> At three levels, matching the three defences. Unit: `matchEventV2` returns the exact match
> for a repeated key, and `detectChanges` returns `[]` for identical data, so the update path
> writes nothing. Integration (would need a real database): submit the same email twice and
> assert one row plus zero `EventUpdate` rows — the second assertion is the stronger one,
> because it proves nothing was written rather than just that nothing changed. And the race:
> two concurrent creates should end in one row and one `P2002`, which the worker swallows.

**"How would you test confidence-based updates?"**
> Construct an existing event with a known confidence and an incoming observation with a
> lower one, then assert the repository was **never called**. That's the pattern the suite
> uses — assert on the absence of the write, not on the returned object, because a service
> that returns the old value while having written the new one would pass an outcome-only
> test.

**"How would you test the transaction?"**
> Two halves. The happy path is covered by the Prisma mock whose `$transaction` invokes the
> callback with itself as `tx`, so the code inside really executes. The rollback half — "if
> `event.update` throws, no `EventUpdate` rows survive" — **cannot** be tested against a mock,
> because the mock has no rollback semantics. That needs a real Postgres, which the suite
> deliberately doesn't have. I'd add it as an integration test with a test container.

**"Why mock the repository?"**
> Because it's a thin translation layer to Prisma, and testing it against a mocked Prisma
> tests the mock. The decisions worth protecting are in the service. The exception is the
> attachment repository, where the *claim* is about tenant scoping — so there the mock had to
> apply WHERE predicates for real.

**"What's missing from your test coverage?"**
> No end-to-end test with a real database, no BullMQ integration test, no frontend tests, and
> the two document-intelligence extractors that bypass the AI Core aren't tested. The gap I'd
> close first is a real-Postgres integration test for the update transaction, because that's
> the one guarantee the unit tests structurally cannot verify.
