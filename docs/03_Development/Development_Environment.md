# Development Environment

Engineering Handbook — Development
Status: canonical. Describes the repository as it exists, not as it should exist.

Everything below was verified against the working tree. Where the repository is
missing something a new engineer would expect (an `.env.example`, an `engines`
field, a Redis container), that absence is stated rather than papered over.

---

# Purpose

This document is the setup contract for the Placement Tracker repository. It
records the software required, the environment variables consumed, the order in
which processes must be started, and the failures a new engineer will hit.

**Read this if** you are cloning the repository for the first time, changing
build or test configuration, or debugging an environment failure that is not a
code defect.

**Do not read this for architecture.** The reasoning engine, domain model, and
recognition behaviour are documented in `docs/01_Domain_Model/` and
`docs/02_Backend/`. This document concerns only how to run the thing.

Two properties of the current setup are worth knowing before you start:

- `backend/.env.example` is the template for backend configuration; copy it to
  `backend/.env`. **`client/` has no example file** — its single variable is
  documented below.
- `DATABASE_URL` configures **both** the Prisma CLI and the application runtime.
  There is no second place to set it.

---

# Repository Structure

A three-package layout with no workspace tooling. The root `package.json`
declares two type packages and **no scripts**; it does not orchestrate the
sub-packages. Every command runs from either `backend/` or `client/`.

```
Placement-Tracker/
├── package.json              root; devDependencies only, no scripts
├── README.md                 project overview (marketing-oriented, not setup)
│
├── backend/                  Node + Express + TypeScript API and workers
│   ├── src/
│   │   ├── app.ts            Express app, CORS, route mounting
│   │   ├── server.ts         HTTP entry point; starts the Gmail scheduler
│   │   ├── modules/          email, extraction, event, matching, gmail,
│   │   │                     attachment, ai, document-intelligence
│   │   ├── infrastructure/   redis/
│   │   ├── workers/          email.worker.ts
│   │   ├── lib/              prisma.ts (runtime client)
│   │   └── shared/           constants/, utils/
│   ├── prisma/
│   │   ├── schema.prisma     models: Event, EventUpdate, Email, Attachment,
│   │   │                     EmailExtraction, GmailAccount
│   │   └── migrations/       14 migrations + migration_lock.toml
│   ├── prisma.config.ts      Prisma CLI config; datasource URL from DATABASE_URL
│   ├── .env.example          backend configuration template (placeholders only)
│   ├── generated/prisma/     generated client — GITIGNORED, must be generated
│   ├── scripts/
│   │   └── fix-esm-imports.js  post-build fixup for the generated client
│   ├── dist/                 tsc output
│   ├── docker-compose.yml    PostgreSQL only — no Redis
│   ├── jest.config.cjs
│   └── tsconfig.json
│
├── client/                   React 19 + Vite SPA
│   ├── src/{api,components,pages,assets}
│   ├── vite.config.ts        React plugin + an /api dev proxy
│   ├── tsconfig.json / tsconfig.app.json / tsconfig.node.json
│   └── eslint.config.js
│
└── docs/                     Engineering Handbook
    ├── 00_Project_Overview/  Product_Vision.md
    ├── 01_Domain_Model/      Event.md, EventUpdate.md
    ├── 02_Backend/           Gmail_Synchronization.md, Event_Intelligence.md,
    │                         Recognition_Decision_Matrix.md
    ├── 03_Development/       this document
    └── 06_ADR/               ADR-006_Identity_Precedes_Similarity.md
```

**Prisma.** The schema declares `datasource db { provider = "postgresql" }` with
**no `url`**. The URL is supplied by `prisma.config.ts`, which reads it from
`DATABASE_URL` via Prisma's `env()` helper and also sets the schema and
migrations paths. The generated client is emitted to
`backend/generated/prisma` (configured by the generator's `output`) and is
gitignored, so it does not exist in a fresh clone.

**Scripts.** `backend/scripts/fix-esm-imports.js` is the only build script. It
rewrites extensionless relative imports inside `dist/generated/**/*.js` to carry
`.js`. Prisma's generator emits extensionless imports; TypeScript passes them
through; Node's ESM loader rejects them. Without this step every compiled import
inside the Prisma client throws `ERR_MODULE_NOT_FOUND`. It runs automatically as
the third stage of `npm run build`.

---

# Required Software

## Declared versus verified

**No `engines` field is declared** in `backend/package.json`,
`client/package.json`, or the root `package.json`. There is no `.nvmrc` and no
`.node-version`. The repository therefore states no Node requirement.

The versions below are what the environment was **verified against**, not what
the repository mandates.

| Software | Verified | Notes |
|---|---|---|
| Node.js | **24.18.0** | Both packages are `"type": "module"`. Backend compiles with `module: NodeNext`. Must be a release supporting ESM and top-level `await` (`src/infrastructure/redis/test.ts` uses it). |
| npm | **11.16.0** | Lockfile is `lockfileVersion` 3. |
| Git | any | — |
| Docker | any recent | Only needed if you use the bundled PostgreSQL. |
| PostgreSQL | **16** | Pinned by `docker-compose.yml` (`image: postgres:16`). |
| Redis | any 5+ | Required by BullMQ. **Not provided by the compose file** — you must supply it. |

## Operating system

The backend has no OS-specific code. One **toolchain** dependency is
OS-sensitive: Jest 30 resolves modules through `unrs-resolver`, a native addon.
On Windows that addon is an MSVC build and requires the Visual C++ runtime. See
*Testing → Known platform-specific issues* and *Platform Notes*.

## Services and ports

| Service | Port | Source |
|---|---|---|
| Backend API | `3000` | `PORT` env var, default `3000` (`src/server.ts`) |
| PostgreSQL | `5435` → container `5432` | `docker-compose.yml` |
| Redis | your choice | `REDIS_URL` |
| Vite dev server | `5173` | Vite default; not configured |

---

# Project Dependencies

## Backend runtime

| Package | Version | Role |
|---|---|---|
| `express` | ^5.2.1 | HTTP layer. **Express 5**, not 4 — error-handling and router semantics differ. |
| `cors` | ^2.8.6 | Origin is `FRONTEND_URL`, `credentials: true` (`src/app.ts`). |
| `@prisma/client` / `prisma` | ^7.5.0 | ORM and CLI. Prisma 7 uses `prisma.config.ts`, not `.env` interpolation in the schema. |
| `@prisma/adapter-pg` | ^7.5.0 | Driver adapter. The client is instantiated with a `pg` Pool, not Prisma's own engine connection. |
| `pg` | ^8.20.0 | Pool backing the adapter (`src/lib/prisma.ts`). |
| `bullmq` | ^5.77.1 | Job queues: `email-processing`, `attachment-processing` (`src/shared/constants/queue.constants.ts`). Supplies the retry semantics that Gmail sync itself lacks. |
| `ioredis` | ^5.10.1 | Redis client. Constructed with `maxRetriesPerRequest: null`, which BullMQ requires. |
| `googleapis` | ^173.0.0 | Gmail OAuth and message reads. Scope: `gmail.readonly` only. |
| `openai` | ^6.32.0 | Optional extraction path. Model `gpt-4o-mini`, `temperature: 0`. Client is lazily constructed and **throws if `OPENAI_API_KEY` is unset**. |
| `exceljs` | ^4.4.0 | Spreadsheet attachment parser. |
| `pdf-parse` | ^2.4.5 | PDF attachment parser. |
| `dotenv` | ^17.3.1 | Loaded at the top of `src/lib/prisma.ts`, both workers, and `prisma.config.ts`. |
| `@bull-board/api`, `@bull-board/express` | ^7.1.5 | **Declared but not wired.** No import exists anywhere in `src/`. There is no queue dashboard. |

## Backend tooling

| Package | Version | Role |
|---|---|---|
| `typescript` | ^5.9.3 | `strict: true`, `module: NodeNext`, target ES2022. |
| `tsx` | ^4.21.0 | Runs TypeScript directly in `dev` and both worker scripts. |
| `jest` | ^30.3.0 | Test runner. |
| `ts-jest` | ^29.4.9 | Transform. Supports Jest 30 (`peerDependencies: jest ^29 \|\| ^30`). |
| `supertest` | ^7.2.2 | HTTP assertions (`src/__tests__/email.api.test.ts`). |

## Client

React 19.2, Vite 8.0, `@vitejs/plugin-react`, ESLint 9 flat config, TypeScript
**~6.0.2**.

> The client and backend are on **different TypeScript majors** (6.x vs 5.9.x).
> They compile independently and share no code, so this is currently harmless —
> but do not assume a shared tsconfig or shared types.

---

# Environment Variables

Two `.env` files are required and **neither is committed** (`.env` is gitignored).
`backend/.env.example` is the template:

```bash
cd backend && cp .env.example .env
```

`client/` has no template; create `client/.env` from the table below.

## `backend/.env`

| Variable | Required | Purpose | Example format |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | **Pooled** connection string. Read by the runtime `pg` Pool in `src/lib/prisma.ts` and handed to the `PrismaPg` adapter. Not used by the Prisma CLI — see below. | `postgresql://USER:PASS@HOST-pooler:5432/db?sslmode=require` |
| `DIRECT_DATABASE_URL` | **Yes** | **Direct** (unpooled) connection string. Read by `prisma.config.ts` and used by `prisma migrate`, `prisma db` and `prisma studio`. On a local Postgres there is no pooler, so set it to the same value as `DATABASE_URL`. | `postgresql://USER:PASS@HOST:5432/db?sslmode=require` |
| `REDIS_URL` | **Yes** | BullMQ / ioredis connection. Typed non-null (`process.env.REDIS_URL!`), but at runtime an unset value falls through to ioredis defaults (`127.0.0.1:6379`) rather than throwing — so a missing value surfaces as a connection error, not a config error. | `redis://localhost:6379` |
| `FRONTEND_URL` | **Yes** | CORS origin. An unset value makes `cors` reflect no origin and browser calls from the client fail. | `http://localhost:5173` |
| `GOOGLE_CLIENT_ID` | **Yes**, for Gmail | OAuth client id. | `<id>.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | **Yes**, for Gmail | OAuth client secret. | `GOCSPX-…` |
| `GOOGLE_REDIRECT_URI` | **Yes**, for Gmail | Must match the Google Cloud Console entry **exactly**, and must resolve to `GET /gmail/callback`. | `http://localhost:3000/gmail/callback` |
| `USE_AI` | No | `"true"` enables the OpenAI extraction path. Any other value — including unset — runs pattern extraction only. Compared as the literal string `"true"`. | `false` |
| `OPENAI_API_KEY` | Only if `USE_AI=true` | `getOpenAIClient()` throws `OPENAI_API_KEY not set` when absent. Unused when `USE_AI` is not `"true"`. | `sk-…` |
| `PORT` | No | HTTP port. Defaults to `3000`. | `3000` |
| `GMAIL_SYNC_INTERVAL_MS` | No | Scheduler tick. Defaults to `120000` (2 minutes) — see `src/shared/constants/config.ts`. | `120000` |
| `ATTACHMENT_STORAGE_DIR` | No | Root for downloaded attachments. Defaults to `<cwd>/storage/attachments`. That path is gitignored. | `D:/tmp/attachments` |

## `client/.env`

| Variable | Required | Purpose | Example format |
|---|---|---|---|
| `VITE_API_URL` | **Yes** | Base URL used directly by `src/api/emailApi.ts` and `src/api/eventApi.ts`. If unset, `BASE_URL` is `undefined` and requests resolve against the Vite origin. | `http://localhost:3000` |

> `vite.config.ts` defines a dev proxy mapping `/api` → `http://localhost:3000`.
> **Nothing currently uses it** — both API modules read `VITE_API_URL` and build
> absolute URLs. Set `VITE_API_URL`; do not rely on the proxy.

## How the database URLs are resolved

The runtime and the migration engine read **different** variables, pointing at
the same database through different endpoints.

| Consumer | Reads from | Endpoint |
|---|---|---|
| Application runtime (`src/lib/prisma.ts`) | `process.env.DATABASE_URL` | **Pooled** |
| Prisma CLI (`generate`, `migrate`, `db`, `studio`) | `env("DIRECT_DATABASE_URL")` in `backend/prisma.config.ts` | **Direct** |

**Why they differ.** Migrate takes a *session-level* advisory lock to serialise
concurrent deploys. A transaction pooler such as PgBouncer cannot hold one — the
lock is acquired on one backend and released to another — and DDL through a
transaction pooler is unsafe for the same reason. The runtime wants the
opposite: many short-lived queries across concurrent handlers, where connection
reuse is the point. On a local Postgres there is no pooler, so both variables
hold the same value.

**Where they are declared.** `prisma/schema.prisma` declares neither. Prisma 7
removed `url` and `directUrl` from schema files — declaring either raises
`P1012: The datasource property 'url' is no longer supported in schema files`.
The split is therefore expressed by which side reads which variable:
`prisma.config.ts` for Migrate, the `PrismaPg` adapter for the client.

`env()` **throws when the variable is unset**
(`Cannot resolve environment variable: DIRECT_DATABASE_URL`) rather than falling
back — so a missing direct URL fails loudly instead of silently routing
migrations through the pooler. Both paths load `.env` through `dotenv/config`,
and because `dotenv` does not overwrite variables already present in the
process, an explicitly exported value takes precedence over the file — the
supported way to target a different database for a single command:

```bash
DIRECT_DATABASE_URL="postgresql://…" npx prisma migrate status
```

> These two variables now move independently. Point them at the same database —
> a mismatch means the API talks to one and migrations alter another, with
> nothing reporting it. Confirm the `Datasource "db": …` line the CLI prints
> before running any `prisma migrate` command; it echoes the **direct** host.

---

# Initial Setup

Run every command from `backend/` unless stated otherwise.

### 1. Clone

```bash
git clone <repository-url>
cd Placement-Tracker
```

### 2. Install

Each package installs independently. There is no workspace root.

```bash
cd backend && npm install
cd ../client && npm install
```

### 3. Database

Either start the bundled container:

```bash
cd backend
docker compose up -d
```

That provisions `postgres:16` as container `placement-db`, database `placement`,
user `placement_admin`, exposed on host port **5435**, with a named volume
`pgdata`. Credentials are in `docker-compose.yml`.

Or point at an existing PostgreSQL instance.

### 4. Redis

**The compose file does not include Redis.** Provide it yourself:

```bash
docker run -d --name placement-redis -p 6379:6379 redis:7
```

or use a local install or a managed instance. Both workers and the email queue
producer fail without it.

### 5. Environment

```bash
cd backend && cp .env.example .env
```

Then edit `backend/.env` for your environment. Create `client/.env` from the
table above — there is no template for it.

### 6. Prisma client

`generated/prisma` is gitignored, so a fresh clone has **no client**. Nothing
compiles or runs until you generate it:

```bash
cd backend
npx prisma generate
```

Confirm `DATABASE_URL` names your intended database first, then apply migrations:

```bash
npx prisma migrate dev
```

There are 14 migrations. Use `npx prisma migrate deploy` against a database that
must not be reset.

### 7. Build (optional for development)

```bash
npm run build
```

Three stages: `prisma generate`, `tsc`, then `node scripts/fix-esm-imports.js`.
The third stage is mandatory — skipping it leaves the compiled Prisma client
unloadable under Node's ESM resolver.

Development uses `tsx` and does not require a build.

### 8. Start

Three processes, in this order. Each needs its own terminal.

```bash
# backend/  — API + Gmail scheduler
npm run dev

# backend/  — email processing worker
npm run worker:email

# backend/  — attachment processing worker
npm run worker:attachment

# client/   — SPA
npm run dev
```

Verify the backend with `GET http://localhost:3000/health`, which executes
`SELECT 1` and returns `{ status: "ok", database: "connected" }`.

### 9. Connect a mailbox (optional)

Gmail ingestion needs a one-time OAuth grant. With the backend running, visit
`GET /gmail/auth`, complete consent, and Google redirects to `/gmail/callback`.
The grant requests `access_type: offline` with `prompt: consent`, so a refresh
token is issued and the user never needs to return. `GET /gmail/sync` triggers a
manual sync; otherwise the scheduler polls every `GMAIL_SYNC_INTERVAL_MS`.

---

# Testing

## Framework

Jest 30 with ts-jest 29.4.9, configured in `backend/jest.config.cjs`.

```bash
cd backend
npm test
```

Current state: **7 suites, 73 tests, 0 failures, 0 skipped** (~81s).

Four configuration choices are deliberate and documented inline in the config:

- **`maxWorkers: 1`** — in multi-worker mode ts-jest intermittently fails to tear
  a worker down inside Jest's grace window, producing a spurious "worker process
  failed to exit" warning. Running in band removes the worker entirely and keeps
  `--detectOpenHandles` meaningful.
- **`roots: ["<rootDir>/src"]` + `testMatch: ["**/__tests__/**/*.test.ts"]`** —
  Jest's default `testMatch` would also collect `src/infrastructure/redis/test.ts`
  (a manual smoke script) and its compiled copies under `dist/`.
- **`moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" }`** — sources use ESM
  specifiers with explicit `.js`, correct for the NodeNext runtime. ts-jest emits
  CommonJS and cannot resolve them.
- **Inline tsconfig override** — forces `module: commonjs`,
  `moduleResolution: node`, `verbatimModuleSyntax: false`, and adds jest types.
  The project tsconfig targets ESNext/bundler, which the CommonJS transform stage
  cannot consume.

Tests use dependency mocking; **no database or Redis is required** to run them.

## Known platform-specific issues

### Jest fails to start on Windows without the Visual C++ runtime

**This is environment-specific, not repository-specific.** The Jest, ts-jest,
and TypeScript configuration is valid and version-compatible. Nothing in the
repository needs to change to fix it.

**Symptom**

```
● Validation Error:

  Module ts-jest in the transform option was not found.
         <rootDir> is: …\backend
```

The message is misleading. `ts-jest` is installed and `require.resolve('ts-jest')`
succeeds.

**Root cause**

Two layers:

1. Jest 30 replaced its pure-JavaScript resolver with the native `unrs-resolver`
   (`jest-resolve/build/index.js` → `require("unrs-resolver")`). When that module
   fails to load, Jest cannot resolve *any* transform and reports the transform as
   missing.
2. `unrs-resolver` loads `@unrs/resolver-binding-win32-x64-msvc/resolver.win32-x64-msvc.node`,
   an MSVC-built addon. On a machine without the **Visual C++ 2015–2022
   Redistributable (x64)**, that load fails with `The specified module could not
   be found` — the Windows signature for a missing dependent DLL, not a missing
   file. Confirmed by the absence of `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`, and
   `MSVCP140.dll` from `C:\Windows\System32`.

Node itself runs because official Windows builds statically link the CRT. The
native addon does not.

`unrs-resolver`'s own error text blames a known npm optional-dependency bug. In
this case that is a red herring: the lockfile carries
`@unrs/resolver-binding-win32-x64-msvc@1.11.1` correctly as an optional dev
dependency, and the installed version matches.

**Resolution**

Install the **Microsoft Visual C++ 2015–2022 Redistributable (x64)**. This is
the correct and permanent fix. It requires administrator rights and is a
machine-level change, not a repository change.

If you cannot install it immediately, the three DLLs can be placed next to the
addon — Node's `uv_dlopen` uses `LOAD_WITH_ALTERED_SEARCH_PATH`, which searches
the loading module's own directory:

```
copy  <source>\{vcruntime140,vcruntime140_1,msvcp140}.dll
  ->  backend\node_modules\@unrs\resolver-binding-win32-x64-msvc\
```

On this machine the DLLs were located inside an Edge WebView WinSxS component.
**This workaround does not survive `rm -rf node_modules && npm ci`.** Treat it as
a stopgap; install the redistributable.

**Rejected alternatives**, recorded so they are not retried:

- *Downgrade Jest to 29* (whose resolver is pure JavaScript) — works, but changes
  a major version of a functioning toolchain for every developer and CI machine
  to compensate for one workstation's missing runtime.
- *Add `@unrs/resolver-binding-wasm32-wasi` as a devDependency* — `unrs-resolver`
  does have a WASM fallback rung, but npm refuses the package on x64
  (`notsup — Valid cpu: wasm32`), so it would break `npm ci` for everyone.
- *A `postinstall` shim* — repository scope creep that hides a machine problem.

CI on standard Windows GitHub runners is unaffected; those images ship the
redistributable. Linux and macOS are unaffected entirely.

---

# Development Workflow

Order matters. Each step depends on the one before it.

1. **Infrastructure.** PostgreSQL and Redis running. Redis is not in the compose
   file — start it separately.
2. **Prisma client generated.** `npx prisma generate`. Nothing type-checks or
   runs without it, and it is not in the repository.
3. **Backend API** — `npm run dev` in `backend/`. This also starts the Gmail
   scheduler, which begins polling immediately on startup rather than waiting an
   interval. If you do not want polling, leave the mailbox unconnected.
4. **Workers** — `npm run worker:email` and `npm run worker:attachment`, each in
   its own terminal. The API enqueues jobs; without workers, messages are
   captured and never interpreted. Nothing warns you about this.
5. **Frontend** — `npm run dev` in `client/`.
6. **Tests** — `npm test` in `backend/`, at any point. Tests mock their
   dependencies and need neither database nor Redis.

Two ingestion entry points exist: `POST /email` for manual submission, and the
Gmail scheduler for unattended sync. The manual path is the faster loop when
working on extraction or matching, and it does not require OAuth.

---

# Common Commands

## `backend/`

| Command | What it does |
|---|---|
| `npm run dev` | `tsx watch src/server.ts` — API with reload. Starts the Gmail scheduler. |
| `npm run worker:email` | `tsx watch src/workers/email.worker.ts` — consumes `email-processing`. Treats Prisma `P2002` (duplicate event) as success. |
| `npm run worker:attachment` | `tsx watch src/modules/attachment/attachment.worker.ts` — consumes `attachment-processing`. |
| `npm run build` | `prisma generate && tsc && node scripts/fix-esm-imports.js`. All three stages are required. |
| `npm start` | `node dist/src/server.js` — runs the build output. Requires `npm run build` first. |
| `npm run prisma:generate` | `prisma generate`. Same as `npx prisma generate`. |
| `npm test` | `jest`. |
| `npm run test:redis` | `tsx src/infrastructure/redis/test.ts` — a manual smoke script that SETs and GETs one key, prints it, and exits. Not part of the Jest suite. |

Useful commands not in `package.json`:

| Command | What it does |
|---|---|
| `npx prisma migrate dev` | Applies migrations and regenerates the client. Targets `DATABASE_URL`. |
| `npx prisma migrate deploy` | Applies pending migrations without reset. Use against shared databases. |
| `npx prisma studio` | Database browser. Also targets `DATABASE_URL`. |
| `npx tsc --noEmit` | Type-check without emitting. Excludes `__tests__`. |
| `npx jest <pattern>` | Run a subset. |
| `docker compose up -d` / `down` | Start/stop the PostgreSQL container. |

## `client/`

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server, default port 5173. |
| `npm run build` | `tsc -b && vite build`. |
| `npm run lint` | ESLint 9 flat config. |
| `npm run preview` | Serves the production build locally. |

## Root

No scripts. The root `package.json` declares `@types/cors` and `@types/node` and
nothing else.

---

# Troubleshooting

### Prisma

**`Cannot find module '../../generated/prisma/client.js'`**
The client has not been generated. `generated/prisma` is gitignored. Run
`npx prisma generate`.

**`ERR_MODULE_NOT_FOUND` from `dist/generated/…` after a build**
`scripts/fix-esm-imports.js` did not run. Use `npm run build`, not bare `tsc`.

**`Cannot resolve environment variable: DATABASE_URL`**
The CLI found no value. Either `backend/.env` is missing (copy `.env.example`)
or you are running from outside `backend/`, where `dotenv` cannot find it.

**Migrations applied to the wrong database**
`DATABASE_URL` named something other than what you expected. The CLI prints the
resolved target before it acts — `Datasource "db": PostgreSQL database "…" at
"host:port"` — so check that line rather than guessing.

**`Database URL loaded: false` on startup**
`src/lib/prisma.ts` logs this. `DATABASE_URL` is unset or `.env` is not in
`backend/`. `dotenv/config` is imported at the top of that module, so the file
must sit at the process working directory.

### Redis

**`ECONNREFUSED 127.0.0.1:6379`**
Redis is not running, or `REDIS_URL` is unset and ioredis fell back to its
default host. The compose file does not provide Redis.

**Jobs enqueue but never process**
Workers are not running. The API and workers are separate processes; the API does
not warn when nothing is consuming a queue.

### Google OAuth

**`redirect_uri_mismatch`**
`GOOGLE_REDIRECT_URI` must match the Google Cloud Console entry byte for byte —
scheme, host, port, path, trailing slash — and must route to `GET /gmail/callback`.

**No refresh token issued**
The auth URL sets `access_type: offline` and `prompt: consent`, which should
always yield one. If a grant already exists for the account, revoke it in the
Google account settings and re-authorise.

**Scope errors**
Only `https://www.googleapis.com/auth/gmail.readonly` is requested. The Cloud
Console consent screen must permit it.

### BullMQ

**`maxRetriesPerRequest must be null`**
BullMQ requires this on the ioredis connection. It is already set in
`src/infrastructure/redis/redis.ts`. If you construct your own client, mirror it.

**No queue dashboard**
`@bull-board/api` and `@bull-board/express` are declared as dependencies but
imported nowhere. There is no dashboard route to visit.

### TypeScript

**`Cannot find name 'jest' / 'describe' / 'expect'` in test files**
Expected, and not a defect. `tsconfig.json` excludes `src/**/__tests__/**` and
declares `types: ["node"]`, so an editor type-checking against the app config
cannot see jest globals. ts-jest supplies them via its inline tsconfig override
at test time. `npx tsc --noEmit` is clean.

To type-check a test file the way ts-jest will:

```bash
npx tsc --noEmit --module commonjs --moduleResolution node --target ES2022 \
  --esModuleInterop --strict --skipLibCheck --types node,jest <file>
```

**Client and backend disagree about TypeScript**
They are on different majors (~6.0.2 and ^5.9.3) with separate tsconfigs. They
share no code. Do not attempt to cross-compile.

### Jest

See *Testing → Known platform-specific issues*. The short diagnostic: if
`npm test` reports a missing transform module, run

```bash
node -e "require('unrs-resolver')"
```

If that throws, the problem is the native resolver, not your Jest configuration.

### Native module installation

Two native dependencies exist in the tree: `unrs-resolver` (via `jest-resolve`)
and `msgpackr-extract` (via BullMQ, with a `node-gyp` install script). npm 11
gates install scripts — `npm install` prints:

```
npm warn allow-scripts   msgpackr-extract@3.0.3 (install: node-gyp rebuild)
npm warn allow-scripts   prisma@7.5.0 (install: (install scripts present))
npm warn allow-scripts   unrs-resolver@1.11.1 (install: (install scripts present))
```

These warnings are expected and do not indicate failure. `msgpackr-extract` is an
optional accelerator; BullMQ falls back to pure JavaScript without it. Review with
`npm approve-scripts --allow-scripts-pending` if you want the native builds.

---

# Platform Notes

## Windows

Discovered during AC-2 verification on Windows 11 Pro (26200), Node 24.18.0, npm
11.16.0:

- **The Visual C++ 2015–2022 Redistributable (x64) is a hard prerequisite for
  running the test suite.** Without it Jest 30 cannot start. Full analysis under
  *Testing*. This is the single most likely blocker on a new Windows machine and
  it is not mentioned anywhere else in the repository.
- The missing DLLs may already exist on the machine inside a WinSxS component
  (Edge WebView ships them). Copying them beside the addon unblocks Jest without
  admin rights, but does not survive a clean `npm ci`.
- Both Git Bash and PowerShell work. Git Bash is more convenient for the
  `docker compose` and `npx` invocations in this document.
- Git may report `LF will be replaced by CRLF` when touching source files. This
  is line-ending normalisation, not a content change; no `.gitattributes` is
  configured.

## Linux and macOS

- `unrs-resolver` ships gnu, musl, and darwin bindings with no Visual C++
  dependency. `npm install` followed by `npm test` is expected to work with no
  extra steps. The Jest failure above cannot occur.
- `docker compose up -d` binds host port 5435; adjust if occupied.
- Nothing in the backend depends on Windows path semantics —
  `scripts/fix-esm-imports.js` uses `node:path` throughout.

## All platforms

`docker-compose.yml` declares `version: "4.65"`, which is not a valid Compose
file version. Compose v2 ignores the field and may warn that it is obsolete; the
file otherwise parses and runs correctly.

---

# Future Improvements

Onboarding friction observed while writing this document. **None of these are
implemented.** Each is a separate change.

**Secrets and configuration**

1. **Rotate the previously committed database credential.** The hardcoded
   connection string has been removed from `backend/prisma.config.ts` (and from
   the stale compiled `prisma.config.js` that also carried it), but **it remains
   in git history**. Removing it from `HEAD` does not revoke it. The credential
   must be rotated at the database provider and treated as compromised until it
   is. See the migration note accompanying that change.
2. **Add `client/.env.example`.** `backend/.env.example` now exists; the client's
   single variable is still documented only in this file.

**Environment definition**

3. **Declare `engines` (and add `.nvmrc`)** so the Node requirement is enforced
   rather than inferred from what happens to work.
4. **Add Redis to `docker-compose.yml`.** It is a hard runtime dependency and the
   only infrastructure a developer must provision by hand.
5. **Fix the obsolete Compose `version` field.**

**Developer experience**

6. **Add scripts to the root `package.json`** — or adopt npm workspaces — so
   install, build, and test can be driven from one place instead of two.
7. **Add a preflight check** that verifies the Prisma client exists, Redis is
   reachable, and required variables are set, with actionable messages. Most of
   the *Troubleshooting* section describes failures a preflight would catch.
8. **Wire or remove `@bull-board`.** It is installed and unused; a queue dashboard
   would be genuinely useful for the worker-driven flow.
9. **Align the TypeScript majors** across backend and client, or document the
   divergence as intentional.

**Automation**

10. **Add CI.** No workflow configuration exists anywhere in the repository, so
    the 73-test suite runs only when someone remembers to run it locally — on a
    platform where the runner may not start.
11. **Document the Visual C++ prerequisite in the root `README.md`**, which is
    currently the first thing a new engineer reads and does not mention it.

---

# Confidence

**High.** Every statement is derived from the working tree: both `package.json`
files and the root one, `jest.config.cjs`, `tsconfig.json`, `prisma.config.ts`,
`prisma/schema.prisma` and its 14 migrations, `docker-compose.yml`,
`.gitignore`, `src/app.ts`, `src/server.ts`, `src/lib/prisma.ts`,
`src/infrastructure/redis/redis.ts`, both worker entry points, the Gmail service
and routes, the attachment storage service, `scripts/fix-esm-imports.js`, and the
client's `vite.config.ts` and API modules.

Environment variables were enumerated by exhaustive search for `process.env.*`
and `import.meta.env.*` across `backend/src`, `backend/prisma`, and `client/src`,
then cross-checked against the key names present in the untracked `.env` files.
**No values were read or reproduced.**

Version numbers under *Required Software* are **verified, not declared** — the
repository specifies no Node or npm requirement. Treat them as a known-good
configuration rather than a supported matrix.

The Jest failure analysis was reproduced and resolved on this machine; test
counts and timings are from an actual run.
