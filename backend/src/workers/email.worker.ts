import "dotenv/config";
import { Worker, UnrecoverableError } from "bullmq";
import { redis } from "../infrastructure/redis/redis.js";
import { QUEUE_NAMES } from "../shared/constants/queue.constants.js";
import { processEmailJob } from "../modules/email/email.processor.js";
import { getEmailById } from "../modules/email/email.repository.js";
import type { EmailJobData } from "../modules/email/email.types.js";
import type { OwnershipContext } from "../modules/auth/tenant-context.js";
import { Prisma } from "../../generated/prisma/client.js";

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
// That replay is not free. `createExtraction` has no unique constraint, so every
// interrupted job costs a duplicate EmailExtraction row — and because
// `maxStalledCount` defaults to 1, a job interrupted twice is failed
// permanently and silently. Deploying is itself the event that triggers this,
// which is why it is worth closing before the worker first runs in production.
//
// `close()` and never `close(true)`. The forced variant abandons the running
// job, which is the precise outcome this exists to prevent; it would satisfy
// "the worker shuts down" while making the failure mode worse.
let shuttingDown: Promise<void> | null = null;

const shutdown = (signal: NodeJS.Signals): Promise<void> => {
  // A host may send SIGTERM and then be interrupted, or a terminal may send
  // SIGINT while a SIGTERM drain is already running. Returning the in-flight
  // promise rather than starting a second one keeps two `close()` calls off the
  // same BullMQ internals; the state IS the promise, so there is no window
  // between checking and setting it.
  if (shuttingDown) {
    return shuttingDown;
  }

  shuttingDown = (async () => {
    console.log(`Received ${signal}, shutting down worker...`);

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
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
