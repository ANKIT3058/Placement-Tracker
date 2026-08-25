# Runbook — Authentication

Engineering Handbook — Operations
Status: operational reference. Verified against the working tree at Phase 3 completion.

---

# Purpose

How to sign in, stay signed in, sign out, connect and reconnect a Gmail mailbox,
and recover when a Google grant stops working.

Documents the system **as implemented**, including three places where the
implementation is knowingly short of [RFC-001](../rfcs/RFC-001-authentication-multi-user-foundation.md).
Those gaps are marked ⚠ and are operationally relevant — they change what you
will see in a browser.

---

# When to Use

- First sign-in on a new checkout
- The dashboard returns `401`
- Gmail sync stops returning messages
- A refresh token has been revoked or has expired
- OAuth credentials were rotated and mailboxes must be reconnected

**Do not use this** for architecture. Session design, cookie policy rationale,
and the tenant model are RFC-001 §8–§11.

---

# Prerequisites

- Backend running on `http://localhost:3000` — [local-development.md](local-development.md)
- Redis reachable (sessions are stored there; without it, sign-in fails)
- PostgreSQL reachable with all 18 migrations applied — [migrations.md](migrations.md)
- Google OAuth client configured, redirect URI registered, and your Google
  account added as a test user — [google-cloud.md](google-cloud.md)
- `backend/.env` contains `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REDIRECT_URI`

---

# Endpoints

Complete authentication-relevant surface. Nothing else exists.

| Method | Path | Auth | CSRF | Purpose |
|---|---|---|---|---|
| `GET` | `/gmail/auth` | No | No | Starts Google OAuth; `302` to Google. Bound by `state` + PKCE |
| `GET` | `/gmail/callback` | No | No | OAuth callback; resolves identity, links mailbox, **creates the session**. Bound by `state` + PKCE |
| `POST` | `/auth/logout` | No | **Yes** | Destroys the session and clears the cookie |
| `POST` | `/gmail/sync` | **Yes** | **Yes** | Syncs the caller's own mailboxes |
| `GET` | `/event`, `/event/:id` | **Yes** | No | Event reads |
| `POST` | `/event` · `PATCH` `/event/:id` | **Yes** | **Yes** | Event writes |
| `POST` | `/email` | **Yes** | **Yes** | Manual email ingestion |

⚠ **There is no `GET /auth/session`.** RFC-001 §15.1 specifies one; it is not
implemented. A client cannot ask the backend whether it is signed in — the only
signal available is whether a protected route returns `401`.

⚠ **`POST /auth/logout` is deliberately unauthenticated.** Logout must work with
an already-invalid session, and it always answers `200` whether or not a session
existed. Distinguishing the two would disclose whether a presented cookie was
valid.

---

# Procedure — sign in locally

1. Start the backend (`npm run dev` in `backend/`).

2. Open this URL in a browser:

   ```
   http://localhost:3000/gmail/auth
   ```

   Not `/auth/google`. The OAuth entry point lives under the Gmail module
   because one flow performs both sign-in and mailbox connection.

3. Complete Google consent. The consent screen requests four scopes:

   | Scope | Why |
   |---|---|
   | `openid` | Makes Google return an ID token. Without it there is no signed identity to verify |
   | `.../auth/userinfo.email` | Populates `User.email` |
   | `.../auth/userinfo.profile` | Populates `User.name`, `User.imageUrl` |
   | `.../auth/gmail.readonly` | Mailbox reads |

   The request sets `access_type=offline` and `prompt=consent`, so Google issues
   a refresh token on every pass, not only the first.

4. Google redirects to `http://localhost:3000/gmail/callback?code=…`.

5. ⚠ **The callback ends on a JSON page, not a redirect.** Expect:

   ```json
   { "success": true, "email": "you@gmail.com" }
   ```

   RFC-001 §10.1 specifies a `302` to an allowlisted `returnTo`; it is not
   implemented. You are signed in — the `Set-Cookie` arrived with this response
   — but you must navigate to the frontend yourself:

   ```
   http://localhost:5173
   ```

---

# Authentication flow

```
Browser
  │  GET /gmail/auth
  ▼
gmailAuthController                       generateAuthUrl()
  │  302 → accounts.google.com
  │  scopes: openid, userinfo.email, userinfo.profile, gmail.readonly
  │  access_type=offline  prompt=consent
  │  ⚠ no `state`, no PKCE
  ▼
Google consent
  │  302 → /gmail/callback?code=…
  ▼
gmailCallbackController
  ├─ code present?                        → 400
  ├─ exchange code for tokens             getTokens()
  ├─ id_token present?                    → 500
  ├─ verify id_token                      signature (Google JWKS), iss, aud, exp
  ├─ refresh_token present?               → 500
  ├─ resolve mailbox address              Gmail users.getProfile
  │
  ├─ IDENTITY RESOLUTION
  │    emailVerified?                     → 403
  │    upsert User on googleSub           ← never on email
  │    status === "active"?               → 403
  │
  ├─ MAILBOX LINK
  │    connectGmailAccount(email, refreshToken, user.id)
  │
  └─ SESSION CREATION
       regenerate session id              ← closes session fixation
       write { userId, googleSub, createdAt, lastSeenAt,
               absoluteExpiresAt, ip, userAgent }
       save to Redis                      ← durable before the cookie is sent
       SADD user_sessions:{userId}
       ▼
  200 JSON + Set-Cookie
```

**Identity is keyed on the Google subject (`googleSub`), never on email.** A
Workspace address can be renamed or reassigned; the subject cannot. Signing in
with a renamed address resolves to the same `User`.

All three writes are idempotent, so a retried callback converges rather than
duplicating.

---

# Session lifecycle

| Property | Value | Source |
|---|---|---|
| Store | Redis, key `sess:{sessionId}` | `session.config.ts` |
| Per-user index | Redis set `user_sessions:{userId}` | `session.service.ts` |
| Session ID | 24 CSPRNG bytes (192 bits), express-session default | `session.config.ts` |
| Idle timeout | **7 days**, rolling — refreshed on every response | `SESSION_IDLE_TTL_MS` |
| Absolute lifetime | **30 days**, set once at login, never extended | `SESSION_ABSOLUTE_LIFETIME_MS` |
| Contents | `userId`, `googleSub`, timestamps, `ip`, `userAgent` | `session.types.ts` |

The session stores `userId`, **not a copy of the User**. Every authenticated
request re-reads the row from PostgreSQL, which is what makes disabling or
deleting an account take effect on the next request rather than the next login.

`ip` and `userAgent` are recorded for forensics and are **never** authorization
inputs — binding a session to them breaks legitimate users on mobile networks.

## Cookie

| Attribute | Development | Production |
|---|---|---|
| Name | `placement.sid` | `__Host-placement.sid` (when `SESSION_COOKIE_DOMAIN` is unset) |
| `HttpOnly` | yes | yes |
| `Secure` | no | yes |
| `SameSite` | `Lax` | `Lax` |
| `Path` | `/` | `/` |
| `Domain` | unset | `SESSION_COOKIE_DOMAIN` if set |
| `Max-Age` | 7 days, rolling | 7 days, rolling |

`SameSite=Lax` is required, not preference: the OAuth callback is a cross-site
top-level navigation back from Google, and `Strict` would withhold the cookie on
exactly that request. It is also why no state-changing route may be a `GET`.

`__Host-` applies only when `Secure` is set and no `Domain` attribute is
present; browsers reject the prefix otherwise. Hence it is production-only.

## CSRF protection

**Mechanism: double-submit cookie.** The server issues a random token in a
*readable* cookie; the client echoes it in a request header; the server compares
the two for equality. There is no server-side token store — the cookie **is** the
expected value, which is what makes the comparison self-contained and why this
change touches neither Redis nor Postgres.

| | |
|---|---|
| Cookie | `placement.csrf` — **`httpOnly: false`**, `sameSite: "lax"`, `path: "/"`, `secure` in production only |
| Header | `X-CSRF-Token` (read case-insensitively as `x-csrf-token`) |
| Token | 32 random bytes, base64url — 43 characters, no percent-encoding |
| Comparison | Exact string equality |
| Rejection | `403 { success: false, message: "Invalid CSRF token" }` |

**`httpOnly: false` is the mechanism, not an oversight.** The page must be able to
read the value to echo it; a token the page cannot read cannot be
double-submitted. It is safe to expose precisely because it grants nothing on its
own — it is independent of `placement.sid`, authenticates nothing, and identifies
no one. It only proves the caller could read a same-origin cookie. `placement.sid`
stays `HttpOnly`.

**Why it stops a forgery.** An attacker's page can cause a request to this API and
the browser will attach cookies. That page cannot *read* `placement.csrf` (wrong
origin) and cannot set the header without a preflight that CORS refuses. So it
cannot produce a matching pair.

### Issuance and validation are separate middleware — deliberately

| | `ensureCsrfCookie` | `requireCsrf` |
|---|---|---|
| Mounted | **Globally**, in `app.ts`, after the session middleware | **Per route**, after `requireAuth` |
| Does | Issues or re-sends the cookie. Never reads the header, never rejects | Compares cookie against header. Never issues |

Combining them is the obvious shortcut and breaks two things at once: a signed-out
visitor could not obtain a token (no other endpoint hands one out, and both the
sign-in and logout flows need one), and a signed-out `POST` would answer `403 bad
token` where `401 sign in` is the honest answer.

**The token is stable.** An existing cookie is re-sent unchanged, never rotated
per request — rotating would race the frontend, and two concurrent requests from
one page would invalidate each other.

**Ordering is load-bearing and pinned by test:** `requireAuth` runs first, so a
signed-out caller learns they are signed out rather than being told to fix a token
they were never going to have. And `requireCsrf` runs *before the handler*, so a
refused request never reaches Prisma, the queue, the sync service, or
`destroySession` — a 403 issued after the write has already happened protects
nothing.

### Which requests are protected

**Not all of them.** CSRF is applied per route, to state-changing routes only:

| Route | `requireAuth` | `requireCsrf` |
|---|---|---|
| `POST /event` | ✅ | ✅ |
| `PATCH /event/:id` | ✅ | ✅ |
| `POST /email` | ✅ | ✅ |
| `POST /gmail/sync` | ✅ | ✅ |
| `POST /auth/logout` | ❌ *(deliberate)* | ✅ |
| `GET /event`, `GET /event/:id` | ✅ | ❌ — read |
| `GET /gmail/auth`, `GET /gmail/callback` | ❌ | ❌ — see below |
| `GET /`, `GET /health` | ❌ | ❌ — read |

**Reads are exempt because they change nothing.** A cross-site `GET` that a
forgery can cause still returns its response to an origin that cannot read it.
The writes are the whole attack surface. There is no blanket
method-based rule in the code — no middleware branches on `GET`/`HEAD`/`OPTIONS`;
exemption is simply the absence of `requireCsrf` on a read route.

**`POST /auth/logout` carries `requireCsrf` with no `requireAuth`** — the one
place that ordering appears. Logout is intentionally unauthenticated and
idempotent ("you are now logged out" is true either way, and a 401 would report
whether the presented cookie was valid), so there is no authentication step for
CSRF to follow and this check stands alone. It is still needed: an attacker page
that can end a victim's session denies them the application.

**The two OAuth entry routes are exempt, and not by oversight.** The browser
arrives at `/gmail/callback` as a top-level navigation *from Google*, with no
application code running to attach a header — forcing an application token onto it
would break every sign-in. That leg carries its own binding instead: the OAuth
`state` parameter and PKCE.

### Why `POST /gmail/sync` is a POST

The method is not cosmetic. `SameSite=Lax` sends the session cookie on cross-site
top-level `GET` navigations, so the moment a route is protected by a session
cookie, a `GET` form of it becomes CSRF-reachable from any page that can navigate
the browser. Protecting it while leaving it a `GET` would have introduced the
vulnerability that protecting it was meant to close. **This is the general rule
for this codebase: no state-changing route may be a `GET`.**

### How rejection looks, and what it does not tell you

All four failure modes — missing cookie, missing header, empty value on either
side, mismatch — return the **same** `403`. That is intentional: reporting which
one failed tells a caller probing the endpoint how close they are, and echoing the
submitted value would confirm what the server compared against. Tokens are
compared and **never logged**; the two `console.warn` lines say only that a
request was refused and why in general terms.

An empty string is explicitly not a token — without that check, a caller
presenting neither cookie nor header would compare `""` against `""` and pass.

> **Operationally:** a sudden wave of `403 Invalid CSRF token` after a deploy
> usually means the client is not sending the header, or the cookie was dropped
> — check `SESSION_COOKIE_DOMAIN` and that the API and app share one origin.
> It does **not** mean sessions are broken; a broken session answers `401`.

## Authentication middleware

`requireAuth` runs, in order:

1. `session.userId` is a number — else `401`
2. Not past `absoluteExpiresAt` — else destroy session, `401`
3. Load `User` from PostgreSQL — on database error, `500` (**not** `401`; a
   transient outage must not discard a valid session)
4. Not deleted (`deletedAt`) — else destroy session, `401`
5. `status === "active"` — else destroy session, `401`
6. Refresh `lastSeenAt`; attach `req.user`; continue

**Every failure returns the same `401` with the same body.** The reason is
logged server-side only. Distinguishing "no session" from "expired" from
"disabled" would tell an unauthenticated caller whether a session id was real
and whether an account exists behind it.

## Sign out

```bash
curl -X POST http://localhost:3000/auth/logout \
     -b "placement.sid=<cookie>" -c /dev/null
```

Destroys the Redis session, clears the cookie with matching attributes, and
removes the id from `user_sessions:{userId}`. **Google grants are not revoked** —
mailbox connections survive logout by design.

---

# Procedure — connect or reconnect Gmail

There is one flow for both. Visiting `/gmail/auth` again re-runs consent and
updates the stored refresh token.

1. Visit `http://localhost:3000/gmail/auth`
2. Complete consent, choosing the mailbox to connect
3. Confirm the JSON response names the expected address
4. Trigger a sync:

   ```bash
   curl -X POST http://localhost:3000/gmail/sync -b "placement.sid=<cookie>"
   ```

**Ownership is never transferred by a reconnect.** A mailbox already owned by a
different `User` keeps its owner; only the refresh token is updated, and a
warning is logged. This prevents a mailbox — and its entire email history —
migrating to whoever connected most recently.

⚠ Login and mailbox connection are **not separated**. RFC-001 §10 specifies
distinct flows (`/gmail/accounts/connect`); a single flow currently does both,
so reconnecting a mailbox also re-authenticates the browser session.

---

# Verification

| Check | Command | Expected |
|---|---|---|
| Backend up | `curl http://localhost:3000/health` | `{"status":"ok","database":"connected"}` |
| Unauthenticated is refused | `curl -i http://localhost:3000/event` | `401` `{"success":false,"message":"Authentication required"}` |
| Session works | `curl -i http://localhost:3000/event -b "placement.sid=<cookie>"` | `200` with a JSON array |
| Session exists in Redis | `redis-cli KEYS 'sess:*'` | at least one key |
| User row created | `npx prisma studio` → `User` | one row, `googleSub` numeric, `status = active` |
| Mailbox linked | `npx prisma studio` → `GmailAccount` | `userId` populated, matching the `User` |

---

# Common Failures

### `redirect_uri_mismatch` on the Google consent screen

**Cause.** `GOOGLE_REDIRECT_URI` does not byte-match the value registered in
Google Cloud Console — scheme, host, port, path, and trailing slash all count.

**Resolution.** Both must read exactly
`http://localhost:3000/gmail/callback`. See
[google-cloud.md](google-cloud.md#procedure--redirect-uris).

---

### `403 This Google account cannot be used to sign in`

**Cause.** One of two identity refusals, both raised before any write:

- `email_verified` is false on the Google ID token
- the resolved `User` has `status ≠ active`

**Diagnosis.** Backend log line: `[gmail-callback] Identity refused: …`, which
names which.

**Resolution.** For an unverified address, verify it with Google. For a disabled
account, set `status = 'active'` in the `User` table.

---

### `500 Failed to exchange code` immediately after consent

**Cause.** One of: no `id_token` returned (the `openid` scope was not granted),
no `refresh_token` returned, or the Gmail profile lookup failed.

**Diagnosis.** The backend logs the underlying error. Match it against the
callback's ordered checks in *Authentication flow* above.

**Resolution.** Confirm all four scopes are permitted on the consent screen and
that the Gmail API is enabled — [google-cloud.md](google-cloud.md).

---

### `401` on every protected route despite signing in

**Causes, in order of likelihood:**

1. The client is not sending cookies. `client/src/api/eventApi.ts` calls `fetch`
   **without `credentials: "include"`** — a known gap. `curl -b` works; the
   dashboard does not.
2. `FRONTEND_URL` does not match the browser origin, so CORS rejects the
   credentialed request.
3. Redis restarted; sessions are not persisted across a flush.
4. The session passed its 30-day absolute lifetime.

**Diagnosis.** `redis-cli KEYS 'sess:*'`. If the key exists, the cookie is not
reaching the server. If it does not, the session is gone.

---

### `500 Authentication check failed`

**Cause.** PostgreSQL was unreachable while `requireAuth` loaded the user. This
is deliberately not a `401` — the session is still valid.

**Resolution.** Restore the database. No re-authentication is needed.

---

### `invalid_grant` from Google

The most common Gmail failure in this project, and the one with the least
obvious message.

**Symptoms.**

- Sync returns `200` but the affected mailbox appears in the response as
  `{"status":"failed","error":"invalid_grant"}`
- Backend log: `[gmail-sync] Failed to sync mailbox <address> for user <id>` or,
  from the scheduler, `[gmail-scheduler] Failed to sync account <address>`
- No emails ingested from that mailbox; other mailboxes are unaffected
- Sign-in still works — the session is unrelated

**Cause.** The stored refresh token is no longer accepted. Google returns
`invalid_grant` for all of:

| Trigger | Notes |
|---|---|
| User revoked access | Google Account → Security → Third-party access |
| Token unused for 6 months | Google expires idle refresh tokens |
| **OAuth client is in Testing mode** | Refresh tokens expire after **7 days**. The usual cause in this project |
| OAuth client secret rotated | Old tokens are invalidated |
| Test user removed from the consent screen | Access is withdrawn immediately |
| Google account password changed | Can invalidate grants |

**Diagnosis.**

1. Confirm the token exists:
   ```sql
   SELECT id, email, "userId", length("refreshToken") FROM "GmailAccount";
   ```
   A present token that fails is a revocation, not a configuration problem.

2. Check the publishing status of the OAuth consent screen. **Testing** means
   7-day refresh tokens and recurring `invalid_grant` roughly weekly.

3. Confirm the signed-in Google account is still listed as a test user.

**Resolution — reconnect:**

1. Visit `http://localhost:3000/gmail/auth`
2. Complete consent for the same mailbox
3. `connectGmailAccount` overwrites the stored refresh token in place; ownership
   and all existing email history are preserved
4. Trigger `POST /gmail/sync` and confirm the mailbox reports `synced`

**Permanent fix.** Publish the OAuth app, or accept weekly reconnection while in
Testing mode. See [google-cloud.md](google-cloud.md#oauth-consent-screen).

---

# Recovery

## Force a user to sign in again

```bash
redis-cli DEL sess:<sessionId>
# or, all sessions for one user:
redis-cli SMEMBERS user_sessions:<userId> | xargs -I{} redis-cli DEL sess:{}
redis-cli DEL user_sessions:<userId>
```

## Invalidate every session

```bash
redis-cli --scan --pattern 'sess:*' | xargs redis-cli DEL
```

Rotating `SESSION_SECRET` has the same effect for cookies signed with the
retired key, and is preferable if the concern is a leaked signing key.

## Rotate the session signing secret without logging everyone out

`SESSION_SECRET` accepts a comma-separated list. The first signs; all verify.

```bash
SESSION_SECRET=<new>,<old>     # deploy, wait out the 7-day idle window
SESSION_SECRET=<new>           # then drop the old key
```

## Recover a mailbox whose grant is dead

Reconnect via `/gmail/auth`. Do **not** delete the `GmailAccount` row —
deleting it cascades and would destroy the linked `Email` history.

## Recover data owned by the legacy migration owner

If sign-in succeeds but the dashboard is empty after a migration, the data may
be parked under the legacy owner. See
[migrations.md](migrations.md#procedure--claim-legacy-data).

---

# Known gaps

Operationally relevant, all specified in RFC-001 and not implemented.

| Gap | RFC | Operational effect |
|---|---|---|
| No `GET /auth/session` | §15.1 | Client cannot determine sign-in status except by probing a protected route |
| Callback returns JSON, not a redirect | §10.1 | Users land on a raw JSON page after sign-in |
| Login and mailbox connection not separated | §10 | Reconnecting a mailbox also re-authenticates |
| Refresh tokens stored in plaintext | §13.2 | Database read discloses long-lived mailbox credentials |
| No origin validation | §11.4 | Not adopted. Origin's survival across the Vercel → Render rewrite could not be established, and a control that fails closed on an unverified assumption would break every state-changing route on deploy. Double-submit CSRF was chosen instead — see *CSRF protection* |

🕘 **Two gaps in this table have since been closed** and are recorded here so the
history is not lost:

- ~~**No OAuth `state` or PKCE** (§10.1) — "Callback is CSRF-open. A forced-login
  attack can put a victim into an attacker's tenant."~~ **Closed.** The
  authorization request now carries `state` and PKCE, and the callback verifies
  both.
- ~~**No CSRF token** (§11.4) — "State-changing routes rely on `SameSite=Lax`
  alone."~~ **Closed.** Double-submit CSRF is implemented and enforced per route
  — see the section below.

---

# Related Documents

- [RFC-001 §8–§11](../rfcs/RFC-001-authentication-multi-user-foundation.md) —
  identity model, OAuth flow, session management, cookie policy
- [google-cloud.md](google-cloud.md) — credentials, consent screen, test users
- [local-development.md](local-development.md) — starting the stack
- [troubleshooting.md](troubleshooting.md) — symptom-first index
- [Gmail_Synchronization.md](../02_Backend/Gmail_Synchronization.md) — ingestion
  architecture

---

# Confidence

**High for endpoints, flow, session configuration, and middleware behaviour.**
All read directly from `app.ts`, `gmail.route.ts`, `auth.routes.ts`,
`event.routes.ts`, `email.routes.ts`, `gmail.controller.ts`,
`auth.controller.ts`, `auth.middleware.ts`, `session.config.ts`,
`session.service.ts`, and `gmail.service.ts`. The endpoint inventory was
produced by exhaustive search for route registrations across `backend/src`.

**Medium for `invalid_grant`.** The failure has **not** been reproduced in this
environment. The listed triggers are Google's documented behaviour; the log
lines and response shape are read from `gmail.sync.service.ts` and
`gmail.scheduler.ts` and are accurate. The 7-day refresh token expiry in Testing
mode is Google policy, not a repository behaviour — re-check it against current
Google documentation before relying on it.

**Not executed.** No end-to-end sign-in was performed while writing this
document; `GOOGLE_CLIENT_ID`/`SECRET` were present in `.env` but no browser flow
was run. The `curl` verification commands are constructed from the routes, not
transcripts.

**High for CSRF.** The mechanism, cookie and header names, token size, mounting
points, per-route coverage, ordering relative to `requireAuth`, and the uniform
`403` are read directly from `csrf.ts`, `app.ts`, and the four route modules that
register `requireCsrf`. The endpoint/CSRF table was produced by exhaustive search
for `requireCsrf` across `backend/src`, and the behaviour is exercised by a
dedicated API suite.

**Known stale elsewhere.** `Development_Environment.md` §9 still documents
`GET /gmail/sync` and describes only the `gmail.readonly` scope. Both changed in
Phase 3; this runbook supersedes it.
