# Operations Runbooks

Engineering Handbook — Operations
Status: operational reference. Describes procedures, not architecture.

---

# Purpose

Runbooks answer **"how do I operate this project?"**

They exist so that operational knowledge — the sequence that works, the error
that means a revoked token, the command that recovers a failed migration —
survives the person who learned it. Every procedure here was executed or read
from the implementation; none is aspirational.

**They do not answer "how is this built?"** Architecture, domain reasoning, and
settled decisions live in the handbook and are linked from each runbook.

---

# Document types

The repository carries four kinds of engineering document. Confusing them is the
main way documentation rots.

| Type | Location | Answers | Changes when |
|---|---|---|---|
| **Handbook** | `docs/00_`–`docs/03_` | What the system *is*: product intent, domain language, how the engine reasons, how to set the repository up | The architecture or the domain changes |
| **ADR** | `docs/06_ADR/` | Why one question is *settled* — context, decision, rejected alternatives, consequences | Never. A reversal supersedes; it does not edit |
| **RFC** | `docs/rfcs/` | What a proposed change *is*, in full, before and during implementation | While the change is being designed; frozen once accepted |
| **Runbook** | `docs/runbooks/` | What to *do*, step by step, when operating or recovering the system | The procedure changes — which is far more often than the architecture |

Three consequences worth internalising:

- **A runbook is allowed to be specific in ways a handbook is not.** It names
  commands, ports, URLs, log lines, and error strings. That specificity is the
  value; it is also why runbooks stale faster and must be re-verified.
- **A runbook never states a rationale that belongs in an ADR.** When a procedure
  looks arbitrary, it links to the decision instead of restating it.
- **Where a runbook and the handbook disagree, the handbook is the
  specification and the runbook is the bug.** The handbook states intended
  architecture; a runbook states observed operation. If operation contradicts
  intent, that is a defect to record, not a licence to rewrite the specification.

---

# Reading order

## New contributor

```
CONTRIBUTING.md                          how work is done here
        ↓
docs/README.md                           handbook index and conventions
        ↓
docs/03_Development/Development_Environment.md    the setup contract
        ↓
runbooks/local-development.md            starting and verifying the stack
        ↓
runbooks/google-cloud.md                 obtaining OAuth credentials
        ↓
runbooks/authentication.md               signing in and staying signed in
```

Stop there until something breaks. `migrations.md` and `troubleshooting.md` are
reference material, not onboarding.

## Operating an existing checkout

| Task | Runbook |
|---|---|
| Start the stack; confirm it is healthy | [local-development.md](local-development.md) |
| Sign in; reconnect a mailbox; recover a session | [authentication.md](authentication.md) |
| Add a test user; rotate credentials; change a redirect URI | [google-cloud.md](google-cloud.md) |
| Apply, verify, or recover a migration | [migrations.md](migrations.md) |
| Diagnose a specific failure | [troubleshooting.md](troubleshooting.md) |

---

# Template

Every runbook follows the same structure. Deviating from it makes the set harder
to scan under pressure, which is the only time these documents are read.

```
# Purpose            what this covers, in one paragraph
# When to Use        the trigger; when NOT to use it
# Prerequisites      what must already be true
# Procedure          numbered, copy-pasteable, no prose between steps
# Verification       how to know it worked — an observable, not a feeling
# Common Failures    symptom → cause → resolution
# Recovery           how to get back to a known state
# Related Documents  handbook, ADR, RFC, and sibling runbook links
# Confidence         what was verified, what was inferred, what is untested
```

The **Confidence** section is a handbook-wide convention
(`docs/README.md` → *Conventions*). It states what was executed versus read
versus assumed, so a reader knows which claims to trust when a procedure fails.

---

# Scope boundary

These runbooks cover the **backend and its infrastructure**: Express, PostgreSQL,
Redis, BullMQ, Prisma, and Google OAuth.

Not covered, because it does not exist yet:

- Production deployment, hosting, and rollback
- CI (no workflow configuration exists anywhere in the repository)
- Monitoring, alerting, and on-call procedure
- Incident response and postmortems

See *Still undocumented* at the end of
[troubleshooting.md](troubleshooting.md).

---

# Related Documents

- [CONTRIBUTING.md](../../CONTRIBUTING.md) — engineering workflow
- [docs/README.md](../README.md) — handbook index and conventions
- [Development_Environment.md](../03_Development/Development_Environment.md) —
  the setup contract these runbooks assume
- [RFC-001](../rfcs/RFC-001-authentication-multi-user-foundation.md) —
  authentication and multi-user architecture

---

## Future Runbooks

- deployment.md
- ci-cd.md
- monitoring.md
- secrets-management.md
- backup-restore.md

---

# Confidence

**High for structure, mixed for content — each runbook states its own.**

Every runbook in this directory was written against the working tree at the
completion of Phase 3 (AC-5.1 through AC-5.9) and states individually which of
its procedures were executed and which were read from source.

One systemic caveat applies to all of them:
`docs/03_Development/Development_Environment.md` is marked *canonical* but
predates Phase 3. It describes 14 migrations (there are now 18), 73 tests (there
are now 120), a schema with no `User` model, and `GET /gmail/sync` (now `POST`,
and authenticated). Its setup instructions remain correct; its counts and API
surface do not. The runbooks here supersede it on those points and say so
inline.
