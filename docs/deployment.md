# Deployment guide

Canonical deployment documentation for Placement Tracker. Written for someone
cloning the repository for the first time.

> [!WARNING]
> **Read [§7 Deployment order](#7-deployment-order) before deploying anything.**
> The sequence is not stylistic — performing step 4 before step 3 locks you out
> of your own OAuth flow, including the path that previously worked. The incident
> that established this order is documented in
> [`docs/postmortems/vercel-render-oauth-deployment.md`](postmortems/vercel-render-oauth-deployment.md).

---

## Contents

| § | Section |
|---|---|
| [1](#1-overview) | Overview — architecture and the one rule that matters |
| [2](#2-prerequisites) | Prerequisites |
| [3](#3-environment-variables) | Environment variables |
| [4](#4-deploying-the-backend-render) | Deploying the backend (Render) |
| [5](#5-deploying-the-frontend-vercel) | Deploying the frontend (Vercel) |
| [6](#6-google-oauth-setup) | Google OAuth setup |
| [7](#7-deployment-order) | **Deployment order — read first** |
| [8](#8-verification-checklist) | Verification checklist |
| [9](#9-troubleshooting) | Troubleshooting |
| [10](#10-common-pitfalls) | Common pitfalls |

**Companion document:** the
[postmortem](postmortems/vercel-render-oauth-deployment.md) explains *why* this
architecture is shaped the way it is. This guide explains *how* to deploy it.

---

# 1. Overview

Two deployed artifacts, three managed services, one identity provider.

```
                       ┌──────────────────────────────────┐
                       │            BROWSER               │
                       │  cookie jar keyed by ORIGIN      │
                       └────────────────┬─────────────────┘
                                        │
                    everything — assets AND API — on ONE origin
                                        │
                                        ▼
        ┌───────────────────────────────────────────────────────┐
        │  VERCEL          <project>.vercel.app                 │
        │                                                       │
        │   /            → React 19 + Vite 8 static build       │
        │   /assets/*    → static (filesystem match wins)       │
        │   /api/:path*  → REWRITE to Render, /api stripped ────┼──┐
        └───────────────────────────────────────────────────────┘  │
                                                                   │
                                        ┌──────────────────────────┘
                                        ▼
        ┌───────────────────────────────────────────────────────┐
        │  RENDER          <service>.onrender.com               │
        │                                                       │
        │   Express 5 (Node, ESM)  ·  rootDir: backend          │
        │   express-session + connect-redis                     │
        │   requireAuth → TenantContext → scoped repositories   │
        └───────┬───────────────────────────────────┬───────────┘
                │                                   │
                ▼                                   ▼
     ┌────────────────────┐              ┌──────────────────────┐
     │  REDIS (Upstash)   │              │  POSTGRES (Neon)     │
     │  sess:*  sessions  │              │  pooled  → runtime   │
     │  bull:*  job queue │              │  direct  → migrate   │
     └────────────────────┘              └──────────────────────┘

     ┌──────────────────────────────────────────────────────────┐
     │  GOOGLE OAUTH — redirect_uri MUST point at the VERCEL    │
     │  origin, because whichever origin terminates the         │
     │  callback owns the session cookie.                       │
     └──────────────────────────────────────────────────────────┘
```

> [!IMPORTANT]
> **The single most important rule in this document:**
>
> The origin that terminates the OAuth callback **owns the session cookie**.
> It must be the same origin the frontend calls for data.

Because `<project>.vercel.app` and `<service>.onrender.com` sit under *different*
registrable domains (both `vercel.app` and `onrender.com` are Public Suffix List
entries), a cookie set on one is invisible to the other. The `/api` rewrite exists
to collapse both onto a single origin.

**Two planes must be routed through that origin, not one:**

```
DATA PLANE   app → /api/event → [rewrite] → Render        ← VITE_API_URL=/api
AUTH PLANE   browser → Google → /api/gmail/callback       ← GOOGLE_REDIRECT_URI
             → Set-Cookie on the Vercel origin
```

Fixing only the data plane leaves the cookie stranded on the backend origin, and
a correctly formed same-origin request still returns `401`. This was proven
during the incident, not assumed — see
[postmortem §5.4](postmortems/vercel-render-oauth-deployment.md#54-architecture-evolution--before-and-after).

---

# 2. Prerequisites

| Service | Purpose | Plan used |
|---|---|---|
| **[Render](https://render.com)** | Express backend | Free (see cold-start caveat, [§9](#9-troubleshooting)) |
| **[Vercel](https://vercel.com)** | React SPA + `/api` rewrite | Hobby |
| **[Neon](https://neon.tech)** | PostgreSQL | Free |
| **Redis** — [Upstash](https://upstash.com) or equivalent | Sessions + BullMQ queues | Free |
| **[Google Cloud](https://console.cloud.google.com)** | OAuth client, Gmail API | Free |

Local toolchain: Node (matching `backend/package.json` engines), npm, and a Git
client. `psql` is optional.

---

# 3. Environment variables

## 3.1 Backend — required

Template: `backend/.env.example`. Copy to `backend/.env` (gitignored).

### `DATABASE_URL` — pooled

Read by `src/lib/prisma.ts` and handed to the `PrismaPg` adapter. The runtime
issues many short-lived queries across concurrent handlers, so connection reuse is
the point.

### `DIRECT_DATABASE_URL` — direct, no pooler

Read by `prisma.config.ts` (`url: env("DIRECT_DATABASE_URL")`) and used by
`prisma migrate`, `prisma db`, and `prisma studio`.

**Why two.** Migrations take a **session-level advisory lock** to serialise
concurrent deploys. A transaction pooler such as PgBouncer cannot hold one — the
lock is acquired on one backend connection and released to another. Running DDL
through a transaction pooler is unsafe for the same reason.

On Neon the two differ only by the `-pooler` suffix on the host:

```
pooled  postgresql://USER:PASS@ep-NAME-pooler.REGION.aws.neon.tech/DB?sslmode=require
direct  postgresql://USER:PASS@ep-NAME.REGION.aws.neon.tech/DB?sslmode=require
```

On a plain local Postgres there is no pooler — set **both** to the same value.

> **Prisma 7 note.** `url` and `directUrl` were removed from `schema.prisma`. The
> split is expressed by *which side reads which variable*, not by schema config.
> Neither may be omitted: `env()` throws rather than falling back.

### `REDIS_URL`

Required by BullMQ and both workers.

### `SESSION_REDIS_URL`

Session store. Falls back to `REDIS_URL` when unset, which is fine locally —
sessions live under `sess:` and BullMQ under `bull:`, so they cannot collide.

**Point this at a separate instance in production.** The queue instance must run
`maxmemory-policy noeviction` (an evicted job key is a lost job); a session store
may not. Sessions expire by TTL, never by eviction.

### `SESSION_SECRET`

Signing key for the session cookie. **Required in production** — the process
refuses to start without it, because a default signing key is a forgeable session
cookie and the failure would otherwise be silent.

Comma-separated values enable rotation: the first signs, all of them verify.
Prepend a new key, wait out the session lifetime, then drop the old one.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### `FRONTEND_URL`

CORS origin (`src/app.ts`). With the `/api` rewrite in place, requests are
same-origin and carry no `Origin` header, so CORS becomes vestigial — but keep it
accurate for any direct access.

### `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

From the Google Cloud OAuth client. Leave blank to run without mailbox sync; the
manual `POST /email` path still works.

### `GOOGLE_REDIRECT_URI` — **the variable that decides cookie ownership**

Must match the Google Console entry **byte for byte** — scheme, host, port, path.

```
production   https://<project>.vercel.app/api/gmail/callback     ← Vercel origin
local        http://localhost:3000/gmail/callback
```

**In production this must be the Vercel origin, not Render.** See
[§6.5](#65-why-the-callback-is-routed-through-vercel).

## 3.2 Backend — optional

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Set to `production` in deployments. Enables `Secure` cookies, the `trust proxy` hop, and the hard failure on missing `SESSION_SECRET`. |
| `SESSION_COOKIE_DOMAIN` | unset | **Leave unset for this architecture.** Only for API + frontend on different hosts under *one* registrable domain. Setting it drops the `__Host-` prefix; setting it to a public suffix (`.vercel.app`) makes browsers reject the cookie outright. |
| `PORT` | `3000` | Render overrides this. |
| `USE_AI` | `false` | `"true"` enables the OpenAI extraction path. Compared against the literal string. |
| `OPENAI_API_KEY` | — | Required only when `USE_AI=true`. |
| `GMAIL_SYNC_INTERVAL_MS` | `120000` | Background scheduler interval. |
| `ATTACHMENT_STORAGE_DIR` | `<cwd>/storage/attachments` | Downloaded attachments. |

## 3.3 Frontend

One variable. **Vite inlines it at build time** — changing it requires a
**rebuild**, not just a restart.

| Environment | Value | Why |
|---|---|---|
| **Production (Vercel)** | `/api` | Relative → same-origin → cookie attached under fetch's default `same-origin` credentials mode |
| **Local development** | `/api` | `vite.config.ts` already proxies `/api` → `localhost:3000` with the same prefix strip |

`client/.env` is **tracked** and holds `/api`, which is correct in both
environments. A deployment that omits the Vercel variable therefore falls back to
something that works.

> **Precedence.** Vercel's dashboard variable **overrides** the committed
> `client/.env`. If the dashboard holds a stale absolute URL, it silently wins.
> Always verify against the built bundle (§8).

> [!CAUTION]
> **Never give this value a trailing slash.** `eventApi.ts` appends `/event`, so
> `…/` + `/event` = `//event`, which Express does not route — a `404` that the
> dashboard renders as "No events yet". This was the first root cause of the
> 2026-08-05 incident
> ([postmortem §5.2](postmortems/vercel-render-oauth-deployment.md#52-the-url-concatenation-bug-first-root-cause-resolved)).

---

# 4. Deploying the backend (Render)

### 4.1 Create the service

| Setting | Value |
|---|---|
| Type | Web Service |
| Repository | this repo |
| Branch | `main` |
| **Root directory** | `backend` |
| Runtime | Node |
| **Build command** | `npm install && npx prisma generate && npm run build` |
| **Start command** | `npm start` |
| Auto-deploy | on commit (optional) |

`npm run build` runs `prisma generate && tsc && node scripts/fix-esm-imports.js`.
The explicit `npx prisma generate` in the build command is belt-and-braces.

### 4.2 Environment variables

Set everything from §3.1. `NODE_ENV=production` and `SESSION_SECRET` are
mandatory — the process throws on boot without the latter.

Leave `GOOGLE_REDIRECT_URI` pointing at its **current working value** for now.
You will change it in [§7](#7-deployment-order) step 4, *after* Google Console is
updated.

### 4.3 Neon

Create the project, then copy **both** connection strings (§3.1). Confirm the
pooled one carries the `-pooler` host suffix and the direct one does not.

### 4.4 Redis

Create the instance and set `REDIS_URL`. For production also set
`SESSION_REDIS_URL` to a separate instance.

Verify the queue instance uses `noeviction`:

```bash
redis-cli -u "$REDIS_URL" INFO memory | grep maxmemory_policy
# maxmemory_policy:noeviction
```

### 4.5 Migrations

Migrations are **not** run by the build command. Apply them deliberately:

```bash
cd backend
DIRECT_DATABASE_URL="<direct-url>" npx prisma migrate status   # read the Datasource line
DIRECT_DATABASE_URL="<direct-url>" npx prisma migrate deploy
```

Use `migrate deploy` in deployed environments — it applies pending migrations
without a shadow database and without reset. `migrate dev` is for local schema
development only; it replays the entire chain against a temporary shadow
database. See [`docs/runbooks/migrations.md`](runbooks/migrations.md).

### 4.6 Health check

```bash
curl https://<service>.onrender.com/health
# {"status":"ok","database":"connected"}
```

Boot logs should show:

```
✅ Redis connected
✅ Redis (session) connected
Server running on port 10000
```

If you see `[session] SESSION_SECRET is unset — using an insecure development
default`, then `NODE_ENV` is not `production`. Fix before proceeding.

---

# 5. Deploying the frontend (Vercel)

| Setting | Value |
|---|---|
| Framework preset | Vite |
| **Root directory** | `client` |
| Build command | `npm run build` (default) |
| Output directory | `dist` (default) |
| Environment variable | `VITE_API_URL=/api` (Production) |

### The rewrite

`client/vercel.json` is committed:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://<service>.onrender.com/:path*"
    }
  ]
}
```

**Update the destination host** to match your Render service. Vercel does not
interpolate environment variables into rewrite destinations, so this value is
necessarily hard-coded.

Notes:

- The rewrite is **prefix-generic**, so it covers `/api/gmail/auth` and
  `/api/gmail/callback` as well as the data routes. This is required — the OAuth
  flow must traverse the proxy, not just the data plane.
- Static filesystem matches take precedence over rewrites, so `/assets/*` still
  serves normally.
- `/api` maps to the backend root; `/api/health` maps to `/health`.

---

# 6. Google OAuth setup

### 6.1 Create the client

Google Cloud Console → APIs & Services → Credentials → **OAuth client ID** →
Web application. Enable the **Gmail API** for the project.

Scopes requested by `generateAuthUrl()` (`gmail.service.ts`):

```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/gmail.readonly
```

`openid` is what makes Google return an ID token; without it there is no signed
identity to verify.

### 6.2 Authorized JavaScript origins

```
https://<project>.vercel.app
```

### 6.3 Authorized redirect URIs

```
https://<project>.vercel.app/api/gmail/callback      ← production
http://localhost:3000/gmail/callback                 ← local development
```

### 6.4 Why the redirect URI must match exactly

Google compares the `redirect_uri` in the authorization request against the
registered list as an **exact string** — scheme, host, port, path, trailing
slash. Any difference yields `Error 400: redirect_uri_mismatch` before the user
sees a consent screen.

The backend builds it from `GOOGLE_REDIRECT_URI`
(`gmail.service.ts` → `new google.auth.OAuth2(..., process.env.GOOGLE_REDIRECT_URI)`),
and `generateAuthUrl()` derives the authorization URL from that same client. One
variable drives both the authorization request and the token exchange.

### 6.5 Why the callback is routed through Vercel

**`Set-Cookie` is attributed to the origin the browser believes it is talking
to** — not to whichever server generated the header. The OAuth callback is the
only place a session cookie is minted. Therefore:

> Whichever origin terminates the OAuth callback owns the session cookie.

If Google redirects to `<service>.onrender.com/gmail/callback`, the cookie is
filed under `onrender.com`. The app then calls `<project>.vercel.app/api/event`,
the browser attaches cookies belonging to `vercel.app` — of which there are
none — and the request is refused with `401 Authentication required`.

**The rewrite alone does not fix this.** Routing the *authorization request*
through the proxy changes nothing, because `redirect_uri` is a server-side value
embedded in the URL Google redirects back to. `/gmail/auth` and `/api/gmail/auth`
emit byte-identical `redirect_uri` values.

There are two planes, and they must be fixed independently:

```
DATA PLANE   app → /api/event → [rewrite] → Render        ← fixed by VITE_API_URL=/api
AUTH PLANE   browser → Google → /api/gmail/callback       ← fixed by GOOGLE_REDIRECT_URI
             → Set-Cookie on the Vercel origin
```

---

# 7. Deployment order

**The order matters. Steps 3 and 4 in particular are not interchangeable.**

| # | Step | Why here |
|---|---|---|
| 1 | Provision Neon and Redis; record connection strings | Everything else depends on them |
| 2 | Deploy the backend to Render with all env vars; run `migrate deploy`; verify `/health` | Must be healthy before anything points at it |
| 3 | **Google Console: *add*** `https://<project>.vercel.app/api/gmail/callback`, keeping any existing entry | Google validates `redirect_uri` **before anything else** |
| 4 | **Render: set `GOOGLE_REDIRECT_URI`** to that URL; restart | Only safe after step 3 |
| 5 | Deploy the frontend with `vercel.json`; verify `/api/health` → `200` and `/api/event` → `401` | Proves the rewrite reaches Express |
| 6 | **Vercel: set `VITE_API_URL=/api`; redeploy** | Vite inlines at build time — a redeploy is mandatory |
| 7 | Sign in at `https://<project>.vercel.app/api/gmail/auth` | Note the `/api` prefix |
| 8 | Verify the cookie is on the Vercel origin | [§8](#8-verification-checklist) |
| 9 | Verify session in Redis and `GET /api/event` → `200` | [§8](#8-verification-checklist) |
| 10 | Remove the old redirect URI from Google Console | Only after 7–9 pass |

### Why step 3 must precede step 4

> [!CAUTION]
> Google validates `redirect_uri` against the registered list before anything
> else. If you change Render's variable first, **every** login fails with
> `redirect_uri_mismatch` — including the previously working one — and there is
> no way back in until Console is updated.

Adding the new URI first, and keeping the old one until step 10, means both paths
work throughout and rollback is instant.

### Why step 6 requires a redeploy

`VITE_API_URL` is inlined into the JavaScript bundle at build time. Changing the
dashboard variable without triggering a rebuild leaves the old value baked into
the deployed asset. **Always verify against the built bundle**, never against the
dashboard.

### Expect existing sessions to be orphaned

After steps 4 and 6, sessions minted on the Render origin become unreachable —
their cookie is on `onrender.com` and the app now talks only to `vercel.app`.
Everyone must sign in again. Plan for it; it is not a failure.

---

# 8. Verification checklist

### Backend reachable

```bash
curl https://<service>.onrender.com/health
# {"status":"ok","database":"connected"}
```

### Rewrite working

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<project>.vercel.app/api/health   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://<project>.vercel.app/api/event    # 401
curl -s -o /dev/null -w '%{http_code}\n' https://<project>.vercel.app/             # 200
```

`401` on `/api/event` is **correct** here — curl carries no cookie. It proves the
request reached Express and matched a route.

### The live `redirect_uri` — read it from the running process

```bash
curl -s -i https://<project>.vercel.app/api/gmail/auth | grep -i '^location:' \
  | tr '&' '\n' | grep redirect_uri
```

This is more trustworthy than the dashboard: it is the value the process is
actually using.

### The built bundle — ground truth for frontend config

```bash
BUNDLE=$(curl -s https://<project>.vercel.app/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js')
curl -s "https://<project>.vercel.app$BUNDLE" | grep -oE '[a-zA-Z]=`/api`'
# d=`/api`   x=`/api`
```

Zero occurrences of your Render hostname means the frontend is fully same-origin.

### OAuth login and cookie

1. Navigate to `https://<project>.vercel.app/api/gmail/auth`.
2. Complete consent. **Leave the tab open** until `{"success":true,"email":"…"}`
   renders — that response carries the `Set-Cookie`.
3. DevTools → Application → Cookies → **`https://<project>.vercel.app`**.

Expect:

| Attribute | Value |
|---|---|
| Name | `__Host-placement.sid` |
| Domain | the **Vercel** origin |
| `Path` | `/` |
| `HttpOnly` | ✓ |
| `Secure` | ✓ |
| `SameSite` | `Lax` |

**If the cookie is on the Render origin, `GOOGLE_REDIRECT_URI` was not applied.**

### Session in Redis

```bash
redis-cli -u "$SESSION_REDIS_URL" --scan --pattern 'sess:*'
redis-cli -u "$SESSION_REDIS_URL" GET 'sess:<sid>'
```

Expect `userId`, and `"secure":true` — `"secure":false` means the session was
minted by a process where `NODE_ENV !== "production"`.

### End to end

```
GET https://<project>.vercel.app/api/event   →  200, JSON array
```

DevTools → Network → the `/api/event` row → **Cookies** sub-tab. Withheld cookies
appear struck through with a reason; the **Issues** panel carries the same text.

> [!TIP]
> For the same checks expressed as a linear seven-checkpoint flow — with a
> "if it fails, look here" column — see
> [postmortem §9](postmortems/vercel-render-oauth-deployment.md#9-verification-flow).

### Server-side witness — did the session actually load?

`requireAuth` is the only code that writes `session.lastSeenAt`, and
`rolling: true` resets the Redis TTL only on a session it actually loaded. So:

- `lastSeenAt` **advances** + TTL **resets** → the cookie arrived and
  `requireAuth` passed.
- `lastSeenAt` **frozen** at `createdAt` + TTL **decaying** → no cookie ever
  reached Express.

This answers "did the browser send the cookie?" without any code change — useful
because `Cookie` and `Set-Cookie` are forbidden header names that page
JavaScript can never read.

---

# 9. Troubleshooting

| Symptom | Likely cause | How to verify | How to fix |
|---|---|---|---|
| Dashboard shows "No events yet", no error | `Dashboard.tsx` has no `catch`; any non-array response renders as empty | DevTools Network → check the actual status of `/api/event` | Diagnose the real status; the empty state is not evidence of empty data |
| `404 Cannot GET //event` | `VITE_API_URL` has a trailing slash | Grep the built bundle for `` `${d}/event` `` and the value of `d` | Remove the trailing slash; **rebuild** |
| `404 Cannot GET /api/event` on Render directly | Backend mounts `/event`, not `/api/event` | `curl <render>/event` vs `<render>/api/event` | The `/api` prefix belongs to the Vercel rewrite only |
| `401` — cookie is on the Render origin | `GOOGLE_REDIRECT_URI` still points at Render | Read the live `redirect_uri` (§8) | Update Console **then** Render; re-login |
| `401` — no cookie anywhere | OAuth never completed | Check for a new `sess:*` key after login | Retry; check for a cold start aborting the callback |
| `401` — cookie exists, session missing | Session destroyed by a later login (`regenerate()`) | Compare the cookie's sid against `sess:*` keys | Sign in again |
| `401` from a *cross-site* fetch | Cookie is `SameSite=Lax` and the origins differ | Same-origin request returns `200`, cross-site returns `401` | Route through the `/api` rewrite |
| `redirect_uri_mismatch` | Console entry and `GOOGLE_REDIRECT_URI` differ | Compare byte for byte | Make them identical; watch trailing slashes |
| Login works, then user is logged out | Cookie is third-party; Safari/Firefox block or partition it | Reproduce across browsers | Ensure same-origin via the rewrite |
| First request after idle hangs ~30s | Render free-plan cold start | Boot logs show a new instance id and `Running 'npm start'` | Retry; keep-warm ping; or upgrade the plan |
| Backend won't boot | `SESSION_SECRET` unset with `NODE_ENV=production` | Boot logs | Set `SESSION_SECRET` |
| Cookie missing `Secure`, or not set at all behind a proxy | `req.secure` false — `trust proxy` hop count | Check `NODE_ENV=production` (enables `trust proxy`) | Align hop count with actual proxy layers |
| `P1001: Can't reach database server` | Neon auto-suspend — first connection wakes it | Retry; second attempt usually succeeds | Retry. See [`runbooks/migrations.md`](runbooks/migrations.md) |
| `prisma migrate dev` fails in the shadow database | It replays the whole chain against an empty database | Read the error's migration name | Use `migrate deploy` in deployed environments |
| Migrations applied to the wrong database | CLI and runtime resolving different URLs | `prisma migrate status` prints its `Datasource "db": …` line | Verify `DATABASE_URL` vs `DIRECT_DATABASE_URL` |
| `ECONNREFUSED …:6379` | Redis unreachable | Boot logs | Check `REDIS_URL` / `SESSION_REDIS_URL` |
| Jobs enqueue but never process | Queue Redis evicting keys | `INFO memory` → `maxmemory_policy` | Must be `noeviction` |
| No way to log in from the UI | There is no login entry point | `App.tsx` renders only `Dashboard` | Navigate to `/api/gmail/auth` manually |

---

# 10. Common pitfalls

### Trusting the dashboard over the artifact

`VITE_API_URL` is inlined at **build** time. The dashboard can say one thing while
the deployed bundle says another — this happened here, with the repository
holding `localhost:5000` while production served the Render URL. **Always read the
built bundle.**

### Assuming a proxy fixes authentication

The `/api` rewrite makes *data* requests same-origin. It does nothing about where
the session cookie is *minted*. A correctly-formed same-origin request still
returns `401` if the cookie was created on a different origin. Both planes need
fixing; see [§6.5](#65-why-the-callback-is-routed-through-vercel).

### Changing `GOOGLE_REDIRECT_URI` before updating Google Console

Locks you out completely — every login fails `redirect_uri_mismatch` including the
one that previously worked. Always add the new URI to Console first, and keep the
old one until the new path is verified.

### Signing in at the wrong URL

After the switch, `https://<service>.onrender.com/gmail/auth` still works and
still mints a cookie — on the **wrong origin**. The resulting `401` is
indistinguishable from the original bug. Always use
`https://<project>.vercel.app/api/gmail/auth`.

### Treating an empty state as empty data

"No events yet" was rendered for a `404` HTML page, a `401` JSON body, and a
genuinely empty array alike. An error state indistinguishable from a success
state destroys diagnostic information exactly where it is cheapest to capture.

### Assuming `credentials: "include"` is enough

It is *necessary* for cross-origin requests and *never sufficient* for
cross-**site** ones. A cookie with `SameSite=Lax` is withheld from cross-site
subresource requests regardless. Verified here: the same request with
`credentials: "include"` explicitly set still returned `401`.

### Confusing cross-origin with cross-site

`SameSite` is evaluated against the registrable domain (eTLD+1), not the origin.
`vercel.app` and `onrender.com` are both Public Suffix List entries, so each
deployment is its own site. Two subdomains of a domain you own are same-site; two
platform-assigned hostnames are not.

### Setting `SESSION_COOKIE_DOMAIN` to a platform domain

`Domain=.vercel.app` is rejected outright — cookies cannot be set for a public
suffix. It also silently drops the `__Host-` prefix. Leave it unset unless you own
a custom domain covering both hosts.

### Debugging in the wrong browser profile

An empty cookie jar looks identical to a blocked cookie. Confirm which profile
holds the session — a **same-origin** request is the positive control, since
cookies attach there unconditionally regardless of `SameSite` or `HttpOnly`.

### Blaming Redis eviction for a missing session

`establishSession` calls `req.session.regenerate()`, which destroys the previous
session. A vanished key is usually a re-login, not eviction. Check `INFO stats`
→ `evicted_keys` before investigating further.

### Forgetting the cold start

Render's free plan takes roughly 30 seconds to wake. That is long enough to abort
an OAuth callback mid-flow and produce a failure that looks like misconfiguration.

---

## Related documentation

- [`docs/postmortems/vercel-render-oauth-deployment.md`](postmortems/vercel-render-oauth-deployment.md) — full investigation and root cause analysis
- [`docs/runbooks/migrations.md`](runbooks/migrations.md) — Prisma migration procedures
- [`docs/runbooks/troubleshooting.md`](runbooks/troubleshooting.md) — general troubleshooting
- [`docs/runbooks/google-cloud.md`](runbooks/google-cloud.md) — Google Cloud specifics
- [`docs/runbooks/local-development.md`](runbooks/local-development.md) — local setup
- [`docs/rfcs/RFC-001-authentication-multi-user-foundation.md`](rfcs/RFC-001-authentication-multi-user-foundation.md) — authentication design
