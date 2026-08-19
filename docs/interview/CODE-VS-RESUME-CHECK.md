# Code vs Resume — Evidence Check

Line-by-line verification. **This is the file to read if you only have ten minutes and want to
know what you can safely say.**

**Status:** ✅ CONFIRMED · 🟡 PARTIAL · 🕘 HISTORICAL · 🔴 NOT FOUND

---

# PLACEMENT INTELLIGENCE SYSTEM — bullets

## Bullet 1

**Resume says:** *"Reconciles fragmented placement announcements — a round announced, moved and
re-venued across separate emails — into one authoritative record per real-world event."*

**Code proves:** A three-tier recognition pipeline that finds an existing `Event` for a new
observation, and a guarded update path that writes only changed fields. `Event` is the single
mutable record; `Email` and `EmailExtraction` are append-only evidence.

**Evidence:** `email.service.ts:processEmail` · `matching.service.ts:matchEventV2` ·
`event.service.ts:updateEventService`, `detectChanges` · `schema.prisma:Event`

**Status: ✅ CONFIRMED** — with the caveat that *"one record per event"* is a design goal, not
a guarantee. When matching is ambiguous the system deliberately creates a duplicate rather than
risk a false merge. Say that as a strength.

---

## Bullet 2

**Resume says:** *"Connected mailboxes using Google OAuth 2.0 and built incremental Gmail
synchronization with background processing using BullMQ."*

| Claim | Code proves | Evidence | Status |
|---|---|---|---|
| Google OAuth 2.0 | Full authorization-code flow: consent URL with offline access, code exchange, ID-token verification (signature/aud/exp/issuer/sub/email_verified), refresh token persisted | `gmail.service.ts:generateAuthUrl, getTokens, verifyGoogleIdToken` · `gmail.controller.ts:gmailCallbackController` | ✅ CONFIRMED |
| incremental Gmail sync | `historyId` cursor per mailbox, `users.history.list` with pagination, 404 → full-sync fallback, watermark captured before listing | `gmail.sync.service.ts:syncGmailAccount` · `gmail.service.ts:getHistoryChanges, getLatestHistoryId` · `schema.prisma:GmailAccount.historyId` | ✅ CONFIRMED |
| background processing | Standalone worker processes, scripts `worker:email` / `worker:attachment`, plus an in-process sync scheduler | `workers/email.worker.ts` · `attachment/attachment.worker.ts` · `gmail.scheduler.ts` · `package.json` | ✅ CONFIRMED |
| BullMQ | Two queues, retries, exponential backoff, deterministic jobIds, `UnrecoverableError` | `infrastructure/queue/queues.ts` · `email.producer.ts` · `attachment.queue.ts` | ✅ CONFIRMED |

**Caveat to know:** full sync uses `maxResults: 100` with **no pagination**. Incremental sync
*is* paginated.

---

## Bullet 3

**Resume says:** *"Designed a multi-stage event recognition pipeline combining exact matching,
temporal matching, and ambiguity handling to consolidate fragmented placement announcements."*

| Phrase | Code proves | Evidence | Status |
|---|---|---|---|
| multi-stage | Three tiers, short-circuiting at the first sufficient answer | `matching.service.ts:matchEventV2` | ✅ |
| exact matching | `eventKey = company\|stage\|date`, `findByEventKey`, backed by `@@unique([userId, eventKey])` | `event.utils.ts:generateEventKey` · `event.repository.ts:findByEventKey` | ✅ |
| temporal matching | Tier 2 `windowDays: 3`; tier 3 `windowDays: 30`; date-proximity bands 1.0/0.7/0.5 with an early return past 3 days | `event.repository.ts:findNearbyEvents, findByCompanyAndStage` · `matching.utils.ts:scoreEventMatch` · `config.ts:LOOSE_MATCH_WINDOW_DAYS` | ✅ |
| ambiguity handling | (a) CONTRADICTS vetoed pre-scoring; (b) tier 3 requires `length === 1`; (c) returns `null` when nothing qualifies | `matching.service.ts` · `matching.utils.ts:passesIdentityGate` | ✅ |

**Status: ✅ CONFIRMED** across all four phrases.

---

## Bullet 4

**Resume says:** *"Replaced a weighted-similarity approach with a confidence-aware identity
model that prevents contradictory event merges and preserves field-level history."*

| Phrase | Code proves | Evidence | Status |
|---|---|---|---|
| weighted-similarity approach existed | `scoreEventMatch` — the exact formula, still present | `matching.utils.ts:scoreEventMatch` | ✅ (as history) |
| **"Replaced"** | ⚠️ The formula is **unchanged**. What changed is that it now runs *only after* a categorical gate. | `matching.service.ts` — two separate loops: gate, then rank | 🟡 **PARTIAL — phrasing** |
| confidence-aware | Confidence gates admission (0.6), protects the incumbent (`newConf < existingConf`), and is 20% of ranking as `min()` | `email.service.ts` · `event.service.ts` · `matching.utils.ts` · `config.ts:CONFIDENCE_THRESHOLD` | ✅ |
| identity model | `IdentityRelation = AGREES \| UNKNOWN \| CONTRADICTS`, sentinel → `null` | `matching.utils.ts:classifyRoundIdentity, resolveRound` | ✅ |
| prevents contradictory merges | Gate + parametrized regression sweep asserting the scorer is never called | `matching.service.ts` · `matching.service.test.ts` D-1 sweep | ✅ (see scope note) |
| field-level history | One `EventUpdate` row per changed field, in the same transaction | `event.service.ts` `$transaction` block · `schema.prisma:EventUpdate` | ✅ |

### 🟡 The one wording risk on your whole resume

**"Replaced" reads as "deleted".** An interviewer who opens `matching.utils.ts` will find
`scoreEventMatch` intact and may conclude you overstated.

**Correct phrasing to use out loud:**
> *"The formula is unchanged. What I replaced is its **authority** — it used to decide both
> whether a candidate was the same event and which one to pick. Now identity is decided
> categorically before it runs, and the score only ranks candidates that already qualified."*

### Scope note on "prevents"
It prevents the **entire class of contradicted-round merges**. It does not prevent two distinct
rounds *of the same type*, same company, within 30 days — tier 3 can still match those. That
residual is bounded to 30 days deliberately. Say so if pushed on "prevents".

---

## Bullet 5

**Resume says:** *"Validated extraction and event matching on 50+ real placement emails using
120 automated tests, uncovering edge cases in event identification and update handling."*

| Claim | Code proves | Evidence | Status |
|---|---|---|---|
| **120 automated tests** | **125** explicit `it()`/`test()` declarations; **~214** cases at runtime; **11** suites | `src/**/__tests__/*.test.ts` | ✅ **CONFIRMED** (conservative) |
| Validated extraction | `parser.test.ts` (18→~28), `date-evidence.test.ts` (20), `confidence.test.ts` (3) | those files | ✅ |
| Validated event matching | `matching.service.test.ts` (37→~60) | that file | ✅ |
| **50+ real placement emails** | No fixtures directory, no `.eml` files. But: **11 real downloaded attachments** in `backend/storage/attachments/` (8 PDF, 2 DOCX, 1 XLSX), ~52 inline email-body strings in tests, and specific real emails documented verbatim in the Notion log | `backend/storage/attachments/` · test files · Notion "Issues" section | 🟡 **PARTIAL** |
| uncovered edge cases | Every major test file pins a specific real bug | see below | ✅ |

### On "50+ real emails"
**Real, manual, not committed.** `/storage` is gitignored, and the emails contained other
students' names, registration numbers and branches.

**Safe phrasing:**
> *"I ran it against my own mailbox and a set of real TPO emails — around fifty over the course
> of development. I didn't commit them as fixtures because they contain other students'
> personal data, so what's in the repo is the regression tests derived from them."*

**Never say** "I have 50 test emails in the repo."

### Edge cases genuinely uncovered (all in the suite)
identity: contradicted round merges · unknown-vs-unknown treated as agreement · cross-cycle
loose match · the `"unknown"` company event.
update handling: partial email wiping fields · explicit-null vs missing venue · confidence not
flowing · manual authority vs equal confidence.
extraction: AI-fabricated dates · quoted-reply-chain dates · explicit year overwritten · greedy
venue regex.

---

# PLACEMENT TRACKER — technology list

| Technology | Depth in code | Evidence | Status |
|---|---|---|---|
| **Node.js** | 3 processes, ESM/NodeNext, top-level await | `server.ts`, `tsconfig.json`, `package.json` | ✅ CONFIRMED |
| **Express.js** | v5, 4 route modules, session/CORS/trust-proxy middleware, health routes | `app.ts`, `*/*.routes.ts` | ✅ CONFIRMED |
| **TypeScript** | `strict: true`, discriminated unions, type guards, generics | `tsconfig.json`, `matching.utils.ts`, `structured-completion.ts` | ✅ CONFIRMED |
| **PostgreSQL** | 7 models, 18 migrations, composite FKs, composite uniques, composite indexes | `prisma/`, `docker-compose.yml` | ✅ CONFIRMED |
| **Prisma ORM** | v7 + `@prisma/adapter-pg`, interactive transactions, nested creates, pooled/direct split | `lib/prisma.ts`, `prisma.config.ts`, `event.service.ts` | ✅ CONFIRMED |
| **Redis** | Two clients (ioredis for BullMQ, node-redis for sessions), documented reasons | `infrastructure/redis/*` | ✅ CONFIRMED |
| **BullMQ** | 2 queues, 2 workers, retries, backoff, deterministic jobIds, `UnrecoverableError` | `queues.ts`, `*.worker.ts` | ✅ CONFIRMED |
| **Gmail API** | messages.list/get, history.list, getProfile, attachments.get, recursive MIME walk | `gmail.service.ts` | ✅ CONFIRMED |
| **OAuth 2.0** | Full auth-code flow + ID-token verification. ⚠️ `state` parameter missing | `gmail.service.ts`, `gmail.controller.ts` | ✅ CONFIRMED (gap noted) |
| **OpenAI API** | `gpt-4o-mini` @ temp 0, behind a provider abstraction — **but `USE_AI=false` by default** | `extraction.service.ts`, `modules/ai/` | 🟡 **PARTIAL** |
| **Jest** | 11 suites, manual mocks, `requireActual` wrapping, parametrized suites, documented config | `jest.config.cjs`, `__tests__/`, `__mocks__/` | ✅ CONFIRMED |
| **Docker** | **`docker-compose.yml` runs `postgres:16` only.** No app Dockerfile, no Redis service | `backend/docker-compose.yml` | 🟡 **PARTIAL** |

### 🟡 OpenAI — how to frame it
> *"The LLM path is behind a feature flag and it's off by default. That was deliberate — regex
> is the floor the system can always stand on, the model is the ceiling for phrasings I didn't
> anticipate, and it means the whole test suite runs without an API key. When it's on, results
> merge field by field and the AI's date is validated against the source text before it's
> accepted."*

That's a **stronger** answer than "I use GPT for extraction."

### 🟡 Docker — how to frame it
> *"Docker Compose runs my local Postgres — that's it. The app isn't containerised; it deploys
> to Render from source."*

**Do not** describe multi-stage builds or a containerised app.

---

# CODESYNC — bullets

## Bullet 1

**Resume says:** *"Remote technical interview platform pairing a live video call with an
in-browser code editor and multi-language code execution."*

**Code proves:** `MeetingRoom.tsx` renders a `ResizablePanelGroup` — Stream video on the left,
`CodeEditor` (Monaco) on the right. `CodeEditor.tsx` supports JavaScript, Python, Java and C++
with a Judge0 language-id map.

**Evidence:** `src/components/MeetingRoom.tsx` · `src/components/CodeEditor.tsx`

**Status: ✅ CONFIRMED**

---

## Bullet 2 — 🔴 THE ONE TO FIX

**Resume says:** *"Built collaborative interview platform integrating video conferencing,
real-time code editing, and multi-language code execution."*

| Phrase | Code proves | Status |
|---|---|---|
| video conferencing | Stream Video React SDK, `PaginatedGridLayout` / `SpeakerLayout`, `CallControls`, participants list, token minted server-side | ✅ CONFIRMED |
| multi-language execution | Judge0, 4 languages, stdin support, CPU/memory limits | ✅ CONFIRMED |
| **real-time code editing** | **`const [code, setCode] = useState(...)` — local React state. No Convex document for the editor, no Yjs, no CRDT, no shared cursor, no sync of editor content.** | 🔴 **NOT FOUND** |
| collaborative | True for scheduling/roles/feedback via Convex; **false for the editor** | 🟡 PARTIAL |

**Evidence:** `src/components/CodeEditor.tsx:12` · `convex/schema.ts` (no editor/document table)

### What to do
**Best:** reword the bullet tonight —
> *"Built an interview platform pairing Stream video with an in-browser Monaco editor and
> Judge0-backed multi-language execution, with Convex real-time sync for scheduling, roles and
> interviewer feedback."*

**If you can't**, and you're asked how the real-time editing works:
> *"I should be precise there — the real-time layer is Convex, and it syncs interview state:
> scheduling, participants, status and feedback, live through Convex subscriptions. The editor
> itself isn't collaboratively synced; each side has its own Monaco instance. Adding shared
> editing means a CRDT like Yjs, because last-write-wins on a text field loses characters when
> two people type."*

---

## Bullet 3

**Resume says:** *"Integrated Judge0 for sandboxed code execution and Convex for real-time
synchronization."*

| Phrase | Code proves | Status |
|---|---|---|
| Judge0 integration | `runCode()` POSTs to `judge0-ce.p.rapidapi.com/submissions?...&wait=true` with `language_id`, `stdin`, `cpu_time_limit: 5`, `memory_limit: 128000`; checks `status.id === 3` | ✅ CONFIRMED |
| sandboxed | True — but it's **Judge0's** sandbox, not yours | ✅ CONFIRMED (attribute correctly) |
| Convex real-time sync | `useQuery` subscriptions over `interviews`, `users`, `comments` with indexes | ✅ CONFIRMED (for that data) |
| ...of the code editor | Not implemented | 🔴 NOT FOUND |

### 🔴 Security finding you must know about
`src/components/CodeEditor.tsx` contains a **literal RapidAPI key** in the `X-RapidAPI-Key`
header, and the `fetch` runs **in the browser** — so the key is committed to the repo *and*
shipped to every visitor.

**Tonight: rotate that key.** If you have 20 minutes, move `runCode` into a Next.js server
action so the key stays server-side.

**If asked:** *"That's a real mistake — the key is in the client bundle, so it's public. Judge0
should be called from a server action with the key in an environment variable, which also gives
me a place to rate-limit. I've rotated it."*

---

## CodeSync — technology list

| Technology | Evidence | Status |
|---|---|---|
| **Next.js** | 15.3.3, App Router, route groups `(admin)` / `(route)`, server actions | ✅ CONFIRMED |
| **React** | 19 | ✅ CONFIRMED |
| **TypeScript** | throughout | ✅ CONFIRMED |
| **Convex** | `convex/schema.ts` (3 tables, 4 indexes), queries + mutations + an HTTP action | ✅ CONFIRMED |
| **Clerk** | `clerkMiddleware()`, `ConvexClerkProvider`, svix-verified webhook, `convex/auth.config.ts` | ✅ CONFIRMED |
| **Stream Video SDK** | `@stream-io/video-react-sdk` client + `@stream-io/node-sdk` server token | ✅ CONFIRMED |
| **Monaco Editor** | `@monaco-editor/react` | ✅ CONFIRMED |
| **Judge0 API** | `CodeEditor.tsx:runCode` | ✅ CONFIRMED (key exposure noted) |
| **Tailwind CSS** | v4 + shadcn/ui + Radix | ✅ CONFIRMED |

### Two authorization gaps in CodeSync (know them)
- `convex/interviews.ts:updateInterviewStatus` has **no `ctx.auth.getUserIdentity()` check**,
  unlike every other mutation. Any authenticated caller could patch any interview's status.
- `convex/users.ts:getUsers` returns **all users** to any authenticated caller.

If asked how authorization works: *"Every Convex function checks `getUserIdentity()` — except
`updateInterviewStatus`, which I noticed is missing it. That's a real gap; it should verify the
caller is an interviewer on that interview."* Owning it reads as rigour.

---

# SKILLS LIST

| Skill | Evidence | Status |
|---|---|---|
| C++ | Not in either repo (LeetCode) | ⚪ external |
| JavaScript / TypeScript | Both projects, `strict` | ✅ |
| SQL | Raw SQL in migrations, `$queryRaw` health check; most queries via Prisma | 🟡 PARTIAL — you write SQL, but day to day you write Prisma |
| Node.js / Express.js / REST APIs | Placement Tracker backend | ✅ |
| BullMQ / Redis | 2 queues, 2 Redis clients | ✅ |
| React.js | Placement Tracker client (React 19) | ✅ |
| Next.js | CodeSync (15, App Router, server actions) | ✅ |
| Tailwind CSS | CodeSync | ✅ |
| PostgreSQL / Prisma ORM | Placement Tracker | ✅ |
| **SQLite** | **Not found in either repo** | 🔴 NOT FOUND here (may be from other work — if it isn't, drop it) |
| Git / GitHub | Real history, PRs, feature branches | ✅ |
| **Docker** | Postgres compose only | 🟡 PARTIAL |
| Jest | 11 suites | ✅ |
| Linux CLI / Bash | `scripts/fix-esm-imports.js`, npm scripts, migration tooling | 🟡 PARTIAL — real but light |
| **OAuth 2.0** | Full Google flow | ✅ |
| **Clerk** | CodeSync | ✅ |
| **JWT** | You **verify** JWTs (Google ID token, Clerk via Convex). Placement Tracker uses **server-side sessions, not JWTs** | 🟡 PARTIAL |
| Coursework: DSA/OS/OOP/DBMS/CN | Academic | ⚪ n/a |
| Areas: Backend Development | Strongly demonstrated | ✅ |
| **Areas: Distributed Systems** | Queues, workers, at-least-once, idempotency. **No** consensus/replication/sharding/partition tolerance | 🟡 PARTIAL |
| Areas: DSA | LeetCode Biweekly 185 — 1,588 / 39,261 (~top 4%) | ⚪ external |

### The three skill-list items to frame carefully

**SQLite** — if it isn't from coursework or another project, **drop it tonight.** It's a
one-word claim with zero upside and a real downside.

**JWT** — say: *"I've verified JWTs — Google ID tokens and Clerk's — but for my own session
layer I chose server-side sessions over JWTs, because revocation matters more than statelessness
here. The session stores a user id, not a snapshot, so disabling a user takes effect on their
next request rather than their next login."* That's a **better** answer than "yes I use JWT."

**Distributed Systems** — say: *"The distributed-systems problems I actually hit were
at-least-once delivery and idempotency — a queue and a database are two systems and you can't
write atomically across them without distributed transactions, so I made the work idempotent
instead. I haven't built consensus or replication."* Naming the boundary yourself is stronger
than being walked past it.

---

# SUMMARY

## Fully defensible — say freely
Reconciliation model · OAuth 2.0 · incremental Gmail sync · BullMQ background processing ·
multi-stage recognition (exact / temporal / ambiguity) · confidence-aware identity model ·
field-level history · 120 automated tests · PostgreSQL/Prisma depth · Redis · Jest ·
CodeSync video + Judge0 execution + Clerk.

## Needs a precise sentence — prepare these
| Claim | The sentence |
|---|---|
| "Replaced a weighted-similarity approach" | *"The formula is unchanged — I replaced its authority."* |
| "50+ real placement emails" | *"Run manually against a real mailbox; not committed, because they contain other students' personal data."* |
| "OpenAI API" | *"Behind a flag, off by default — regex is the floor, the model is the ceiling."* |
| "Docker" | *"Compose runs my local Postgres; the app isn't containerised."* |
| "JWT" | *"I verify JWTs; I chose server-side sessions for my own auth, for revocation."* |
| "Distributed Systems" | *"At-least-once and idempotency — not consensus or replication."* |
| "prevents contradictory merges" | *"Prevents the contradicted-round class; a same-round collision inside 30 days is still possible."* |

## 🔴 Fix or pre-empt tonight
1. **CodeSync "real-time code editing"** — not implemented. Reword the bullet, or lead with the
   correction.
2. **Judge0 API key hardcoded and client-side** — rotate it.
3. **SQLite** on the skills list — no evidence in either repo. Drop it unless it's from
   elsewhere.
4. **OAuth `state` parameter missing** — not a resume claim, but the obvious follow-up to
   "OAuth 2.0". Have the answer ready.
