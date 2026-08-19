# Skills Defense Checklist

Not a textbook. For each technology on your resume: **the minimum you must be able to defend**,
and **the link back to your project** — because an answer anchored in something you built beats a
definition every time.

Mark each line: ✅ solid · ⚠️ shaky · ❌ revise tonight.

---

# C++

You list it first and you have a LeetCode contest rank, so expect it.

| Must be able to explain | Anchor |
|---|---|
| Pointer vs reference | A reference can't be null or reseated; a pointer can. References for parameters you must have, pointers for optional/ownership. |
| Stack vs heap | Stack: automatic, LIFO, freed on scope exit, small. Heap: `new`/`malloc`, manual or smart-pointer lifetime, large. Stack overflow vs memory leak. |
| `vector` vs `list` | `vector` is contiguous → cache-friendly, O(1) random access, amortised O(1) push_back with doubling. `list` is O(1) splice, terrible locality. **In practice `vector` wins almost always.** |
| `map` vs `unordered_map` | Red-black tree, O(log n), **sorted iteration** vs hash table, O(1) average / O(n) worst, unordered. Pick `map` when you need order or worst-case bounds. |
| Why doubling on vector growth? | Amortised O(1) push_back. Growing by a constant gives amortised O(n). |
| OOP: the four | Encapsulation, abstraction, inheritance, polymorphism — with a real example, not a definition. |
| Virtual functions | Runtime dispatch via a vtable pointer per object. **Why a virtual destructor matters:** deleting a derived object through a base pointer without one is undefined behaviour and leaks the derived part. |
| Copy constructor / rule of three (five) | If you manage a resource you need a destructor, copy constructor and copy assignment — otherwise a shallow copy double-frees. Move constructor and move assignment make five. |
| Shallow vs deep copy | Copying a pointer copies the address, not the pointee. |
| `const` correctness | `const` member functions promise not to modify; `const T&` avoids a copy without allowing mutation. |
| Smart pointers | `unique_ptr` sole ownership (move-only), `shared_ptr` refcounted, `weak_ptr` breaks cycles. |

**If asked "where do you use C++?"** — be straight: *"Competitive programming and coursework,
not in these projects. My backend work is TypeScript."* Then pivot to something real: *"The
place C++ thinking showed up was reasoning about the matching engine's complexity — the
candidate queries are bounded so the ranking loop is over a small set."*

---

# TypeScript / JavaScript

| Must be able to explain | Anchor in your code |
|---|---|
| `type` vs `interface` | Interfaces merge and are for object shapes; types do unions, intersections and mapped types. `IdentityRelation` is a union — an interface couldn't express it. |
| Union / discriminated union | `"AGREES" \| "UNKNOWN" \| "CONTRADICTS"` — the compiler forces you to handle each case. |
| Type guards | `isResolvedCompany(c): c is string` — narrows the type at the call site. |
| Generics | `structuredCompletion<T>()` — and know its honest limit: **it asserts, it doesn't validate.** T is a compile-time claim about parsed JSON. |
| `strict` mode | `strictNullChecks` is the one that matters — it's why `time?: string \| null` forces you to handle absence. |
| `??` vs `\|\|` | `??` only falls through on null/undefined. `time: ai.time ?? regex.time` — with `\|\|`, an empty string would fall through and you'd lose an intentional value. |
| Event loop / microtasks | Call stack → microtask queue (promises) → macrotask queue (timers, I/O). Promises resolve before `setTimeout(0)`. |
| `async/await` vs promises | Same machinery, better error handling with try/catch. `await` in a loop is sequential — `Promise.all` is parallel. |
| ESM vs CommonJS | You **lived** this: `"type": "module"`, NodeNext resolution, explicit `.js` in imports, and ts-jest needing a CommonJS override because Jest runs CJS. A real, concrete answer. |
| Closures | Why `getOpenAIClient` memoizes a module-scoped `client`. |

---

# Node.js

| Must be able to explain | Anchor |
|---|---|
| Single-threaded + event loop | One JS thread; I/O is offloaded to libuv's thread pool. A CPU-bound loop blocks everything. |
| Why Node for this project | The work is I/O-bound — Gmail API, Postgres, Redis, OpenAI. Node's concurrency model fits that exactly. |
| When Node is the wrong choice | CPU-bound work. PDF parsing is the closest thing here, which is one reason it's in a separate worker process. |
| Process vs thread | Your three processes — API, email worker, attachment worker — are separate OS processes with separate memory. Scaling means more processes. |
| `process.env` and config | Fail-loud: `SESSION_SECRET` throws in production rather than defaulting. |
| Streams | Know the concept (backpressure). You don't use them heavily; don't overclaim. |

---

# Express.js / REST

| Must be able to explain | Anchor |
|---|---|
| Middleware | Ordered `(req, res, next)`. Yours: `trust proxy` → CORS → `express.json` → session → routes. **Order matters** — session must come before anything reading `req.session`. |
| `requireAuth` | Authentication only. It sets `req.user` and calls `next()`, or returns 401 with an identical body for every failure reason. |
| Status codes you actually use | 200 · **202** (accepted, not yet processed) · 400 · **401** (unauthenticated) · **403** (identity refused) · **404** (also used for "not yours") · 500 |
| Why 202 for `POST /email` | The email is accepted but not processed. 201 would claim a resource was created, and no Event exists yet — it might never. |
| Why 404 and not 403 for another user's event | 403 confirms the record exists, and ids are sequential and enumerable. |
| REST principles | Resources as nouns, HTTP verbs for actions, statelessness — and where you deviate: `POST /gmail/sync` is an action, not a resource, which is a pragmatic deviation. |
| Idempotency of verbs | GET/PUT/DELETE idempotent, POST is not. **Which is why `POST /gmail/sync` must not be a GET** — that, plus `SameSite=Lax` sending cookies on cross-site top-level GETs. |
| CORS | Browser-enforced. `credentials: true` is required for cookies. **Origin matching is exact — a trailing slash breaks it**, which happened to you. |

---

# PostgreSQL / SQL

| Must be able to explain | Anchor |
|---|---|
| Joins | INNER / LEFT / RIGHT / FULL. Be able to write a LEFT JOIN and say what NULLs mean in it. |
| Indexes | B-tree by default. Speeds reads, costs writes and storage. |
| **Composite index order** | **Leftmost-prefix rule.** `(userId, date)` serves `WHERE userId=?` and `WHERE userId=? AND date BETWEEN`, but **not** `WHERE date BETWEEN` alone. That's exactly why every index in your schema leads with `userId`. |
| Which index serves which query | `(userId, date)` → the matcher's window queries + the dashboard sort. `(userId, status)` → the review queue. |
| What's missing | No `(userId, company, date)`, so `findNearbyEvents` filters company in memory. Volunteer it. |
| Unique vs primary key | PK is unique + not null + one per table. You use unique constraints as *invariants*: `@@unique([userId, eventKey])` makes a duplicate event impossible. |
| Foreign keys | Referential integrity. Yours are **composite** — `(emailId, userId) → Email(id, userId)` — which makes a cross-tenant child unrepresentable. |
| ACID | Atomicity, Consistency, Isolation, Durability — with your example: the event update and its audit rows are one atomic unit. |
| Isolation levels | Read Uncommitted / Read Committed / Repeatable Read / Serializable. Anomalies: dirty read, non-repeatable read, phantom read. **You use Postgres's default, Read Committed. Say so.** |
| Locking | **You use none** — no `SELECT ... FOR UPDATE`, no optimistic version column. Know what you'd add and where. |
| Normalization | 1NF/2NF/3NF. Where you deliberately denormalised: `company` is a plain string, not a `companies` table, because canonicalisation ("NVIDIA" / "Nvidia" / "NVIDIA Corp") is its own subproblem. |
| Query optimization | `EXPLAIN ANALYZE`, seq scan vs index scan, and that a function on an indexed column defeats the index. |
| Transactions | `BEGIN` / `COMMIT` / `ROLLBACK`. Yours: one interactive transaction in `updateEventService`. |

**⚠️ SQL honesty:** you write raw SQL in migrations and one `$queryRaw` health check; day to day
you write Prisma. If asked to write a query on a whiteboard, you should be able to — practise a
JOIN with a GROUP BY and a HAVING tonight if you're rusty.

---

# Prisma

| Must be able to explain | Anchor |
|---|---|
| What an ORM buys you | Type safety end to end — a schema change becomes a compile error rather than a runtime one. |
| What it costs | You don't fully control the generated SQL. Your concrete example: the company filter in `findNearbyEvents`. |
| Migrations | Versioned SQL you can read. 18 of them. |
| Interactive transactions | `$transaction(async tx => ...)` — all queries use `tx`, not `prisma`. |
| Nested writes | `createEmail` writes an Email and its Attachments in one implicit transaction. |
| `findUnique` vs `findFirst` | `findUnique` needs a unique selector; `findFirst` takes any predicate. **You use `findFirst` for tenant scoping** because the predicate is `(id, userId)`. |
| `update` vs `updateMany` | `update` needs a unique selector, so it can't carry `userId`. `updateMany` can, and returns a count — so a refused write is observable. |
| N+1 | `include` / `select` to eager-load. Your `getAttachmentById` loads attachment + email + gmailAccount in one query. |
| Prisma 7 specifics | `url`/`directUrl` removed from the schema; the pooled/direct split lives in `prisma.config.ts` and the client adapter. |

---

# Redis

| Must be able to explain | Anchor |
|---|---|
| What it is | In-memory key-value store. Single-threaded command execution, so commands are atomic. |
| Data structures | String, List, Set, Sorted Set, Hash. **You use:** Sets (`user_sessions:{id}`), and BullMQ uses lists + sorted sets underneath. |
| Cache vs queue vs session store | Three different uses with three different durability needs — which is exactly why you run **two clients**. |
| Persistence | RDB (periodic snapshot) vs AOF (append-only log). RDB can lose recent writes; AOF is slower but durable. |
| **Eviction policy** | `noeviction` vs `allkeys-lru`. **BullMQ requires `noeviction` — an evicted job key is a silently lost job.** A session store is commonly LRU. Applied to the queue instance, LRU destroys jobs. That's the structural reason for two clients. |
| TTL | Sessions expire by TTL; `connect-redis` derives the key TTL from the cookie `maxAge`, and `rolling: true` refreshes it on every response. |
| Failure | Enqueue throws → the email stays `pending` with no job, and there's no sweeper. The API refuses to start if the session store is unreachable. |
| Why two client libraries | connect-redis v10 issues node-redis command signatures; with ioredis the SET reached Redis as `SET key value [object Object]` and the store **silently never wrote a session**. |

---

# BullMQ

| Must be able to explain | Anchor |
|---|---|
| Queue / worker / job | Producer adds, worker consumes, Redis stores. Two queues here. |
| Job lifecycle | waiting → active → completed / failed. `removeOnComplete: true`, `removeOnFail: false` so failures are inspectable. |
| Retries + backoff | `attempts: 3`, exponential from 2 s. |
| **Delivery semantics** | **At-least-once. Not exactly-once. Never claim exactly-once.** |
| Idempotency | By construction: pure extraction + key lookup + `detectChanges` returning `[]`. Not by a dedupe table. |
| Duplicate prevention on enqueue | Deterministic `jobId: attachment-<id>`. |
| Non-retryable failures | `UnrecoverableError` for an ownership mismatch; a swallowed `P2002` for a duplicate event. |
| Stalled jobs | A worker that dies mid-job → BullMQ redelivers. Your re-run is a no-op. |
| Concurrency | Configurable per worker; you run the default. Scaling = more worker processes. |
| Dead letters | Failed jobs stay in Redis. **No automatic reprocessing** — say so. |

---

# OAuth 2.0

| Must be able to explain | Anchor |
|---|---|
| **Authentication vs authorization** | Authentication = who you are (the ID token). Authorization = what you may access (the access token + scopes). OAuth 2.0 is an *authorization* framework; OpenID Connect layers authentication on top. |
| Authorization code flow | Redirect → user consents → `code` back → **server-to-server** exchange with the client secret → tokens. The token never touches the browser. |
| Why not implicit | Deprecated. Tokens in the URL fragment leak via history, referrers and logs. |
| Why not PKCE here | PKCE is for public clients that can't hold a secret — SPAs, mobile. You have a backend that can. |
| Access token | Short-lived (~1 hour). **You never store it.** |
| Refresh token | Long-lived, stored on `GmailAccount`, used to mint access tokens. **Store renewable credentials, not temporary ones.** |
| Scopes | `openid` (returns an ID token), `userinfo.email`, `userinfo.profile`, `gmail.readonly`. Least privilege — you never send mail. |
| `access_type: offline` | What makes Google return a refresh token. |
| `prompt: consent` | Google only issues a refresh token on first authorization; re-authorizing silently returns only an access token. |
| ID token verification | Signature against Google's keys, `aud`, `exp`, issuer allowlist, `sub`, `email_verified`. |
| **The `state` parameter** | **Yours is missing.** It's a CSRF defence: a random value tied to the user's session, sent in the auth URL and verified on the callback. Know this and volunteer it. |

---

# Sessions / cookies / web security

| Must be able to explain | Anchor |
|---|---|
| Session vs JWT | Session = server-side state, revocable instantly. JWT = self-contained, not revocable without a blocklist. **You chose sessions for revocation.** |
| `httpOnly` | Not readable by JavaScript. The whole reason a session id beats a token in `localStorage`. |
| `Secure` | HTTPS only. Production only, so local http works. |
| `SameSite` | `Lax` sends the cookie on cross-site **top-level GET navigations** — needed for the OAuth callback. **Which is exactly why state-changing routes must not be GETs.** |
| `__Host-` prefix | Binds the cookie to the exact origin and `Path=/`. Browsers reject it if `Secure` is absent or `Domain` is set. |
| Session fixation | `regenerate()` before writing to the session at login — an attacker's planted id stops existing. |
| Idle vs absolute lifetime | 7-day rolling idle, 30-day hard ceiling. Idle-only means an actively-used session is immortal. |
| CSRF | `SameSite=Lax` + POST-only state changes. **Gap: no `state` on the OAuth callback.** |
| XSS | `httpOnly` limits the damage. No `dangerouslySetInnerHTML` anywhere. |
| **The split-origin cookie problem** | *The origin that terminates the OAuth callback owns the session cookie.* Your production outage. |

---

# React / Next.js

| Must be able to explain | Anchor |
|---|---|
| `useState` / `useEffect` / `useCallback` | Dashboard.tsx uses all three; `useCallback` stabilises `fetchData` so the effect doesn't loop. |
| Derived vs stored state | Your filtered event list is **derived** from `events` — *"so it can never drift out of sync with the fetched data."* |
| Keys in lists | Stable identity for reconciliation; index-as-key breaks on reorder. |
| Server vs client components | CodeSync: `"use client"` where hooks are needed; server actions for secrets. |
| Server actions | `streamTokenProvider` — `"use server"`, uses `STREAM_SECRET_KEY`, never ships to the browser. |
| App Router | Route groups `(admin)` / `(route)`, dynamic `[id]`, `middleware.ts`. |

---

# Jest / testing

| Must be able to explain | Anchor |
|---|---|
| Unit vs integration | ~10 unit suites + one supertest integration test. |
| Mocking | `jest.mock`, manual `__mocks__`, and **`requireActual` to *wrap* rather than replace** so call history becomes observable. |
| What to mock | Everything below the layer under test. A unit test that reaches a real repository isn't a unit test. |
| Test isolation | `clearAllMocks()` in `beforeEach` — mock history leaks and produces unrelated failures. |
| Asserting absence | *"An assertion on the outcome alone can't distinguish 'correctly vetoed' from 'scored and happened to lose'."* |
| Parametrized tests | `it.each` / `test.each`; the D-1 sweep covers a space, not a point. |
| What you can't test with mocks | **Transaction rollback** — a mock has no rollback semantics. Needs a real Postgres. |

---

# Docker

⚠️ **Keep this small.** `docker-compose.yml` runs `postgres:16` and nothing else.

| Must be able to explain | |
|---|---|
| Image vs container | Image is the immutable template; container is a running instance. |
| Why Compose for local Postgres | Reproducible, disposable, no local install, and it pins the version. |
| Volumes | `pgdata` — otherwise the database dies with the container. |
| Port mapping | `5435:5432` — host 5435 to avoid clashing with a local Postgres. |
| **What you did NOT do** | No app Dockerfile, no containerised worker, no Redis service. **Say so.** |

---

# Git

Branching, PRs, conventional commits (`feat(scope):`, `fix(scope):`), merge vs rebase, and what
`.gitignore` protects — `/storage` (real attachments), `.env`, `/backups` (real data dumps).
Your history shows real feature branches and merged PRs.

---

# The four "I don't have that" answers

Rehearse these. Saying them cleanly is worth more than bluffing.

**Locking / concurrency control**
> "I don't use optimistic or pessimistic locking. Two concurrent updates to the same event would
> interleave at Read Committed — last commit wins on the row, though both audit rows are still
> written so the history stays complete. In practice one email is processed at a time per event.
> The fix is `SELECT ... FOR UPDATE` inside the transaction, or a version column with a
> compare-and-set."

**Exactly-once processing**
> "No. BullMQ is at-least-once, and you can't get exactly-once across a queue and a database
> without distributed transactions or an idempotency-key table. So I made the operation
> idempotent instead — the system tolerates duplicate processing rather than preventing it."

**Distributed systems depth**
> "The distributed-systems problems I actually hit were at-least-once delivery and idempotency.
> I haven't built consensus, replication or sharding — that's the direction I'm learning
> toward, not something I'd claim to have shipped."

**Containerisation**
> "Docker Compose runs my local Postgres. The app isn't containerised — it deploys to Render
> from source."

---

# Tonight's self-check

Score each ✅ / ⚠️ / ❌. Anything ❌, read that row's anchor.

- [ ] Composite index leftmost-prefix rule — and why every index of mine starts with `userId`
- [ ] Read Committed, and the four isolation levels
- [ ] `map` vs `unordered_map`, virtual destructor, rule of three
- [ ] Authorization code flow, and why not implicit/PKCE
- [ ] `SameSite=Lax` → why POST-only state changes
- [ ] At-least-once vs exactly-once
- [ ] `findFirst` vs `findUnique`, `updateMany` vs `update` — and why
- [ ] `??` vs `||`
- [ ] Redis eviction policy and why two clients
- [ ] Write a SQL JOIN with GROUP BY and HAVING, by hand
