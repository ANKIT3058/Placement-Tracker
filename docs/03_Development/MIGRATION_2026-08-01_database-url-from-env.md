# Migration note — database URL moved to the environment

Date: 2026-08-01
Type: security remediation
Affects: every developer with a local `backend/.env`

---

## What changed

`backend/prisma.config.ts` no longer contains a connection string. Its
`datasource.url` now reads `env("DATABASE_URL")`.

```
- url: "postgresql://<credential>@<host>/<db>?…"   // hardcoded, committed
+ url: env("DATABASE_URL")
```

Four stale compiled artifacts were deleted: `prisma.config.js`,
`prisma.config.js.map`, `prisma.config.d.ts`, `prisma.config.d.ts.map`. All four
were tracked in git and `prisma.config.js` carried the same credential. They were
a one-off compile — `prisma.config.ts` is not in the `tsconfig.json` `include`,
so `npm run build` never produced them and nothing imports them. They are now
gitignored so a future stray `tsc` cannot re-commit them.

`backend/.env.example` was added: every backend variable, placeholders only.

`docs/03_Development/Development_Environment.md` was updated in the sections this
change affects — the `DATABASE_URL` resolution rules, setup steps 5 and 6, the
Prisma troubleshooting entries, and the corresponding Future Improvements items.

## Why it changed

**A live credential was committed to the repository.** That is the reason this
work happened, and it is sufficient on its own.

A second problem disappeared with it. The Prisma CLI read the hardcoded literal
while the application runtime (`src/lib/prisma.ts`) read `DATABASE_URL`, so the
two could point at different databases with nothing reporting a problem — you
could apply migrations to one database while the API talked to another. There is
now one variable and one source of truth.

## Do I need to change anything locally?

**Probably not, but check.**

`backend/.env` is gitignored and was never modified by this change. If it already
defines `DATABASE_URL`, both the CLI and the runtime will now use that value.

- **If `backend/.env` already has `DATABASE_URL`** — nothing to do. Note that
  Prisma commands may now target a *different* database than before, because they
  previously ignored this variable. Run `npx prisma migrate status` and read the
  `Datasource "db": …` line it prints before running anything that writes.
- **If `backend/.env` does not have `DATABASE_URL`** — every Prisma command now
  fails immediately with `Cannot resolve environment variable: DATABASE_URL`. Copy
  the template and fill it in:

  ```bash
  cd backend && cp .env.example .env
  ```

- **To target a different database for one command**, export the variable
  inline. `dotenv` does not overwrite variables already set in the process, so an
  explicit value wins over `.env`:

  ```bash
  DATABASE_URL="postgresql://…" npx prisma migrate status
  ```

No schema change, no migration to apply, no code change outside the config file.

## Required follow-up: rotate the credential

**This change does not revoke anything.** The credential remains in git history
(`94ee15d`, `eb978e7`) and must be treated as compromised until rotated. Anyone
with repository access — past or present — has had it.

Outside the repository, in the **Neon dashboard**:

1. Open the project, then **Roles** for the affected branch.
2. **Reset the password** for the role used by that connection string. Neon issues
   a new password; the old one stops working immediately.
3. Copy the new connection string from **Connection Details**.
4. Update `DATABASE_URL` in every place it is configured: each developer's
   `backend/.env`, and any deployment or CI secret store.

No values are recorded here or anywhere else in the repository — that is the
point of the change.

Consider also whether the exposure warrants purging git history
(`git filter-repo`, or a fresh repository). That is a heavier operation requiring
every clone to be re-cloned, and it is a judgement call for the repository owner.
**Rotation is not optional; history rewriting is.**

## Verification performed

All Prisma commands were exercised against a deliberately unreachable local
address, never the remote database. Each printed
`Datasource "db": PostgreSQL database "verifydb" … at "127.0.0.1:5435"` — the
value supplied by `DATABASE_URL` — confirming resolution comes from the
environment and no hardcoded URL survives.

| Command | Result |
|---|---|
| `prisma validate` | schema valid, config loaded from `prisma.config.ts` |
| `prisma generate` | client generated |
| `prisma migrate status` | resolved env URL, failed to connect as expected |
| `prisma migrate deploy` | resolved env URL, failed to connect as expected |
| `prisma migrate dev` | resolved env URL, failed to connect as expected |
| `prisma studio` | started and served |
| `npm run build` | exit 0 (generate + tsc + fix-esm-imports) |
| `npm test` | 7 suites, 73 tests, 0 failures |

`env()` with the variable unset throws
`Cannot resolve environment variable: DATABASE_URL` — it does not fall back.

**Not verified end to end:** applying migrations against a live database. This
machine has neither Docker nor a local PostgreSQL, so `migrate dev` and
`migrate deploy` were confirmed only up to connection. Run both against a
throwaway database before relying on them in a new environment.
