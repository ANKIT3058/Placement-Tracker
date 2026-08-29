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
| [11](#11-runtime-model--what-actually-runs) | **Runtime model — what actually runs**, and how to operate it |

**Companion document:** the
[postmortem](postmortems/vercel-render-oauth-deployment.md) explains *why* this
architecture is shaped the way it is. This guide explains *how* to deploy it.

---

# 1. Overview

Two deployed artifacts, three managed services, one identity provider.

> [!IMPORTANT]
> **The deployed backend is a web service, not a job runner.** Render runs
> `node dist/src/server.js`, which serves HTTP and starts two in-process timers.
> It starts **no BullMQ worker**. Queued work is drained by a separate,
> manually dispatched GitHub Actions run. If you are debugging "the email was
> received but nothing happened", read
> [§11 Runtime model](#11-runtime-model--what-actually-runs) before anything else
> — that is the single most common cause, and it is by design rather than by
> fault.

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
| `USE_AI` | `false` | `"true"` enables the AI path at **two** call sites — email extraction and Document Intelligence. **Not a global AI switch**; see the note below. Compared against the literal string. |
| `OPENAI_API_KEY` | — | Required only where `USE_AI=true` actually reaches a provider. Read lazily by `ai/openai-client`, which throws `OPENAI_API_KEY not set` on first use. |
| `GMAIL_SYNC_INTERVAL_MS` | `120000` | Gmail scheduler interval, in the web process. |
| `GMAIL_REQUEST_TIMEOUT_MS` | `10000` | Deadline for a single outbound Gmail or Google OAuth HTTP request. Invalid or non-positive values fall back to the default rather than being clamped. See [§11.5](#115-gmail-timeouts-and-reauthentication). |
| `EMAIL_RECONCILE_INTERVAL_MS` | `60000` | How often the email reconciler sweeps, in the web process. |
| `EMAIL_RECONCILE_MIN_AGE_MS` | `300000` | How long an Email may sit `pending` before the reconciler treats it as never queued. |
| `WORKER_EXIT_WHEN_DRAINED` | unset | **Worker runtime only, never the web service.** `"true"` makes the email worker exit once the queue is genuinely empty. This is what turns a permanent worker into a batch drain. See [§11.3](#113-the-github-actions-drain). |
| `ATTACHMENT_STORAGE_DIR` | `<cwd>/storage/attachments` | Downloaded attachments. **Ephemeral on Render's filesystem** — and no production runtime currently downloads attachments anyway (§11.2). |

> [!NOTE]
> **`USE_AI` is two independent gates, not one global flag.** It is read at
> exactly two call sites: `extraction.service` (the email extraction AI path,
> falling back to regex when off) and `document-processing.service` (the whole
> Document Intelligence step, which does nothing and writes no row when off).
> The AI components themselves do not check it. Setting it to `"true"` therefore
> enables those two paths and nothing else — a future AI feature would need its
> own gate. The production worker deliberately sets **neither** `USE_AI` nor
> `OPENAI_API_KEY`, so production extraction is regex-only (§11.3).

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

Two things that section assumes, and which an incident during G-8 showed cannot
be taken for granted: the schema must reach production **before** the code that
needs it ([§4.7](#47-deployment-order--schema-before-code)), and a `P1001` from
`migrate status` does not necessarily mean the database is down
([§4.8](#48-when-migrate-cannot-reach-the-database-p1001)).

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

### 4.7 Deployment order — schema before code

> **Never deploy application code that requires a database object before that
> object exists in production.**

Migrations are not run by the build (§4.5), so the two move independently and
nothing enforces the ordering for you. Deploying code first does not fail
loudly; it fails as a runtime error on whichever request touches the missing
object.

**What happened during G-8 (2026-08-25).** The `StudentProfile` feature was
deployed — frontend and backend — while `20260825140000_add_student_profile` was
still pending. Production had no `StudentProfile` table, so:

```
frontend + backend deployed
     ↓
StudentProfile table absent
     ↓
GET /user/profile → 500
     ↓
StudentProfileSection treats the failed request as "feature unavailable"
     ↓
the registration-number section is simply not on the page
```

The frontend code was correct. The database schema was behind the deployed
application, and the symptom looked like a missing feature rather than a broken
one.

The exception in the Render logs named it exactly:

```
[user] Failed to read student profile {
  userId: 1,
  reason: 'Invalid `prisma.studentProfile.findUnique()` invocation:
           The table `public.StudentProfile` does not exist in the current database.'
}
```

**Practical ordering.** Apply the migration (§4.5), confirm it with
`migrate status`, and only then deploy the code that depends on it. Additive
migrations — a new table, a new nullable column — are safe to apply ahead of the
deploy precisely because the running application does not yet reference them.

> [!NOTE]
> **Future consideration, not a change to make in a hurry.** The section hid
> itself because it treats *any* failed load as "unavailable", which is right
> for a `401` — the dashboard already reports sign-in state — but turns a `500`
> into a silent absence. Distinguishing "you are signed out" from "this is
> broken" would have made this incident self-evident. Recorded here as an
> observability question; the component is unchanged.

### 4.8 When Migrate cannot reach the database (`P1001`)

`prisma migrate status` and `migrate deploy` can fail with:

```
P1001: Can't reach database server at
ep-<endpoint>.<region>.aws.neon.tech:5432
```

**This does not by itself mean the database is down.** During G-8 the database
was healthy throughout: the application was serving traffic, and a plain Node
`pg` client connected to the same host, database and credentials from the same
machine that Migrate could not reach.

**What was established.** The Neon hostname resolves to **both** IPv6 (`2406:…`)
and IPv4 (`52.76.108.241`, `52.76.128.157`, `13.251.213.89`) addresses. On the
affected Windows workstation, direct TCP tests to port 5432 showed IPv6 timing
out and IPv4 connecting in ~150 ms. The local resolver returned the IPv6
addresses first.

That explains the split:

| Path | Result | Why |
|---|---|---|
| Node `pg` | connects | Node ≥ 20 races both families and falls back to the reachable one |
| Prisma Client | connects | goes through the `pg` driver adapter, so it inherits that behaviour |
| Prisma Migrate | `P1001` | the native schema engine used the IPv6 address and timed out |

> [!IMPORTANT]
> **A successful `pg` connection is not proof that Migrate can reach the
> database.** They take different network paths. Test with the actual command:
> run `npx prisma migrate status` from the environment that will run the
> migration, and only run `migrate deploy` once it succeeds.

This was observed specifically on **Windows with Prisma 7.9.1**, whose Migrate
path runs a native `schema-engine-windows.exe` separate from Node. It is not a
general statement about Prisma and IPv6, and nothing here establishes one.

**Diagnostic order.**

1. Do not assume the database is down — check `/health` and the application logs
   first.
2. Resolve the hostname and note **both** A and AAAA records.
3. Test TCP reachability to port 5432 for an address of each family.
4. If IPv4 works and IPv6 does not, address selection is the likely cause.
5. Run `npx prisma migrate status` from the environment that will apply the
   migration.
6. Only after that succeeds, run `npx prisma migrate deploy`.

**Temporary workaround used.** A single hosts-file entry pinning the hostname to
a reachable IPv4 address, followed by `ipconfig /flushdns`. `migrate status` then
connected and listed the pending migrations, `migrate deploy` applied them, and
`migrate status` reported *Database schema is up to date!*. **The entry was
removed and DNS flushed again immediately afterwards.**

> [!WARNING]
> **The hosts-file entry is a workaround for one migration run, never a
> configuration.** Neon's IP addresses can change, and a stale pin would send
> the workstation to an address that no longer serves this database — failing
> later, in a way that looks like something else. Remove it as soon as the
> migration is applied. Prefer a machine or network where the address selection
> problem does not arise.

> [!NOTE]
> **A CI workflow holding `DIRECT_DATABASE_URL` was considered and rejected.**
> The unpooled credential can execute DDL, and the repository deliberately keeps
> it out of GitHub — see the comment on the build step in
> `.github/workflows/production-worker.yml`. Production migrations remain a
> deliberate, human-run action from a workstation (§4.5). This incident did not
> change that.

---

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

# 11. Runtime model — what actually runs

The section to read when something is wrong in production. Everything above
describes how to *deploy*; this describes what is *executing* afterwards, and how
to operate it.

> [!IMPORTANT]
> **Superseded in part by the Oracle VM deployment.** This section describes the
> runtime as it was when GitHub Actions was the *only* consumer of either queue.
> Both workers now run continuously under systemd on an Oracle Cloud VM, and the
> workflows are maintenance tools rather than the normal runtime — see
> [`oracle-worker-deployment.md`](./oracle-worker-deployment.md).
>
> Everything below about the WEB SERVICE remains exactly true: the Gmail
> scheduler and both reconcilers still run inside the Render process, and still
> only produce. What changed is that something is now always consuming.

## 11.1 Two runtimes, and only one of them is always on

```
  ALWAYS ON                                RUN ON DEMAND
  ─────────────────────────────            ─────────────────────────────
  RENDER — web service                     GITHUB ACTIONS — two batch drains
  node dist/src/server.js                  WORKER_EXIT_WHEN_DRAINED=true

  ├─ Express (HTTP API)                    production-worker.yml
  ├─ Gmail scheduler        (timer)          → dist/src/workers/email.worker.js
  ├─ Email reconciler       (timer)          → consumes: email-processing
  └─ Attachment reconciler  (timer)          → USE_AI=true

  Starts NO BullMQ worker.                 production-attachment-worker.yml
  Produces queue jobs; consumes none.        → dist/src/modules/attachment/
                                                 attachment.worker.js
                                             → consumes: attachment-processing
                                             → no USE_AI (Document Intelligence
                                               writes nothing in production)

                                           Both started by a human. Not scheduled.
                                           Not triggered by a push or a deploy.
```

> [!NOTE]
> `deploy/systemd/` and [`oracle-worker-deployment.md`](./oracle-worker-deployment.md)
> describe a continuously running worker on an Oracle VM. Those unit files are **written and
> committed but not installed on any host**. Until they are, the picture above is the whole
> production runtime.

**The distinction that matters operationally:** *"the application server is
running"* and *"background work is being processed"* are separate facts here, and
the first does not imply the second. The web service ingests mail and enqueues
jobs continuously. Those jobs sit in Redis until somebody dispatches a drain.

A healthy-looking `/health`, a growing `bull:email-processing:wait` list, and no
new Events is therefore **the expected steady state between drains**, not a
malfunction.

## 11.2 What the web service does — and does not — start

`server.ts` connects the session Redis client, then calls `app.listen`. In the
listen callback it starts exactly two timers:

| Started | Interval | What it does |
|---|---|---|
| `startGmailScheduler()` | `GMAIL_SYNC_INTERVAL_MS` (120 s) | Syncs every eligible mailbox, sequentially. Persists Emails and enqueues `email-processing` jobs |
| `startEmailReconciliationScheduler()` | `EMAIL_RECONCILE_INTERVAL_MS` (60 s) | Re-enqueues Emails that were persisted but never queued — see [§11.6](#116-the-email-reconciler) |
| `startAttachmentReconciliationScheduler()` | `ATTACHMENT_RECONCILE_INTERVAL_MS` (60 s) | Re-enqueues attachment work Postgres still owes and Redis no longer represents. Bounded to `ATTACHMENT_RECONCILE_BATCH_SIZE` (100) rows per sweep |

All three run **inside the web process**, each on its own timer with its own
re-entrancy guard. All three are producers.

**No BullMQ worker is started, anywhere, by a continuously running process.**

- `worker:email` and `worker:attachment` are `tsx watch` — development
  file-watchers that never exit. Neither is a production runtime.
- Both queues are consumed only by the manually dispatched drains in
  [§11.3](#113-the-github-actions-drains), which run the **compiled** entrypoints.

> [!WARNING]
> Between drains, both queues accumulate. This is the expected steady state, not
> a leak: the jobs are durable and their ids are deterministic, so the next drain
> picks them up rather than losing them. What it costs is **latency** — an email
> becomes an Event when a drain is dispatched, not when it is synced.

> [!IMPORTANT]
> The attachment drain ships **no `USE_AI`**, so `runDocumentIntelligence` returns
> at its first line and no `DocumentIntelligence` row has ever been written in
> production. The email drain **does** set `USE_AI=true`. The two workflows
> deliberately differ on this.

## 11.3 The GitHub Actions drains

Two workflows, `.github/workflows/production-worker.yml` (email) and
`.github/workflows/production-attachment-worker.yml` (attachments). **They are
the entire production background runtime today.** Separate files on purpose: the
queues are independent, they are dispatched for different reasons, and either
must be runnable without touching the other's definition — which is also why each
has its own `concurrency` group.

The diagram below describes the email drain; the attachment drain has the same
shape and differs in three documented ways — it carries `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` (it downloads from Gmail), it ships no `USE_AI`, and it
ships no `ATTACHMENT_STORAGE_DIR`, so downloaded bytes land on the runner and
vanish with it.

```
  workflow_dispatch  (manual — no schedule, no push, no pull_request trigger)
        │
        ▼
  environment: production-worker      ← required reviewer; the job PAUSES here
        │                               before a single step executes, and the
        │                               production secrets are scoped to it
        ▼
  checkout (SHA-pinned)  →  setup-node 24  →  npm ci  →  npm run build
        │                                                (prisma generate && tsc
        │                                                 && fix-esm-imports)
        ▼
  verify DATABASE_URL, REDIS_URL, OPENAI_API_KEY present   ← fails fast, legibly,
        │                                                       and by NAME only
        ▼
  node dist/src/workers/email.worker.js
        env: DATABASE_URL, REDIS_URL, OPENAI_API_KEY,
             WORKER_EXIT_WHEN_DRAINED=true, USE_AI=true
        │
        ▼
  process jobs at concurrency 1  →  queue empty  →  graceful shutdown  →  exit 0
```

| Property | Value |
|---|---|
| Trigger | `workflow_dispatch` only — **manual** |
| Approval gate | Yes. `environment: production-worker` carries a required reviewer |
| Concurrency | `group: production-email-worker`, `cancel-in-progress: false` — a second run queues rather than cancelling a drain mid-job |
| Working directory | `backend/` (`defaults.run`) |
| Permissions | `contents: read` |
| Timeout | 30 minutes — a ceiling for the cases where the worker *cannot* exit (wedged Redis, paused queue), not the expected duration |
| Queue consumed | `email-processing` **only** |
| `USE_AI` / `OPENAI_API_KEY` | **Present on the email drain** (`USE_AI: 'true'`), and the workflow's credential check requires the key — a missing key would not fail a job, it would silently degrade every one of them to regex-only. **Absent on the attachment drain**, which is what keeps Document Intelligence inert in production |

**It is a run-to-drain execution model, not a continuously running worker.**
`WORKER_EXIT_WHEN_DRAINED=true` is the whole difference: the same compiled
entrypoint runs as a permanent worker without it. The variable is read **once**,
at module load, because the mode is a property of the run.

**Why `node dist/...` and not `npm run worker:email`:** that script is
`tsx watch`, which never exits and would hold the runner until the timeout.

**`DIRECT_DATABASE_URL` in the build step is a deliberate dead value.**
`prisma.config.ts` reads it eagerly for every CLI command including `generate`,
so the build cannot start without *something* there. Nothing reads it — generate
is offline codegen — so the real unpooled endpoint stays out of GitHub entirely.
Migrations are applied from a workstation ([§4.5](#45-migrations)), never here.

> There is no queue-inspection step in this workflow. A temporary read-only one
> existed briefly during commissioning and was removed; it is not part of the
> architecture.

## 11.4 Graceful shutdown and the drain condition

Three ways the worker process can stop. Two are signals; the third it chooses
itself.

**On `SIGTERM` / `SIGINT`** — a deploy, a restart, a host recycling a container:

1. `worker.close()` — stops accepting new jobs, then **waits for the active job
   to finish**. Never `close(true)`, which would abandon the running job — the
   precise outcome the handler exists to prevent.
2. `redis.quit()` on the process's own shared client, inside its own `try`: a
   failed QUIT cannot turn a clean shutdown into a failed one.
3. `process.exit(0)`, explicitly — the `pg.Pool` behind the Prisma client is
   module-scoped and not exported, so its open connections would otherwise keep
   the event loop alive indefinitely.

Concurrent signals are safe: the handler stores the in-flight shutdown promise
and returns it rather than starting a second close.

**Why it matters:** without this the process dies mid-job still holding its Redis
lock. BullMQ cannot distinguish an abandoned job from a slow one, so it waits out
`lockDuration` (30 s default), the stalled checker returns the job to `wait`, and
it runs again from the top. That replay is *safe* — the extraction write is an
upsert on `(emailId, userId)` — but not free: it redoes the whole job, and
because `maxStalledCount` defaults to 1, a job interrupted twice fails
permanently and silently.

**On drain** (batch mode only) — and this is the part worth understanding,
because the obvious implementation is wrong:

BullMQ's `drained` event means *a fetch found nothing immediately available*. It
is a statement about the wait list, **not** about the queue. A job that fails with
attempts remaining moves to the DELAYED set, and if nothing else is waiting the
very next thing the worker does is emit `drained`. Exiting on the event alone
would abandon a pending retry.

So the event is only the **trigger**; the **decision** is a `getJobCounts` over
six states:

```
waiting + active + delayed + paused + prioritized + waiting-children
        │
        ├─ > 0  → return; do nothing. Fetching any job clears BullMQ's internal
        │         drained flag, so the next true drain emits again.
        └─ = 0  → shutdown("Queue email-processing drained") → exit 0
```

`completed` and `failed` are excluded deliberately: with `removeOnFail: false`
the failed set is permanent, so counting it would mean the queue is never drained
and the process never exits.

`active` is counted even at concurrency 1, where this worker cannot be holding a
job when `drained` fires. It guards the *other* case: a previous run killed
without draining leaves its job in `active` with an expired lock until the
stalled checker returns it.

If the count itself fails, the error is logged and the process **stays up** —
crashing there would abandon a held job outside the graceful path.

**A job arriving between the counts coming back zero and the close completing is
not handled, because it cannot be.** The web service is a live producer and no
lock closes that window. It costs nothing: the job is durable in Redis, its
deterministic id prevents duplication, and the next run picks it up.

### Batch behaviour, precisely

| Question | Answer |
|---|---|
| Batch size | **None.** There is no batching primitive. The worker pulls jobs one at a time at BullMQ's default concurrency of **1** |
| Sequential or concurrent | Sequential, one job at a time |
| One item fails | It does not stop the run. The job retries per its own options (`attempts: 3`, exponential backoff from 2000 ms) and the worker moves on |
| Failure blocks later items | No |
| Unbounded work | Bounded by the drain condition plus the 30-minute workflow timeout, not by a batch size |

Two exceptions to ordinary retry, both deliberate: an **ownership mismatch**
between the payload's `userId` and the persisted Email's throws
`UnrecoverableError` — no retry can fix a forged payload or a broken invariant —
and a Prisma **`P2002`** is caught and treated as success, since the desired end
state already exists.

## 11.5 Gmail timeouts and reauthentication

**Every** outbound Gmail and Google OAuth request is bounded, from one place:
`createOAuthClient` sets `transporterOptions: { timeout: GMAIL_REQUEST_TIMEOUT_MS }`
(10 s). google-auth-library builds its transporter from those options and uses
that single gaxios instance for both halves of every operation — its own token
refresh and the Gmail call itself — so this bounds token refresh, every API
request, every page of a paginated walk, and attachment downloads, without
repeating a deadline at six call sites where one omission would silently reopen
the hole.

gaxios turns `timeout` into `AbortSignal.timeout()`, which **aborts the
underlying fetch**. That distinction matters: abandoning the promise instead
would leave the socket open and the scheduler still holding work that never ends.

**Per attempt, not per operation.** gaxios re-arms the timeout on each retry and
caps retries independently, so one HTTP operation's worst case is roughly three
attempts plus backoff — about 30 s. That is comfortably inside the 120 s sync
interval, so a stalled mailbox is detected and the cycle finishes within one
period. **Timeouts are not retried indefinitely.**

### Three distinct failure classes — the code separates them, so should you

| Class | Example | What happens |
|---|---|---|
| **Transient** | timeout, network, `429`, any `5xx` | gaxios retries at the transport layer. The mailbox fails this cycle, is logged, and is retried next cycle. Nothing is persisted |
| **Expired cursor** | `404` on `users.history.list` | Classified specifically and handled by re-bootstrapping to a full sync. Not an error condition |
| **Permanent auth failure** | HTTP **400** carrying Google's **`invalid_grant`** | `reauthRequiredAt` is stamped on the mailbox, then the error is rethrown unchanged |

**Only that last one sets `reauthRequiredAt`** — `isPermanentGmailAuthFailure` is
true for exactly `status === 400 && googleError === "invalid_grant"` and false for
everything else. `401` is excluded because it is routinely cured by the library's
own token refresh; `403` is excluded because it covers rate limiting as readily as
a scope error; a `400` without `invalid_grant` is this application's bug, not a
revoked authorization. Excluding a mailbox on any of those would strand a healthy
user — a worse outcome than futile retrying.

### What `reauthRequiredAt` actually does

Persisted as a nullable `DateTime` on `GmailAccount`. It is a timestamp rather
than a boolean so it records *when* authentication broke, and `NULL` means
eligible.

- **The background scheduler skips the mailbox.** `getAllGmailAccounts` filters
  `reauthRequiredAt: null`, so the mailbox drops out of automatic sync.
- **An explicit user-triggered `POST /gmail/sync` still attempts it.**
  `getGmailAccountsByUser` filters by owner only. A user who has just reconnected
  in another tab is not blocked by a stale flag.
- **The account is *not* disconnected.** The row stays, and the refresh token is
  deliberately left in place — Google has already invalidated it, so deleting it
  protects nothing and only makes reconnect harder to reason about.
- **The user must re-authorize the mailbox.** Reconnecting through the OAuth flow
  writes a new refresh token and clears the flag in the same update, restoring
  scheduler eligibility. `historyId` is deliberately untouched, so sync resumes
  incrementally rather than re-reading the mailbox.
- **A successful sync also clears it**, written only when the flag was actually
  set, to keep the ordinary success path at one write.

## 11.6 The email reconciler

**The invariant it restores:** *every persisted Email eventually reaches the
queue.*

`createEmail` commits to Postgres, then `enqueueEmailProcessing` writes to Redis.
The two stores cannot share a transaction, so a failed enqueue — Redis
unreachable during ingestion, most obviously — leaves a committed row at
`processingStatus: "pending"` with no job behind it. Nothing else recovers that
state: the Gmail dedupe short-circuits every replay of the message, the sync
watermark has already advanced past it, and an email ingested through
`POST /email` has no Gmail message to replay at all. The email was stored and
never processed, with nothing recording that anything had gone wrong.

**It is not a health check.** It repairs exactly one inconsistency.

| | |
|---|---|
| Where it runs | The **web process**, started from `server.ts` — not the worker |
| Interval | `EMAIL_RECONCILE_INTERVAL_MS`, default 60 s, plus one sweep immediately at startup |
| What it scans | `Email` rows with `processingStatus: "pending"` **and** `createdAt < now − EMAIL_RECONCILE_MIN_AGE_MS` (default 5 min) |
| Why the age cutoff | A row stays `pending` until a worker picks it up, so a legitimately queued email is indistinguishable from an orphan until enough time has passed. The cutoff must clear a normal backlog or the sweep chases work already in flight |
| What it does | Re-enqueues each row through the **normal producer**, carrying the row's own `userId`. It never writes `processingStatus` — the worker owns that lifecycle |
| Failure handling | Per-row `try/catch`; one row's failure never aborts the sweep. A failed row is left `pending` and stays eligible next pass |
| Overlap | An `isRunning` guard skips a sweep if the previous one is still going |
| Its own timer | Deliberately separate from the Gmail scheduler. Recovery must not depend on the component most likely to be unhealthy — and a stalled Gmail request can leave that scheduler's guard set for the life of the process |

**Duplicate-processing risk, and what actually protects against it.** The
reconciler cannot see Redis, so a row whose enqueue *did* succeed is
indistinguishable from an orphan and will be re-enqueued. That is intentional.
`enqueueEmailProcessing` uses `jobId: email-${id}`, and BullMQ refuses a second
`add` while a job with that id exists, so the duplicate collapses into the job
already queued. Checking Redis first would race the exact window the reconciler
exists to close.

> **This is at-least-once delivery with eventual processing — not exactly-once.**
> Exactly-once is not achievable across Postgres and Redis and is not claimed.
> The deterministic job id suppresses duplicate *jobs*; the one non-idempotent
> side effect that survives a genuine double run is handled at the database, by
> the unique constraint that makes `createExtraction` an upsert.

**Operationally:** because the reconciler runs in the always-on web service while
the worker runs only on demand, a `pending` backlog older than five minutes is
normal between drains. The reconciler will re-enqueue those rows on every sweep,
and every one of those enqueues collapses into the existing job. That is
harmless, and it is not evidence of a problem.

## 11.7 Operational failure modes

| Symptom | Most likely cause | Where to look |
|---|---|---|
| Emails ingested, no Events appear | No drain has been run — expected between drains | [§11.3](#113-the-github-actions-drain) — dispatch the workflow |
| `bull:email-processing:wait` keeps growing | Same | §11.3 |
| `attachment-processing` grows and never drains | No production attachment consumer exists | [§11.2](#112-what-the-web-service-does--and-does-not--start) |
| One mailbox stops syncing, others fine | `reauthRequiredAt` is set — the user must reconnect | [§11.5](#115-gmail-timeouts-and-reauthentication) |
| All mailboxes stop syncing | Scheduler guard stuck, or the account query failed | §11.2; check for `[gmail-scheduler] Run failed` |
| Drain workflow times out at 30 min | Wedged Redis or a paused queue — the worker could not reach a zero count | §11.4 |
| Drain exits immediately, queue non-empty | Jobs are in `failed`, which is excluded from the drain condition by design | §11.4 |
| Extraction quality lower than local | Production runs regex-only: no `USE_AI`, no `OPENAI_API_KEY` | [§3.2](#32-backend--optional) |
| Repeated `[email-reconciler] Sweep failed` | Database reachability from the web service | [§11.6](#116-the-email-reconciler) |

**Dispatching a drain** — the only routine production operation: Actions → *Production Email Worker* → *Run workflow* → approve the `production-worker` environment prompt. It connects to production Redis and Postgres, which is why it is manual, gated, and never triggered by a commit.

## 11.8 Production verification — the attachment pipeline (G-7)

**Recorded 2026-08-25.** This section is *evidence*, not design. It states what
was observed in production on that date and nothing more.

> [!IMPORTANT]
> Sections [§11.1](#111-two-runtimes-and-only-one-of-them-is-always-on),
> [§11.2](#112-what-the-web-service-does--and-does-not--start),
> [§11.3](#113-the-github-actions-drain) and
> [§11.7](#117-operational-failure-modes) above were written when the attachment
> worker had no production runtime, and still say so. They are superseded by
> this section on that point. Reconciling their wording is separate outstanding
> work; the disagreement is recorded here rather than quietly edited away.

### Three levels of assurance, kept distinct

| Level | What it establishes | Where it lives |
|---|---|---|
| **Implementation** | The code exists and is reviewable | Commits for the replay guard, graceful shutdown and batch drain, reconciliation, and the production runtime |
| **Local / test verification** | The invariants cannot be violated *in the suite* — shutdown, drain conditions, replay safety, recovery selection | `npm test` |
| **Production verification** | The pipeline actually ran against production Redis, Postgres and Gmail | **This section** |

The first two were true for weeks before the third. That gap is the point of
recording this separately: *"the code is correct"* and *"the code has run in
production"* are different claims, and only the second is evidence of a working
system.

### What ran

The **Production Attachment Worker** workflow, dispatched manually and approved
through the `production-worker` environment. The worker received
`DATABASE_URL`, `REDIS_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`WORKER_EXIT_WHEN_DRAINED=true`. Both the database and Redis connections
succeeded.

At the end of each run the worker logged, in order:

```
Queue attachment-processing drained, shutting down attachment worker...
Attachment worker shut down successfully
```

That pair is the batch-drain lifecycle completing on its own terms: the drain
condition reached zero across the six pending states, and the shutdown path ran
to completion rather than the runner killing the process.

### The recovery, in the order it happened

An earlier run had failed **38** attachment-processing jobs with
`invalid_request`, because that run was dispatched before the workflow carried
the Gmail OAuth client credentials. Those jobs remained in Redis
(`removeOnFail: false`), holding their deterministic ids.

| Step | Observed |
|---|---|
| 1 | `attachment-13` recovered individually, `failed → waiting` |
| 2 | A Production Attachment Worker run processed `attachment-13` successfully |
| 3 | The remaining **37** jobs recovered, `failed → waiting` |
| 4 | A subsequent run processed all **37** successfully |
| **Result** | **All 38 previously failed jobs recovered and completed** |

The canary-first order was deliberate: the failure being recovered from was one
that produced a *green* workflow while doing no work, so a single job was proved
end to end before the remaining thirty-seven were committed to.

### What "completed" does and does not mean here

A job completing means `DocumentProcessingService.process` returned without
throwing — the attachment was downloaded from Gmail and stored, and parsing
either succeeded or recorded a `parsingError` (parse failures are deliberately
not rethrown). **It is not evidence that every attachment parsed cleanly**, and
per-attachment parse outcomes were not inspected as part of this verification.

Document Intelligence did **not** run, and is blocked twice over — see
*Document Intelligence is blocked in production* below.

### The attachment reconciler DID fire in production

**Corrected 2026-08-25.** An earlier revision of this section stated that the
reconciler's discovery path "has not yet been observed firing in production."
That was wrong, and it understated what G-7 proved. It was inferred from the
fact that the one-off retry tool performed the *failed-job* recovery, and never
checked against the service logs. The record is corrected here rather than
quietly rewritten.

The reconciler runs in the API process and its own logs show it working:

```
[attachment-reconciler] Starting, interval 60000ms
[attachment-reconciler] Recovered stranded attachments { enqueued: 31 }
[attachment-reconciler] Recovered stranded attachments { enqueued: 31 }
[attachment-reconciler] Recovered stranded attachments { enqueued: 25 }
[attachment-reconciler] Recovered stranded attachments { enqueued: 4 }
...
[attachment-reconciler] Recovered stranded attachments { enqueued: 6 }
```

The falling counts — 31, 31, 25, 4 — are the sweep observing its own effect: as
the worker drained the recovered jobs, fewer rows remained unfinished for the
next sweep to find. The later steady `6` is a subsequent deploy's sweep against
a different set of outstanding rows.

**Two claims, and only the first is proven.**

| | Claim | Status |
|---|---|---|
| **a** | The reconciler **discovers stranded attachments and enqueues them** in production | **PRODUCTION VERIFIED** — the log lines above |
| **b** | The **complete end-to-end automatic path** — discovered, enqueued, and then processed to a finished attachment with no human step | **NOT YET VERIFIED** — see *The outstanding case* below |

The distinction matters because the 38-job recovery above was **not** the
reconciler's doing. Its predicate excludes `failed` rows by design, so that
recovery went through the one-off retry tool, which moves an existing job from
`failed` to `waiting` in place. Discovery and end-to-end recovery are separate
claims and are recorded separately.

### The outstanding case — `attachment-57`

Observed **2026-08-25T13:03:10Z**:

| Field | Value |
|---|---|
| `processingStatus` | `pending` |
| `createdAt` | `2026-08-25T06:30:22Z` (~6.5 h old) |
| `mimeType` | `…spreadsheetml.sheet` — a format the registry **does** parse |
| `storagePath` / `processedAt` / `parsedAt` | all unset |
| `parsingError` / `processingError` | none |
| BullMQ job hash `attachment-57` | **does not exist** |
| `attachment-processing` queue | empty on every count |

So a durable row still owes work, no job represents it, and it is well past
`ATTACHMENT_RECONCILE_MIN_AGE_MS`. It is squarely inside the reconciler's
predicate and will be enqueued by the next sweep — but no sweep has run since
**12:19Z**, because the API service is on Render's free tier and spins down
without traffic. **Timers do not run while the instance is asleep**, so
reconciliation is bursty rather than continuous, and recovery latency is
therefore unbounded in practice. That is an infrastructure property, not a code
defect.

Claim **(b)** stays unverified until this row — or one like it — is observed
reaching a finished state with no manual step.

### Document Intelligence is blocked in production

Two independent blockers, recorded separately because they need separate
decisions:

| Blocker | Detail |
|---|---|
| **`USE_AI` unset** | Neither worker workflow ships `USE_AI` or `OPENAI_API_KEY`, so `runDocumentIntelligence` returns before any provider call |
| **Schema drift** | The repository contains migration `20260824120000_add_document_intelligence`; **production has not applied it**. The applied list ends at `20260823170000_add_email_extraction_unique`, and `public` contains no `DocumentIntelligence` table |

Even with `USE_AI=true`, the write would therefore fail — harmlessly, since that
call site is fail-soft, but with no understanding persisted.

> [!NOTE]
> This drift was **surfaced** by the G-7 verification, not caused by it. Applying
> the migration is a deliberate production change and was explicitly **not**
> performed as part of this work.

### Non-fatal noise, recorded so it is not re-investigated

| Message | Assessment |
|---|---|
| PostgreSQL `SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'…` | A `node-postgres` client-side deprecation notice. A warning only; it did not affect processing |
| GitHub Actions `Set up Node.js` — `Failed to restore: The server is busy` | A cache-restore miss. Non-fatal; the workflow succeeded |

---

## Related documentation

- [`docs/02_Backend/Gmail_Synchronization.md`](02_Backend/Gmail_Synchronization.md) — the sync algorithm, its cursor model, and its reliability guarantees
- [`docs/03_Development/Development_Environment.md`](03_Development/Development_Environment.md) — running the same processes locally
- [`docs/postmortems/vercel-render-oauth-deployment.md`](postmortems/vercel-render-oauth-deployment.md) — full investigation and root cause analysis
- [`docs/runbooks/migrations.md`](runbooks/migrations.md) — Prisma migration procedures
- [`docs/runbooks/troubleshooting.md`](runbooks/troubleshooting.md) — general troubleshooting
- [`docs/runbooks/google-cloud.md`](runbooks/google-cloud.md) — Google Cloud specifics
- [`docs/runbooks/local-development.md`](runbooks/local-development.md) — local setup
- [`docs/rfcs/RFC-001-authentication-multi-user-foundation.md`](rfcs/RFC-001-authentication-multi-user-foundation.md) — authentication design
