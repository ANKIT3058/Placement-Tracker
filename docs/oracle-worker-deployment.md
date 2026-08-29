# Oracle VM worker deployment

> [!IMPORTANT]
> **STATUS: PLANNED, NOT APPLIED.** The unit files in `deploy/systemd/` and the
> procedure below are written and committed, but they are **not installed on any
> host**. No VM is running these workers today.
>
> The current production runtime for both queues is the pair of manually
> dispatched GitHub Actions drains described in
> [`deployment.md` §11.3](./deployment.md#113-the-github-actions-drains).
> This document is the plan for replacing them; read it in the future tense.

How the two background workers *would* run continuously on an Oracle Cloud VM
under systemd, replacing the manually dispatched GitHub Actions drains.

This is a companion to [`deployment.md`](./deployment.md), not a replacement.
That guide still owns the web service, the frontend, Neon, Redis provisioning
and Google OAuth. This one owns exactly one thing: **the queue consumers**.

---

## Contents

1. [What changes, and what does not](#1-what-changes-and-what-does-not)
2. [Prerequisites](#2-prerequisites)
3. [Node.js](#3-nodejs)
4. [Repository setup](#4-repository-setup)
5. [Production environment configuration](#5-production-environment-configuration)
6. [Build](#6-build)
7. [Installing the systemd units](#7-installing-the-systemd-units)
8. [Starting and enabling](#8-starting-and-enabling)
9. [Checking status](#9-checking-status)
10. [Viewing logs](#10-viewing-logs)
11. [Updating after a new push](#11-updating-after-a-new-push)
12. [The GitHub Actions workflows after this](#12-the-github-actions-workflows-after-this)
13. [Troubleshooting](#13-troubleshooting)

---

# 1. What changes, and what does not

Before, from [`deployment.md` §11.1](./deployment.md#111-two-runtimes-and-only-one-of-them-is-always-on):

```
  ALWAYS ON                          RUN ON DEMAND
  ───────────────────────            ───────────────────────
  RENDER — web service               GITHUB ACTIONS — batch drain
  ├─ Express (HTTP API)              ├─ email.worker.js   (manual dispatch)
  ├─ Gmail scheduler      (timer)    └─ attachment.worker.js (manual dispatch)
  ├─ Email reconciler     (timer)
  └─ Attachment reconciler (timer)

  Produces queue jobs. Consumes none.
```

After:

```
  ALWAYS ON                          ALWAYS ON                      RUN ON DEMAND
  ───────────────────────            ─────────────────────────      ──────────────
  RENDER — web service               ORACLE VM — systemd            GITHUB ACTIONS
  ├─ Express (HTTP API)              ├─ ...email-worker.service     └─ maintenance
  ├─ Gmail scheduler      (timer)    └─ ...attachment-worker.service   only
  ├─ Email reconciler     (timer)
  └─ Attachment reconciler (timer)   Consumes both queues.
                                     Produces nothing.
  Produces queue jobs.
```

**What does NOT change, and is worth being explicit about:**

- **Gmail polling does not move.** It never lived in the worker. `startGmailScheduler()`
  runs inside the Render web process on a `setInterval`
  (`GMAIL_SYNC_INTERVAL_MS`, 120 s), along with both reconcilers. The VM runs no
  timer of its own — it consumes a queue and blocks on Redis when the queue is
  empty. **Do not** move the schedulers here; two hosts running them would sync
  every mailbox twice.
- **No database, Redis or schema change.** The VM connects to the same Neon
  Postgres and the same Redis the web service already uses.
- **No public port.** Neither worker listens on anything. See §2.

---

# 2. Prerequisites

- An Oracle Cloud VM (an Always Free `VM.Standard.A1.Flex` shape is ample — 1
  OCPU / 6 GB is more than either worker needs) running Ubuntu 22.04 or 24.04.
- Outbound internet from the VM to Neon, Redis, `gmail.googleapis.com`, and —
  only if `USE_AI=true` — `api.openai.com`.
- `sudo` on the VM.

**Ingress: none required.** Both workers are pure consumers; they open no HTTP
port. Leave the Oracle security list and the host firewall closed to everything
except the SSH port you administer from. In particular, do **not** open Postgres
or Redis to the internet for the worker's benefit — the worker dials *out* to
both, over TLS, using the connection strings the web service already uses.

---

# 3. Node.js

Match the version the drain workflows pin, so the VM and CI build the same tree:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version    # v24.x
```

Note the absolute path — the unit files hardcode `/usr/bin/node`:

```bash
command -v node   # expect /usr/bin/node
```

If your install puts it elsewhere (nvm does), either symlink it or edit
`ExecStart=` in both units. systemd runs no shell, so `ExecStart=node ...`
without a path will not resolve.

---

# 4. Repository setup

A dedicated, unprivileged service account with no login shell:

```bash
sudo useradd --system --create-home --home-dir /var/lib/placement \
             --shell /usr/sbin/nologin placement
```

Check the code out under `/opt`, owned by that account:

```bash
sudo install -d -o placement -g placement /opt/placement-tracker
sudo -u placement git clone https://github.com/ANKIT3058/Placement-Tracker.git \
     /opt/placement-tracker
```

> [!NOTE]
> The repository is not a workspace root. `backend/` is a self-contained npm
> project with its own lockfile, and every command below runs from
> `/opt/placement-tracker/backend`.

---

# 5. Production environment configuration

The workers read plain `process.env`. They also `import "dotenv/config"`, which
looks for a `.env` in the working directory — **production does not rely on
that**, and `.env` is gitignored, so a fresh clone has none. Configuration comes
from systemd's `EnvironmentFile` instead. (dotenv does not overwrite variables
that are already set, so a stray `.env` could not override systemd anyway.)

```bash
sudo install -d -m 0750 -o root -g placement /etc/placement-tracker
sudo cp /opt/placement-tracker/deploy/systemd/worker.env.example \
        /etc/placement-tracker/worker.env
sudo chown root:placement /etc/placement-tracker/worker.env
sudo chmod 0640           /etc/placement-tracker/worker.env
sudo -e /etc/placement-tracker/worker.env      # fill in the real values
```

`0640 root:placement` means the service account can read it and cannot alter it,
and no other user on the box can do either.

**Variables — names only. Never commit values.**

| Variable | Email worker | Attachment worker | Notes |
|---|:--:|:--:|---|
| `DATABASE_URL` | required | required | Pooled. Same value as the web service |
| `REDIS_URL` | required | required | Same queue instance as the web service |
| `GOOGLE_CLIENT_ID` | — | required | Token refresh for attachment downloads |
| `GOOGLE_CLIENT_SECRET` | — | required | ” |
| `USE_AI` | optional | optional | `"true"` enables the AI branch |
| `OPENAI_API_KEY` | conditional | conditional | **Required when `USE_AI=true`** |
| `NODE_ENV` | optional | optional | Set to `production` |
| `ATTACHMENT_STORAGE_DIR` | — | set by the unit | Do not override here |
| `WORKER_EXIT_WHEN_DRAINED` | **do not set** | **do not set** | See below |

Deliberately absent: `DIRECT_DATABASE_URL` (Prisma CLI only — migrations are
applied from a workstation, never from the VM), `SESSION_SECRET`,
`SESSION_REDIS_URL`, `FRONTEND_URL`, `PORT`, `GOOGLE_REDIRECT_URI`. Those belong
to the web service.

> [!WARNING]
> **`WORKER_EXIT_WHEN_DRAINED` must not be `true` here.** It makes a worker exit
> the moment its queue is empty — correct for a one-shot drain, catastrophic
> under systemd, where `Restart=` would relaunch it seconds later forever. Both
> units pin it empty *after* loading this file so a stray value is overridden,
> but leave it out regardless.

**`EnvironmentFile` is not dotenv.** No `export`, no variable expansion, no
inline comments, and a literal `$` must be written `$$`. A Postgres password
containing `$` is the usual casualty — percent-encode it in the URL.

### The startup check

Both workers validate their configuration as the first thing they do
(`src/shared/config/worker-env.ts`). A missing or blank variable produces one
line naming it, and exit 1 — never a partially working process. This replaces
the workflows' `Verify credentials are present` step, which a systemd unit has
no equivalent of. Names are logged; values never are.

---

# 6. Build

```bash
cd /opt/placement-tracker/backend
sudo -u placement npm ci
sudo -u placement env DIRECT_DATABASE_URL=postgresql://unused:unused@localhost:5432/unused \
     npm run build
```

Two things worth knowing:

- **`npm ci`, not `npm install`.** It installs the lockfile exactly, and
  re-resolves the platform binaries for the VM's architecture — the committed
  tree is developed on Windows, and an Ampere VM is `linux-arm64`.
- **The dead `DIRECT_DATABASE_URL`.** `prisma.config.ts` calls `env(...)`, which
  throws at config-evaluation time, and the Prisma CLI loads that config for
  every command including `generate`. Nothing reads the value — `generate` is
  offline codegen — so the real unpooled endpoint stays off the VM entirely.
  This mirrors what the drain workflows already do.

`npm run build` is `prisma generate && tsc && node scripts/fix-esm-imports.js`.
All three stages are required: `generated/prisma` is gitignored and therefore
absent from a fresh clone, and `fix-esm-imports` patches Prisma's extensionless
imports, which Node's ESM loader rejects.

Confirm the entrypoints exist:

```bash
ls -l dist/src/workers/email.worker.js \
      dist/src/modules/attachment/attachment.worker.js
```

---

# 7. Installing the systemd units

```bash
sudo cp /opt/placement-tracker/deploy/systemd/placement-tracker-email-worker.service \
        /opt/placement-tracker/deploy/systemd/placement-tracker-attachment-worker.service \
        /etc/systemd/system/
sudo systemctl daemon-reload
```

Verify before starting anything — this catches a typo without a restart loop:

```bash
systemd-analyze verify placement-tracker-email-worker.service
systemd-analyze verify placement-tracker-attachment-worker.service
```

---

# 8. Starting and enabling

`enable` survives reboot; `start` acts now. Do them in that order, one worker at
a time, so a failure is unambiguous:

```bash
sudo systemctl enable --now placement-tracker-email-worker.service
sudo systemctl status  placement-tracker-email-worker.service --no-pager

sudo systemctl enable --now placement-tracker-attachment-worker.service
sudo systemctl status  placement-tracker-attachment-worker.service --no-pager
```

Expect `active (running)` and, in the journal, `✅ Redis connected`.

> [!IMPORTANT]
> Before enabling the attachment worker, know that it now writes downloaded
> files to `/var/lib/placement-tracker/attachments` and **keeps them**. Under
> GitHub Actions they vanished with the runner. Nothing in the codebase reads
> them back yet — parsed results go to Postgres — so the directory only grows.
> See §13.

---

# 9. Checking status

```bash
systemctl status placement-tracker-email-worker.service
systemctl is-active placement-tracker-email-worker.service
systemctl list-units 'placement-tracker-*'
```

`systemd` plus `journalctl` is the whole monitoring story here, deliberately.
The useful questions and where they are answered:

| Question | Where |
|---|---|
| Is the worker up? | `systemctl is-active` |
| Has it been crash-looping? | `systemctl status` — look at `Restart=` counters and the timestamp |
| Is it doing work? | `journalctl` — completed/failed lines per job |
| Is the queue backing up? | Neither. Ask Redis, or the Bull Board mounted by the web service |

A running-but-idle worker is normal: it blocks on Redis until the web service's
Gmail scheduler enqueues something.

---

# 10. Viewing logs

```bash
# Follow one worker
journalctl -u placement-tracker-email-worker.service -f

# Both at once, distinguishable by SyslogIdentifier
journalctl -u placement-tracker-email-worker.service \
           -u placement-tracker-attachment-worker.service -f

# Since the last boot / a time window
journalctl -u placement-tracker-email-worker.service -b
journalctl -u placement-tracker-email-worker.service --since "1 hour ago"

# Errors only
journalctl -u placement-tracker-email-worker.service -p err
```

What the workers emit, and what they are careful not to:

| Event | Line |
|---|---|
| Started | `✅ Redis connected` |
| Job picked up | a JSON object: `jobId`, `queue`, `emailId`/`attachmentId`, `attempts` |
| Job succeeded | `Job <id> completed` |
| Job failed | `Job failed` + `jobId`, `emailId`, `attempts`, `reason` |
| Worker-level error | `Worker error` + `reason` — a lapsed lock, a reconnect |
| Shutdown | `Received SIGTERM, shutting down worker...` → `Worker shut down successfully` |
| Fatal misconfiguration | `Fatal configuration error: required environment variable(s) not set: ...` |

Log lines carry **safe scalars only** — never a raw error object. This is
deliberate and load-bearing: a gaxios rejection carries the full request config
and headers (including the mailbox's refresh token), and a pg error carries the
failing statement and its parameters. Journal entries are readable by any member
of `systemd-journal`.

Retention is the journal's own (`journalctl --disk-usage`, `/etc/systemd/journald.conf`).

---

# 11. Updating after a new push

```bash
cd /opt/placement-tracker
sudo -u placement git pull --ff-only

cd backend
sudo -u placement npm ci
sudo -u placement env DIRECT_DATABASE_URL=postgresql://unused:unused@localhost:5432/unused \
     npm run build

sudo systemctl restart placement-tracker-email-worker.service
sudo systemctl restart placement-tracker-attachment-worker.service
```

Build **before** restarting. `restart` is stop-then-start, and the stop sends
SIGTERM and waits out `TimeoutStopSec` for the active job to finish — so
rebuilding first means the gap between the old process ending and the new one
starting is as short as possible. Jobs are durable in Redis regardless; nothing
is lost across a restart, it merely waits.

If the push contains a **migration**, apply it from a workstation first, in the
order [`deployment.md` §4.7](./deployment.md#47-deployment-order--schema-before-code)
sets out. The VM has no `DIRECT_DATABASE_URL` and must not be the host that runs
`prisma migrate deploy`.

Re-copy the unit files and `daemon-reload` only when `deploy/systemd/` itself
changed.

---

# 12. The GitHub Actions workflows after this

**Both workflows stay. Neither is deleted, and neither needs editing.**

They were already `workflow_dispatch`-only — no `schedule`, no `push`, no
`pull_request` trigger — and gated behind the `production-worker` environment's
required reviewer. So they cannot fire on their own, and **cannot accidentally
duplicate the continuous processing the VM now does.** Their role simply narrows:

| | Runtime | Role after this |
|---|---|---|
| Oracle VM + systemd | continuous | **Normal operation.** Both queues, always consuming |
| `production-worker.yml` | one-shot | Maintenance: drain a backlog from CI when the VM is down or being rebuilt |
| `production-attachment-worker.yml` | one-shot | Same, for the attachment queue |

**Running one while the VM is up is safe, just wasteful.** Two consumers on one
BullMQ queue is a supported configuration — every job is locked by the worker
holding it, and both producers use deterministic job ids (`email-<id>`,
`attachment-<id>`), so the same email cannot be processed twice concurrently.
The two would simply split the backlog. There is no distributed lock here and
none is needed.

The one behavioural difference to keep in mind: the workflows set
`WORKER_EXIT_WHEN_DRAINED=true` and the units pin it empty. That single variable
is the entire difference between the two runtimes — the compiled entrypoint is
identical.

---

# 13. Troubleshooting

### `active (running)` but nothing is processed

Expected when the queue is empty. Confirm by checking whether the web service is
enqueuing at all — `journalctl` on the VM will show job lines within a Gmail
cycle (120 s) of a new mail arriving.

If the queue is *not* empty and the worker is still idle, it is almost certainly
pointed at a different Redis than the web service. Compare `REDIS_URL` on both
sides. Historically the silent version of this was a **missing** `REDIS_URL` —
ioredis fell back to `127.0.0.1:6379` and retried forever without exiting. The
startup check now refuses to start in that case.

### `failed` immediately after start, five times

A configuration error. The journal names the variable:

```bash
journalctl -u placement-tracker-email-worker.service -n 20 --no-pager
```

Fix `/etc/placement-tracker/worker.env`, then:

```bash
sudo systemctl reset-failed placement-tracker-email-worker.service
sudo systemctl start placement-tracker-email-worker.service
```

`reset-failed` clears the start-limit counter. Without it, systemd refuses to
start the unit again inside the `StartLimitIntervalSec` window even though the
configuration is now correct.

### `status=203/EXEC`

systemd could not execute `ExecStart`. Either `/usr/bin/node` does not exist
(§3) or the build has not run (§6).

### `EROFS` / permission denied writing an attachment

`ATTACHMENT_STORAGE_DIR` is pointing somewhere `ProtectSystem=strict` makes
read-only. It should be `/var/lib/placement-tracker/attachments`, inside the
unit's `StateDirectory`. Check for an override in `worker.env`.

### Attachment storage growth

```bash
sudo du -sh /var/lib/placement-tracker/attachments
```

These files persist now where the GitHub runner discarded them, and nothing
reads them back — the parsed results live in Postgres. Deleting them will not
break the current pipeline, but it will discard the only copy of the original
file, so treat it as a decision rather than routine cleanup.

### A job is retried forever / a queue will not drain

Both producers set `attempts: 3` with exponential backoff from 2 s, and
`removeOnFail: false` — so a permanently failing job stays in the failed set and
holds its deterministic job id, which prevents re-enqueue. That is by design.
Inspect and clear it through the Bull Board the web service mounts, not from the
VM.

### Stopping cleanly

```bash
sudo systemctl stop placement-tracker-email-worker.service
```

Sends SIGTERM and waits up to `TimeoutStopSec` (90 s email, 300 s attachment)
for the active job to finish. Do not `kill -9`: an abandoned job keeps its Redis
lock until BullMQ's stalled checker reclaims it, and a job stalled twice is
failed permanently.
