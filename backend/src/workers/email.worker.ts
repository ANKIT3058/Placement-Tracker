import "dotenv/config";
import { Worker, UnrecoverableError } from "bullmq";
import { redis } from "../infrastructure/redis/redis.js";
import { QUEUE_NAMES } from "../shared/constants/queue.constants.js";
import { processEmailJob } from "../modules/email/email.processor.js";
import { getEmailById } from "../modules/email/email.repository.js";
import type { EmailJobData } from "../modules/email/email.types.js";
import type { OwnershipContext } from "../modules/auth/tenant-context.js";
import { Prisma } from "../../generated/prisma/client.js";
import { emailQueue } from "../infrastructure/queue/queues.js";

// BATCH MODE (PR-9K).
//
// Off by default, and off for anything other than the exact string "true", so a
// missing, empty or mistyped value leaves this process the permanent worker it
// has always been. Read once here rather than at each drain: the mode is a
// property of the run, and re-reading it would let a mutated environment change
// the process's lifecycle halfway through.
//
// Matches the codebase's existing boolean-env convention (extraction.service.ts).
const exitWhenDrained = process.env.WORKER_EXIT_WHEN_DRAINED === "true";

const worker = new Worker(
  QUEUE_NAMES.EMAIL_PROCESSING,
  async (job) => {
    const { emailId, userId: claimedUserId } = job.data as EmailJobData;

    const email = await getEmailById(emailId);

    if (!email) {
      throw new Error("Email not found");
    }

    // OWNERSHIP DERIVATION (RFC-001 §9.5).
    //
    // The owner comes from the persisted row, never from the payload. A queue is
    // not an authenticated channel — anything that can reach Redis can enqueue
    // a job — so a `userId` in `job.data` is a claim, and claims are checked,
    // not trusted.
    const owner: OwnershipContext = { userId: email.userId };

    // The payload's claim is compared against the derived owner purely so that
    // a disagreement is detectable. A mismatch means either a forged payload or
    // an ownership invariant broken upstream; both are conditions no retry can
    // fix, so the job is failed permanently rather than retried. `undefined` is
    // tolerated: jobs enqueued before this field existed carry no claim, and an
    // absent claim is not a conflicting one.
    if (claimedUserId !== undefined && claimedUserId !== email.userId) {
      throw new UnrecoverableError(
        `Ownership mismatch on email ${emailId}: payload claimed ${claimedUserId}, record owned by ${email.userId}`,
      );
    }

    console.log({
      jobId: job.id,
      queue: job.queueName,
      emailSubject: email.subject,
      userId: owner.userId,
      attempts: job.attemptsMade,
    });
    try {
      await processEmailJob(owner, emailId);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        console.log("Duplicate event detected");

        return;
      }

      throw error;
    }
  },
  {
    connection: redis,
  },
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} failed`, err);
});

// GRACEFUL SHUTDOWN (PR-9B).
//
// This process is stopped by a signal — a deploy, a restart, a host recycling
// its container. Without a handler it dies mid-job while still holding that
// job's Redis lock, and BullMQ cannot tell an abandoned job from a slow one: it
// waits out `lockDuration` (30s by default), the stalled checker returns the
// job to `wait`, and the job runs again from the top.
//
// That replay is no longer unsafe: PR-9G added a unique constraint on
// (emailId, userId) and made `createExtraction` an upsert, so a re-run rewrites
// the one extraction row instead of appending a duplicate. It is still not
// free. The job redoes the entire extraction — including the paid AI call when
// `USE_AI=true` — and because `maxStalledCount` defaults to 1, a job
// interrupted twice is failed permanently and silently. Deploying is itself the
// event that triggers this, which is why it is worth closing before the worker
// first runs in production.
//
// `close()` and never `close(true)`. The forced variant abandons the running
// job, which is the precise outcome this exists to prevent; it would satisfy
// "the worker shuts down" while making the failure mode worse.
let shuttingDown: Promise<void> | null = null;

const shutdown = (reason: string): Promise<void> => {
  // A host may send SIGTERM and then be interrupted, or a terminal may send
  // SIGINT while a SIGTERM drain is already running. Returning the in-flight
  // promise rather than starting a second one keeps two `close()` calls off the
  // same BullMQ internals; the state IS the promise, so there is no window
  // between checking and setting it.
  if (shuttingDown) {
    return shuttingDown;
  }

  shuttingDown = (async () => {
    console.log(`${reason}, shutting down worker...`);

    try {
      // Stops accepting new jobs, then waits for the active one to finish.
      await worker.close();

      // The worker's blocking connection is BullMQ's own duplicate and is
      // closed by `close()` above. This is the shared client the process itself
      // owns. A failed QUIT cannot endanger a job that has already drained, so
      // it must not turn a clean shutdown into a failed one.
      try {
        await redis.quit();
      } catch {
        // Already closed, or closing. Nothing left to do either way.
      }

      console.log("Worker shut down successfully");

      // Explicit, because natural termination would hang here. The `pg.Pool`
      // behind the Prisma client is created at module scope in `lib/prisma.ts`
      // and is not exported, so this process cannot end it without changing
      // that module's lifecycle — out of scope for this change. Its open
      // connections keep the event loop alive indefinitely.
      //
      // Safe at this point precisely because it is after the awaits: `close()`
      // has resolved, so the active job finished and every database write it
      // awaited has completed. Nothing is left in flight to cut short.
      process.exit(0);
    } catch (error) {
      console.error("Worker shutdown failed", error);

      process.exit(1);
    }
  })();

  return shuttingDown;
};

process.on("SIGTERM", () => {
  void shutdown("Received SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("Received SIGINT");
});

// DRAIN-AND-EXIT (PR-9K).
//
// The third way this process can stop, and the only one it chooses for itself.
// A scheduled runtime gives a job a wall-clock budget rather than a lifetime, so
// a worker that idles on an empty queue until it is killed spends that budget
// doing nothing. In batch mode the worker instead decides it is finished.
//
// WHY THE EVENT ALONE IS NOT ENOUGH.
//
// BullMQ emits `drained` when a fetch found nothing *immediately available* —
// it is a statement about the wait list, not about the queue. A job that fails
// with attempts remaining is moved to the DELAYED set by `moveToFailed`, and if
// nothing else is waiting the very next thing the worker does is emit `drained`.
// Exiting on the event by itself would therefore abandon a pending retry, which
// is the precise failure this mode must not introduce.
//
// So the event is the trigger and `getJobCounts` is the decision. One Redis
// round trip — `getCounts` is a single Lua script — asked only at the moment
// there is something worth asking about, which is why this needs no polling
// timer.
//
// The six types are named explicitly. `getJobCounts()` with no arguments returns
// every type including `completed` and `failed`, and with `removeOnFail: false`
// the failed set is permanent: counting it would mean the queue is never drained
// and this process never exits.
//
// `active` is counted even though this worker runs at concurrency 1 and cannot
// be holding a job when `drained` fires. It guards the OTHER case: a previous
// run killed without draining leaves its job in `active` with an expired lock
// until the stalled checker returns it to `wait`, and a check that ignored
// `active` would exit and orphan it until the next scheduled run.
//
// A job arriving between the counts coming back zero and the close completing
// is not handled, because it cannot be: the API service is a live producer and
// no lock closes that window without making this a permanent worker again. It
// costs nothing — the job is durable in Redis and the producer's deterministic
// jobId keeps it from being enqueued twice — so it is simply picked up by the
// next run.
const onDrained = async (): Promise<void> => {
  if (!exitWhenDrained) {
    return;
  }

  try {
    const counts = await emailQueue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "paused",
      "prioritized",
      "waiting-children",
    );

    const remaining = Object.values(counts).reduce(
      (total, count) => total + count,
      0,
    );

    if (remaining > 0) {
      // Work is still outstanding — a retry waiting out its backoff, or a job
      // recovered from a previous run. Nothing to do: fetching any job clears
      // BullMQ's internal `drained` flag, so the next true drain emits again
      // and this runs once more.
      return;
    }

    await shutdown("Queue email-processing drained");
  } catch (error) {
    // Redis refused the count. Crashing here would kill the process outside the
    // graceful path, abandoning any job the worker still holds — strictly worse
    // than staying up and letting the runtime's own timeout bound the run.
    console.error("Drain check failed", error);
  }
};

worker.on("drained", () => {
  void onDrained();
});
