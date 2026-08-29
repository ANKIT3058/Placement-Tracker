# 11 — Security, Deployment, and Operations

Only what's actually in the repository. All ✅ **Current** unless tagged.

---

# Part 1 — Authentication

## How a user signs in

There is exactly one way in: **Google OAuth.** No passwords, no email/password table, no
"forgot password" flow — and none of the attack surface that comes with them.

```
GET /gmail/auth        → redirect to Google's consent screen
GET /gmail/callback    → exchange code → verify id_token → resolve User
                       → link GmailAccount → establish session
```

Notice: signing in and connecting a mailbox are **the same action**. That's a deliberate
simplification — the product has no use for an account with no mailbox — but it also means
there's no separate "sign in without granting Gmail access" path.

## Verifying the identity

`verifyGoogleIdToken` in `gmail.service.ts` checks, in order:
- **signature** against Google's published keys
- `aud` matches our `GOOGLE_CLIENT_ID`
- `exp` not expired
- `iss` in an explicit allowlist (`accounts.google.com`, `https://accounts.google.com`) —
  checked explicitly even though the library also validates it, because "a silent library
  default" isn't a check this codebase can be *shown* to make
- `sub` present, `email` present
- `email_verified === true` — **absent is treated as unverified**, because reading a missing
  value as "verified" would invert the guard

An unverified address is refused **before any write**. Accepting one would let an identity be
created around an address the holder hasn't proven they control, and a later verified login
for the same address couldn't safely be merged into it.

Why not just call the userinfo endpoint? Because that only proves *some* access token is
valid — not that the response is a signed statement about *this client's* user.

## Identity is keyed on `googleSub`, never email

Email is mutable. A Workspace administrator can rename it or reassign it to a different
person. `googleSub` is opaque and immutable. `User.email` deliberately has **no** unique
constraint.

The upsert is a single statement, not read-then-write: two concurrent callbacks for the same
identity — a double-clicked consent screen is enough — would both miss on the read and both
attempt an insert, and the second would fail on the unique constraint.

Profile fields (name, avatar, email) are refreshed on every login because Google owns them.
**`status` is deliberately never written**, so a login can never resurrect a disabled user.

---

# Part 2 — Sessions

Server-side sessions in Redis (`express-session` + `connect-redis`), key prefix `sess:`.

## The cookie

`src/modules/auth/session.config.ts`:

| Attribute | Value | Why |
|---|---|---|
| `httpOnly` | **always true** | Removes the cookie from any script's reach — the entire reason to prefer a session id over a token in web storage |
| `secure` | production only | So local http development works |
| `sameSite` | **`lax`, not `strict`** | The OAuth callback is a cross-site top-level navigation back from Google. `Strict` would withhold the cookie on that first request. |
| `path` | `/` | |
| `domain` | only if `SESSION_COOKIE_DOMAIN` is set | Needed only for `app.x.com` + `api.x.com` under one registrable domain |
| name | `__Host-placement.sid` in production **when no domain is set**, else `placement.sid` | The `__Host-` prefix binds the cookie to the exact origin and `Path=/`; browsers reject it if `Secure` is absent or `Domain` is set — so it's applied exactly when both conditions hold |

**The consequence of `SameSite=Lax` is a rule the whole codebase follows:** Lax sends the
cookie on cross-site top-level **GET** navigations. So a state-changing GET is CSRF-reachable
from any page that can navigate the browser. That's why logout is `POST /auth/logout` and
sync is `POST /gmail/sync`, not GETs. The method change is a security fix, not a style choice.

## Two lifetimes

```
SESSION_IDLE_TTL_MS          = 7 days    rolling — refreshed on every response
SESSION_ABSOLUTE_LIFETIME_MS = 30 days   set once at login, never extended
```

`rolling: true` refreshes the cookie and the Redis TTL on every response, which is what makes
the idle timeout *idle*. But an idle-only timeout means an actively-used session lives
forever — so `absoluteExpiresAt` is a hard ceiling checked by `requireAuth` on every request.
A stolen session cannot be kept alive indefinitely by using it.

A session with **no** ceiling recorded is treated as expired, not trusted — that can only be a
record written before the field existed.

## What the session stores — and what it deliberately doesn't

Stores: `userId`, `googleSub`, `createdAt`, `lastSeenAt`, `absoluteExpiresAt`, and `ip` /
`userAgent`.

**It stores `userId`, never a snapshot of the user.** Authorization has to reflect *current*
state: a user disabled or deleted after their session was created must be rejected on their
**next request**, not their next login. A cached copy of the row would defeat that. That's why
`requireAuth` re-reads the user from Postgres on every authenticated request.

`ip` and `userAgent` are recorded for forensics only and are **never** an authorization input
— both are client-controlled, and binding a session to them breaks legitimate users on mobile
networks and browser upgrades.

**Nothing derived from Google's tokens goes in the session.** Refresh tokens live on
`GmailAccount` and never leave the backend. A session is an identity record, not a credential
store.

## Session fixation and lifecycle

`establishSession` calls `req.session.regenerate()` **first, always** — issuing a new session
id and discarding the pre-authentication one. An attacker who plants a known id on a victim's
browser before login holds an id that stops existing the moment the victim authenticates.

Then `save()` before returning, so the record is durable in Redis before the response carrying
its cookie is sent. Otherwise the browser can present a cookie whose session hasn't been
written yet.

Then it indexes the session id in `user_sessions:{userId}` (a Redis Set with an expiry).
That's for **bulk revocation** — "log out everywhere", disabling a user, deleting an account
— which the `sess:*` keyspace can't answer without a scan. Members can go stale (a session
that expires by TTL is removed from the store but not from the Set), so consumers must treat
a member as a candidate. 🚧 The index is written and maintained but **nothing consumes it
yet** — there's no "log out everywhere" endpoint.

Logout (`destroySession`) captures the id and owner *before* `destroy` empties the session,
clears the cookie **with the same attributes it was set with** (a browser ignores a clear
whose attributes don't match), and de-indexes. Google grants are deliberately untouched —
mailbox connections survive logout.

## `requireAuth`

```
no session / no userId          → 401
past absolute lifetime          → destroy session, 401
database read fails             → 500  (not 401 — a DB outage is not an auth failure, and
                                        telling a valid caller to log in again can't help)
user missing or soft-deleted    → destroy session, 401
user.status !== "active"        → destroy session, 401  (not 403)
otherwise                       → req.user = { id, publicId, googleSub, email, name, imageUrl }
```

**Every failure returns the identical response**, with no detail about which check failed.
Distinguishing "no session" from "expired" from "disabled" tells an unauthenticated caller
whether a session id was real and whether an account exists behind it. The reason is logged
server-side, where it's useful and not disclosed.

`req.user` is deliberately **not** the whole row — `status` and `deletedAt` are omitted
because they've already been checked, and carrying them downstream invites a second,
eventually-divergent check.

---

# Part 3 — Authorization and multi-tenancy

**Authentication answers *who is calling*. Authorization answers *which rows they may
touch*.** They're deliberately separate mechanisms in this codebase.

`requireAuth` does the first and nothing else. The second happens at the **persistence
boundary**, via `TenantContext`:

```ts
export type TenantContext  = { userId: number };   // what the CALLER claims (from the session)
export type OwnershipContext = TenantContext;      // what a ROW records (re-derived from the DB)
```

Same shape, different provenance, and the alias is kept rather than collapsed because the
distinction is real at the call site: an `OwnershipContext` is never trusted from a request or
a queue payload.

`requireTenantContext(req)` **throws** if `req.user` is missing rather than returning null —
reaching it without a user means a route was mounted without `requireAuth`, which is a wiring
mistake, and returning null would let that mistake degrade into an unscoped query.

**Three enforcement layers:**
1. **Type.** `TenantContext` is a required parameter, never ambient state. A service that
   takes one cannot be called without it.
2. **Query shape.** `findFirst({ where: { id, userId } })` instead of `findUnique({ where:
   { id } })`; `updateMany({ where: { id, userId } })` instead of `update`. A refused
   cross-tenant write resolves with `{ count: 0 }` — **observable**, not silent.
3. **Database.** Composite foreign keys on `(parentId, userId)` (see
   [ch. 07](07-DATABASE-DESIGN.md)).

**API contract:** `GET /event/:id` answers **404** for both "no such event" and "not yours".
A 403 would confirm the existence of a record the caller may not see, and event ids are
sequential and trivially enumerable. 403 stays reserved for origin/CSRF rejection.

---

# Part 4 — Secrets and credential handling

| Secret | Where it lives | Notes |
|---|---|---|
| `GOOGLE_CLIENT_SECRET` | env | Only used server-side in the code exchange |
| `refreshToken` | `GmailAccount.refreshToken`, plaintext column | 🚧 **Not encrypted at rest.** A real gap — see below. |
| `SESSION_SECRET` | env, comma-separated list | Signs the session cookie |
| `OPENAI_API_KEY` | env | Only read when `USE_AI=true` |
| `DATABASE_URL` / `DIRECT_DATABASE_URL` | env | |

**Fail loud, never default.** `parseSessionSecrets()` throws in production if
`SESSION_SECRET` is unset:
> *"A missing secret must never degrade to a default: an attacker-known signing key forges
> session cookies, and the failure is silent."*

In development it falls back to a marked insecure default and logs a warning. Same pattern in
`session-redis.ts`: a missing Redis URL is fatal in production only, because a session store
silently pointing somewhere unintended is a security failure — while local development and
the test run must not require a Redis to import a module.

**Secret rotation is built in.** `SESSION_SECRET` accepts a comma-separated list:
express-session signs with the first and accepts any of them on verification. Prepend a new
key, wait out the session lifetime, retire the old one.

## The logging lesson

🕘 During early Gmail work, `console.log(tokens)` printed the whole token object — including
the refresh token — to stdout. Refresh tokens grant long-lived mailbox access; logging them
puts them in log aggregators, screenshots, and potentially in a commit.

Removed, and `getTokens` now carries a comment saying the object is deliberately never logged.
Current logs are metadata only: account email, sync mode, message counts, job ids, user ids.

**One-line takeaway:** treat OAuth tokens like passwords. They belong in logs, commits,
screenshots and documentation exactly as often as a password does — never.

## Login CSRF: `state` + PKCE on the OAuth flow

🕘 **This chapter used to list "the `state` parameter is missing" as the single
highest-priority fix. It has been implemented.** If you have practised the old answer,
unlearn it — claiming a gap you have since closed is as wrong as claiming a feature you never
built.

`gmailAuthController` generates two secrets per flow and stores both on the anonymous session
before redirecting:

| Value | Sent to Google | Kept server-side | Purpose |
|---|---|---|---|
| `state` — 32 random bytes, base64url | yes | yes, to compare | Binds the authorization response to the browser that started the flow |
| `codeVerifier` — 32 random bytes | **no** | yes | The PKCE secret |
| `codeChallenge` = SHA-256(verifier) | yes | — | `code_challenge_method: S256`, never `plain` |

The session is saved **before** the redirect, not after: `saveUninitialized: false` means an
anonymous session is not written unless it is saved explicitly, so redirecting first would
send the browser to Google carrying no cookie and leave the callback with nothing to compare
against — every login would fail closed.

`readPendingOAuth` in the callback then checks, in order: a `state` was supplied; a flow is
actually open for this session; it has not passed its **10-minute TTL** (deliberately
independent of the session's own lifetime); and the supplied value equals the stored one.
**One answer for every failure** — missing, mismatched, expired, replayed — because naming
which one failed tells an attacker which half of their guess was right. The state is then
**consumed and persisted before** the token exchange, so a replay arriving mid-exchange does
not find it live.

The attack this closes is specific: without it, the endpoint would establish a session from
any valid authorization code — including one an attacker obtained for *their own* Google
identity and then induced a victim to visit, which hands the victim's browser a session for
the attacker's tenant. The code is genuine and the identity verifies in that scenario; the
only thing wrong is that it is not the end of a flow this browser started.

**Two notes for the follow-up questions:**

- **PKCE here is not "because the client cannot hold a secret".** This is a confidential
  client and it does hold one. PKCE is defence in depth on the authorization code itself — an
  intercepted code is useless without the verifier that never left the server. (If you have
  practised "PKCE is for public clients, which isn't my case", that answer is now wrong about
  this codebase.)
- `GET /gmail/auth` and `GET /gmail/callback` are the only routes exempt from `requireCsrf`,
  deliberately: the browser arrives at the callback as a top-level navigation *from Google*,
  with no application code running to attach a header. They carry `state` and PKCE instead —
  the protection appropriate to that leg of the flow.

## Application CSRF: double-submit cookie

`SameSite=Lax` on the session cookie was, for a while, the only thing refusing a cross-site
state-changing request — and it lives in the *browser*, not in this application. One change
to `SameSite=None` (the usual "fix" for a cross-origin problem) would have removed the entire
defence with no test failing.

So there is now a control the codebase owns:

```
server:  ensureCsrfCookie   → sets `placement.csrf`, a READABLE cookie (httpOnly: false)
client:  api/http.ts        → echoes it in the `X-CSRF-Token` header
server:  requireCsrf        → compares the two, exact equality
```

**`httpOnly: false` is the mechanism, not an oversight.** A token the page cannot read cannot
be double-submitted. It is safe to expose precisely because it grants nothing on its own —
unlike `placement.sid`, which stays HttpOnly. An attacker page can *cause* a request and the
browser will attach cookies, but it cannot **read** the cookie to echo it (different origin)
and cannot set the header without a preflight CORS refuses.

Three design points worth being able to defend:

1. **No server-side storage.** That is the defining property of double-submit: the cookie
   *is* the expected value, so the comparison is self-contained. It touches neither Redis nor
   Prisma, and the token is deliberately independent of `placement.sid` — it authenticates
   nothing and identifies no one.
2. **Issuance and validation are separate middlewares.** `ensureCsrfCookie` is global and
   never rejects anything; `requireCsrf` is mounted per route, on writes only, and **after**
   `requireAuth`. Combining them breaks two things at once — a signed-out visitor could never
   obtain a token, and a signed-out POST would answer 403 "bad token" where the honest answer
   is 401 "sign in".
3. **The token is stable, not rotated per request.** Rotating would race the frontend: a
   token read before one request would already be stale by the next, and two concurrent
   requests from one page would invalidate each other.

Reads are exempt because they change nothing — a cross-site GET a forgery can cause still
returns its response to an origin that cannot read it.

`POST /auth/logout` is the one route with `requireCsrf` and **no** `requireAuth`: logout is
deliberately unauthenticated and idempotent — "you are now logged out" is true either way,
and answering 401 would report whether the presented cookie was valid. A forced logout is
still a real, if minor, cross-site attack, so the token check stands alone there.

Chosen ahead of `Origin` validation because it is deployment-independent: it could not be
established that `Origin` survives the Vercel → Render rewrite, and a control that fails
closed on an unverified assumption would break every write the moment it deployed. Cookies
and headers demonstrably survive that hop — the session cookie already does.

## Known security gaps (state them; don't hide them)

1. **Refresh tokens are stored in plaintext** on `GmailAccount`. They should be encrypted at
   rest with a key from a KMS or secret manager. **Database access currently equals mailbox
   access.** This is now the highest-priority security gap.
2. **No rate limiting** on any route.
3. **`POST /email` (manual ingestion) still exists in production.** It is authenticated and
   CSRF-checked, but RFC-001 §15.2 says it should be "removed, or restricted to
   non-production."
4. **`@bull-board` is a dependency and is mounted nowhere** in `app.ts` — verified by search.
   If it ever is, it must be behind auth: it exposes and can mutate every job.
5. **Secret rotation is built but never exercised.** `SESSION_SECRET` accepts a
   comma-separated list and express-session signs with the first and verifies with all — the
   mechanism exists, it has never been used in anger.

---

# Part 5 — Deployment

> **[ch. 15 — Runtime and Deployment](15-RUNTIME-AND-DEPLOYMENT.md) is the authoritative
> chapter on what is actually running.** This part covers the web-tier topology and the
> origin rule; ch. 15 covers the worker runtime, the manual drain workflows, and what
> production deployment would require.

## The topology

```
        BROWSER  —  ONE origin for everything
             │
             ▼
   VERCEL   <project>.vercel.app                         ← always on
     /            → React 19 + Vite static build
     /assets/*    → static
     /api/:path*  → REWRITE to Render, /api stripped
             │
             ▼
   RENDER   <service>.onrender.com                       ← always on
     node dist/src/server.js  (Express 5, Node ESM, rootDir: backend)
       ├─ HTTP API
       ├─ Gmail scheduler        120 s   ┐
       ├─ Email reconciler        60 s   ├─ all PRODUCERS
       └─ Attachment reconciler   60 s   ┘
     Consumes no queue.
             │
      ┌──────┴──────┐
      ▼             ▼
  REDIS             POSTGRES (Neon)
  sess:*  sessions  pooled → runtime (Prisma adapter)
  bull:*  queues    direct → migrate (applied by hand, from a workstation)
      ▲
      │  consumed only when a human dispatches a drain
      │
  GITHUB ACTIONS — workflow_dispatch, required reviewer          ← NOT always on
    production-worker.yml            → email.worker.js
    production-attachment-worker.yml → attachment.worker.js
```

**The distinction that matters operationally:** *"the application server is running"* and
*"background work is being processed"* are separate facts here, and the first does not imply
the second. A healthy `/health`, a growing `bull:email-processing:wait` list and no new
Events is therefore the **expected steady state between drains**, not a malfunction.

## The one rule that matters

> **The origin that terminates the OAuth callback owns the session cookie. It must be the same
> origin the frontend calls for data.**

`vercel.app` and `onrender.com` are both Public Suffix List entries, so those deployments are
different **sites**, not just different origins — and a `SameSite=Lax` cookie is withheld from
cross-site subresource requests. The `/api` rewrite exists to collapse them into one origin.

**Two planes have to be routed, not one:**
```
DATA PLANE   app → /api/event → [rewrite] → Render      ← VITE_API_URL=/api
AUTH PLANE   browser → Google → /api/gmail/callback     ← GOOGLE_REDIRECT_URI
             → Set-Cookie on the Vercel origin
```
Fixing only the data plane leaves the cookie stranded on the backend origin, and a
correctly-formed same-origin request still returns 401. This was proven with live captures
during a real incident, not assumed. Full story: story #12 in
[ch. 09](09-PROBLEMS-AND-DESIGN-DECISIONS.md) and
`docs/postmortems/vercel-render-oauth-deployment.md`.

**Deployment order is not stylistic** — `docs/deployment.md` warns that doing the Google
Console step before the Render step locks you out of your own OAuth flow, including the path
that previously worked.

## Redis: two clients, deliberately

| Client | Library | Used by | Why |
|---|---|---|---|
| `redis` (`infrastructure/redis/redis.ts`) | **ioredis** | BullMQ | BullMQ requires ioredis, and requires `maxRetriesPerRequest: null` |
| `sessionRedis` (`infrastructure/redis/session-redis.ts`) | **node-redis** | `connect-redis` v10 | connect-redis v10 issues node-redis command signatures; with ioredis the SET reached Redis as `SET <key> <value> [object Object]` and the store **never wrote a session** |

They also need **different eviction policies**: BullMQ requires `maxmemory-policy noeviction`
(an evicted job key is a silently lost job), while a session store is commonly deployed with
LRU. Applied to the queue instance, LRU destroys jobs under memory pressure.

`SESSION_REDIS_URL` falls back to `REDIS_URL` so one Redis works locally — safe at the key
level, since sessions live under `sess:` and BullMQ under `bull:`. Production should point it
at its own instance. It's expressed as a separate **URL** rather than a `db` index because
Upstash exposes database 0 only (`SELECT` is unsupported).

Two more details in `session-redis.ts`:
- `disableOfflineQueue: true` — fail commands immediately while the connection is down, so a
  Redis outage produces a fast failure instead of a hung request
- the reconnect strategy returns a delay forever rather than an Error, because returning an
  Error closes the client permanently and would require a process restart to recover from a
  transient outage
- `connectSessionRedis()` is called explicitly from `server.ts` and **not** at import time,
  so importing `app` (which the test suite does) doesn't open a socket

## Health checks

```
GET /        → "Backend Running"          is the process up?
GET /health  → SELECT 1 via prisma        is the database reachable?
                { status: "ok", database: "connected" } | 500 { status: "db failed" }
```

Two levels on purpose: a process that's up but can't reach its database looks healthy on the
first and fails the second.

## CORS

```ts
cors({ origin: process.env.FRONTEND_URL, credentials: true })
```

`credentials: true` is required for cookies to cross origins at all. **CORS origin matching is
exact** — a trailing slash on `FRONTEND_URL` breaks it, which is a real bug that happened.

In the current same-origin deployment CORS barely matters, because the rewrite makes every
request same-origin. It's still needed for local development, where Vite runs on `:5173` and
the API on `:3000`.

`trust proxy` is set to `1` **in production only**: behind a TLS-terminating proxy Express
sees http on the internal hop and would refuse to send a `Secure` cookie. Trusting exactly one
hop lets it read `X-Forwarded-Proto`. Trusting the header when nothing strips it would let a
client claim its own protocol and address — hence production-only.

## What recovery does exist

Two sweeps run **in the always-on API process**, each on its own timer, and together they are
the mitigation for the Postgres/Redis dual-write gap:

| Sweep | Every | Selects | Bound |
|---|---|---|---|
| `reconcilePendingEmails` | 60 s | `pending` Emails older than 5 min | none needed — an orphan requires a failed enqueue, so it normally finds nothing |
| `reconcileOrphanedAttachments` | 60 s | `pending`/`processing` attachments, **or** `completed` ones with both parse columns NULL, older than 15 min | 100 rows per sweep |

Both are **deliberately blind to Redis**: no `getJob`, no check-then-enqueue. The
deterministic jobId is the concurrency authority and BullMQ resolves the race inside `add`
itself; asking Redis first would race the exact window the check was meant to close. Neither
sweep writes `processingStatus` — that lifecycle belongs to the worker, and a second writer
would make it ambiguous.

## Operations gaps (honest list)

- **No structured logging.** Everything is `console.log`, unaggregated. On Render you read the
  live log stream.
- **No metrics, no alerting, no tracing.**
- **Failed jobs are retained but never triaged.** `removeOnFail: false` keeps every failed
  job permanently, which is deliberate — it keeps the evidence. But combined with a
  deterministic jobId it means a permanently-failed job **occupies its own id forever**, so no
  reconciler can re-enqueue that email. `getFailedEmails` exists and is tenant-scoped, and
  nothing calls it. `backend/scripts/recovery/retry-failed-attachments.ts` closes this for
  attachments only; there is no email equivalent.
- **The workers have no permanent host.** The largest operational gap in the system, and it
  gets its own chapter — [ch. 15](15-RUNTIME-AND-DEPLOYMENT.md).
- **Attachment storage is the local filesystem**, which is ephemeral on Render — files don't
  survive a redeploy. The `StorageService` interface exists so S3 is a one-line swap.
- **The Gmail scheduler is in-process.** Two API instances means two schedulers, and it uses a
  global `getAllGmailAccounts()` rather than a tenant-scoped query. Fine for one instance,
  documented as deliberate, and the correct fix is a repeatable BullMQ job.
- **Render free tier cold-starts**, so the first request after idle is slow.
