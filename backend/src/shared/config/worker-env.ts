// STARTUP CONFIGURATION VALIDATION FOR THE WORKER PROCESSES (PR-10A).
//
// WHY THIS EXISTS AT ALL, given both workers ran in production without it.
//
// Until now every production worker run was wrapped by a GitHub Actions job
// whose "Verify credentials are present" step did exactly this in shell before
// `node` was ever invoked. That step was not decoration: it was added after a
// real incident in which the attachment drain shipped no Gmail credentials,
// every job failed at the OAuth token refresh with `400 invalid_request`, and
// the workflow still reported success — a green run that downloaded nothing
// (see `production-worker.workflow.test.ts`, "THE ASSERTION THAT SHOULD HAVE
// CAUGHT THE FIRST PRODUCTION RUN").
//
// A systemd unit has no such wrapper. `ExecStart=` runs the process directly,
// so moving to a VM would silently delete that check unless the process does it
// itself. This module is that step, relocated from the workflow into the
// program, where every runtime gets it.
//
// WHAT A MISSING VARIABLE ACTUALLY DOES WITHOUT THIS, which is worse than it
// sounds and is the reason this fails hard rather than warns:
//
//   REDIS_URL     `redis.ts` calls `new Redis(process.env.REDIS_URL!)`. The `!`
//                 is a compile-time assertion with no runtime effect, so
//                 `undefined` reaches ioredis, which treats a missing target as
//                 "use the defaults" and dials 127.0.0.1:6379. On a VM with no
//                 local Redis the client then retries FOREVER —
//                 `maxRetriesPerRequest: null` is set deliberately for the
//                 long-running case — so the unit stays `active (running)`,
//                 systemd never restarts it because it never exits, and the
//                 queue is drained by nobody. A worker that is up and idle is
//                 the hardest failure of the set to notice.
//
//   DATABASE_URL  The `pg.Pool` in `lib/prisma.ts` falls back to libpq's own
//                 defaults (PGHOST, PGUSER, the local socket). The process
//                 starts, connects to Redis, accepts a job, and fails it at the
//                 first query — once per job, three times per job with retries,
//                 indefinitely.
//
//   Gmail creds   The documented incident above: one 400 per attachment, and a
//                 run that looks like it worked.
//
// All three share a shape: the process comes UP and then misbehaves quietly.
// Refusing to start converts each of them into a single, obvious line in
// `journalctl` and a unit in `failed` state.
//
// NAMES ONLY, NEVER VALUES. Every message below prints variable names. The
// point of the check is to say which credential is absent; printing what was
// found would put a database URL — user, password and host — into the journal,
// which on a shared VM is readable by any member of `systemd-journal`.

/** Variables the email worker cannot run without. It never calls Gmail. */
export const EMAIL_WORKER_REQUIRED_ENV = ["DATABASE_URL", "REDIS_URL"] as const;

/**
 * Variables the attachment worker cannot run without.
 *
 * A superset of the email worker's, because this pipeline downloads the file
 * from Gmail before it parses anything: `gmail.service.ts` builds its OAuth2
 * client from GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, and without them the
 * stored refresh token cannot be exchanged for an access token. The two lists
 * differ for a reason and are kept separate rather than merged.
 */
export const ATTACHMENT_WORKER_REQUIRED_ENV = [
  "DATABASE_URL",
  "REDIS_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const;

type Env = Record<string, string | undefined>;

/**
 * The names in `required` that are absent or blank in `env`.
 *
 * A whitespace-only value counts as missing. It is what an operator gets from
 * `Environment="REDIS_URL="` in a unit file or a stray trailing space in an
 * `EnvironmentFile`, and it fails in exactly the same way an unset variable
 * does — so it must be reported the same way, not passed through as "set".
 */
export const findMissingEnv = (
  required: readonly string[],
  env: Env = process.env,
): string[] => required.filter((name) => (env[name] ?? "").trim() === "");

/**
 * The full requirement list for a run, given the run's own configuration.
 *
 * OPENAI_API_KEY is conditional, not optional. `getOpenAIClient()` throws
 * "OPENAI_API_KEY not set" the first time it is called, and both AI call sites
 * are fail-soft: `extraction.service` catches and degrades the email to
 * regex-only, and `document-processing.service` records no understanding. So a
 * worker started with `USE_AI=true` and no key does not crash — it quietly
 * produces lower-quality output forever, which is precisely the failure the
 * workflow's fail-fast step was written to prevent.
 *
 * Compared against the literal string "true", matching the gate the AI call
 * sites themselves use. Requiring the key on any other value would reject a
 * configuration that never reaches the provider.
 */
export const resolveRequiredEnv = (
  base: readonly string[],
  env: Env = process.env,
): string[] =>
  env.USE_AI === "true" ? [...base, "OPENAI_API_KEY"] : [...base];

/**
 * Refuse to start when the process is not configured to do its job.
 *
 * Returns normally when everything required is present; otherwise logs the
 * missing NAMES and exits 1.
 *
 * WHY `process.exit(1)` RATHER THAN A THROW. An uncaught throw at module scope
 * also ends the process non-zero, but it prints a stack trace whose top frame
 * is this file — which reads as a bug in the worker rather than a missing
 * value in the unit file. The operator reading `journalctl` needs the variable
 * name, not a traceback.
 *
 * WHY EXIT 1 AND NOT A CLEAN 0. systemd distinguishes them: `Restart=on-failure`
 * retries a non-zero exit, and `StartLimitBurst` then gives up and parks the
 * unit in `failed` after a few immediate attempts. A configuration error is
 * therefore self-limiting — it produces a short burst of identical, legible log
 * lines and a red `systemctl status`, not an endless restart loop. Exiting 0
 * would look to systemd like a successful, completed run.
 */
export const assertWorkerEnv = (
  worker: string,
  base: readonly string[],
  env: Env = process.env,
): void => {
  const missing = findMissingEnv(resolveRequiredEnv(base, env), env);

  if (missing.length === 0) {
    return;
  }

  console.error(
    `[${worker}] Fatal configuration error: required environment variable(s) not set: ${missing.join(", ")}`,
  );
  console.error(
    `[${worker}] Refusing to start. Set the variable(s) above in the unit's EnvironmentFile and restart the service.`,
  );

  process.exit(1);
};
