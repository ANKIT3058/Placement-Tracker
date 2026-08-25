import "dotenv/config";

import { attachmentQueue } from "../../src/modules/attachment/attachment.queue.js";
import { redis } from "../../src/infrastructure/redis/redis.js";
import { parseArgs, selectJobs, USAGE } from "./selection.js";
import type { SelectableJob } from "./selection.js";

/* One-off recovery for the G-7.4 incident.
 *
 * Every attachment download failed with `400 invalid_request` because the
 * production worker ran without GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, so
 * google-auth-library could not exchange the mailbox refresh token. The
 * credentials are fixed; these jobs are not, and nothing recovers them on its
 * own:
 *
 *   - `removeOnFail: false` retained each job's hash, so `attachment-${id}` is
 *     still occupied and `enqueueAttachmentProcessing` would be a SILENT NO-OP
 *     (addStandardJob returns early when the hash exists);
 *   - the G-7.3 reconciler excludes `failed` rows by design;
 *   - the drain condition excludes the `failed` set, so simply re-dispatching
 *     the workflow finds an empty queue and exits 0 having done nothing.
 *
 * SAFETY PROPERTY 1 — A RETRY REUSES THE EXISTING JOB, IT DOES NOT CREATE ONE.
 *
 * `job.retry()` runs BullMQ's `reprocessJob` script, which ZREMs the job from
 * the failed set, HDELs `finishedOn`/`processedOn`/`failedReason`, and pushes
 * the SAME job id back onto the wait list. The hash is reused; no second job for
 * the same attachment can exist, because the id never changes and BullMQ refuses
 * a duplicate add against a live hash. `queue.add` is never called here — that
 * is the operation that would be a no-op anyway, and the one that could drift
 * from the producer's job options.
 *
 * SAFETY PROPERTY 2 — DRY RUN IS THE DEFAULT; `--apply` IS REQUIRED.
 *
 * Running this with no arguments reads Redis and prints what it WOULD do. There
 * is no confirmation prompt to click through and no flag that mutates by
 * accident: mutation happens only when an operator types `--apply`, and passing
 * both `--dry-run` and `--apply` is an error rather than a race.
 *
 * The database is never touched. It does not need to be: `isSettled` treats
 * `processingStatus: "failed"` as replayable, so a retried job re-runs the whole
 * pipeline and `markAttachmentProcessing` overwrites the row on its way through.
 * This script imports no Prisma client at all, so that is structural rather than
 * a promise.
 *
 * Dispatch the production attachment worker separately, AFTER retrying — the
 * drain condition counts `waiting`, so jobs must already be back there.
 */

const describe = (job: SelectableJob): string =>
  [
    `  ${job.id ?? "<no id>"}`,
    `attempts=${job.attemptsMade}`,
    `reason=${job.failedReason ?? "<none recorded>"}`,
  ].join("  ");

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));

  console.log("");
  console.log("Attachment recovery — attachment-processing");
  console.log(`Mode: ${args.apply ? "APPLY (will retry)" : "dry run (read-only)"}`);
  console.log(
    `Filters: ${
      [
        args.reason ? `reason contains "${args.reason}"` : null,
        args.ids ? `ids ${args.ids.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("; ") || "none — every failed job"
    }`,
  );

  // Read-only. `getFailed` reads the failed ZSET; the one mutating branch in
  // BullMQ's range/count scripts applies to `wait`/`paused` only.
  const failed = await attachmentQueue.getFailed(0, -1);

  console.log("");
  console.log(`Failed jobs on the queue: ${failed.length}`);

  const { selected, excluded } = selectJobs(failed, args);

  if (excluded.length > 0) {
    console.log("");
    console.log(`Excluded by filters: ${excluded.length}`);
    for (const { job, because } of excluded) {
      console.log(`${describe(job)}  [${because}]`);
    }
  }

  console.log("");
  console.log(`Selected for recovery: ${selected.length}`);
  for (const job of selected) {
    console.log(describe(job));
  }

  if (!args.apply) {
    console.log("");
    console.log("DRY RUN — nothing was retried and nothing was modified.");
    console.log("Re-run with --apply to retry the selected jobs.");
    return 0;
  }

  // Reported as a failure rather than a quiet success: "--apply matched nothing"
  // usually means the filter was wrong, not that the work is done.
  if (selected.length === 0) {
    console.log("");
    console.log("NOTHING MATCHED — no job was retried.");
    console.log("Check the filters against the dry-run output above.");
    return 1;
  }

  console.log("");
  console.log("Retrying (failed → waiting, in place)…");

  let retried = 0;
  const failures: string[] = [];

  // Sequential, with a per-job catch, matching how every other batch loop in
  // this codebase behaves: one job's failure must not abandon the rest.
  for (const job of selected) {
    try {
      // `resetAttemptsMade` restores the full `attempts: 3` budget the queue
      // gives a fresh enqueue. Without it these jobs arrive with attemptsMade
      // already at the limit and get exactly one try — enough when the fix is
      // correct, and not enough to survive a transient Gmail error.
      await job.retry("failed", { resetAttemptsMade: true });

      retried += 1;
      console.log(`  ✓ ${job.id} → waiting`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";

      failures.push(`${job.id}: ${reason}`);
      console.error(`  ✗ ${job.id}: ${reason}`);
    }
  }

  console.log("");
  console.log(`Retried: ${retried}/${selected.length}`);

  if (failures.length > 0) {
    console.log(`Could not retry: ${failures.length}`);
    for (const failure of failures) {
      console.log(`  ${failure}`);
    }
  }

  console.log("");
  console.log("Next: dispatch the Production Attachment Worker workflow.");
  console.log("The drain condition counts `waiting`, so it will pick these up.");

  return failures.length > 0 ? 1 : 0;
};

let exitCode = 0;

try {
  exitCode = await main();
} catch (error) {
  console.error("");
  console.error(error instanceof Error ? error.message : String(error));

  if (!(error instanceof Error) || !error.message.includes(USAGE.trim())) {
    // Usage errors already printed the help text; anything else gets a pointer.
    console.error("Run with --help for usage.");
  }

  exitCode = 1;
}

// The queue and the shared ioredis client keep the event loop alive, exactly as
// they do in the worker. Closed in the same order and for the same reason.
await attachmentQueue.close();

try {
  await redis.quit();
} catch {
  // Already closed, or closing. Nothing left to do either way.
}

process.exit(exitCode);
