import "dotenv/config";
import { Worker } from "bullmq";
import { redis } from "../../infrastructure/redis/redis.js";
import { QUEUE_NAMES } from "../../shared/constants/queue.constants.js";
import { documentProcessingService } from "./document-processing.service.js";
import type { AttachmentJobData } from "./attachment.types.js";
import { describeGmailError } from "../gmail/gmail.errors.js";
// The queue handle the drain check interrogates. The worker consumes jobs; it
// cannot ask how many are left without a Queue, which is why this import exists
// and why it appears only now (G-7.2). Nothing here enqueues.
import { attachmentQueue } from "./attachment.queue.js";

// BATCH MODE (G-7.2), the same flag and the same convention as the email
// worker.
//
// Off by default, and off for anything other than the exact string "true", so a
// missing, empty or mistyped value leaves this process a permanent worker. Read
// once here rather than at each drain: the mode is a property of the run, and
// re-reading it would let a mutated environment change the process's lifecycle
// halfway through.
const exitWhenDrained = process.env.WORKER_EXIT_WHEN_DRAINED === "true";

// Standalone worker process (run via `npm run worker:attachment`), mirroring
// the email worker. It downloads, stores, parses, and — when `USE_AI=true` —
// runs Document Intelligence; it still mutates no Event, which is the remaining
// half of G-6. Failures rethrow so BullMQ applies the queue's retry backoff,
// making processing retryable.
//
// IMPLEMENTED, NOT CURRENTLY EXECUTED IN PRODUCTION. No production runtime
// starts this process: the API service runs no worker, and the only production
// worker is a manually dispatched drain of `email-processing`. Attachment jobs
// are still enqueued, so they accumulate with no consumer — assume this code
// has never run against production data. Giving it a runtime is G-7.4; this
// file only makes it safe to stop once it has one.
const worker = new Worker<AttachmentJobData>(
  QUEUE_NAMES.ATTACHMENT_PROCESSING,
  async (job) => {
    const { attachmentId } = job.data;

    console.log({
      jobId: job.id,
      queue: job.queueName,
      attachmentId,
      attempts: job.attemptsMade,
    });

    await documentProcessingService.process(attachmentId);
  },
  {
    connection: redis,
  },
);

worker.on("completed", (job) => {
  console.log(`Attachment job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  // Attachment downloads call Gmail, so this handler can receive a
  // credential-bearing GaxiosError. Reduced to safe diagnostics for the same
  // reason the sync paths are (RFC-001 §13.2).
  console.error(`Attachment job ${job?.id} failed`, describeGmailError(err));
});

// GRACEFUL SHUTDOWN (G-7.2).
//
// This process is stopped by a signal — a deploy, a restart, a host recycling
// its container. Without a handler it dies mid-job while still holding that
// job's Redis lock, and BullMQ cannot tell an abandoned job from a slow one: it
// waits out `lockDuration` (30s by default), the stalled checker returns the
// job to `wait`, and the job runs again from the top.
//
// G-7.1 made that replay CORRECT — `isSettled` resumes from durable state
// instead of skipping a half-finished pipeline — but correct is not the same as
// free, and for this pipeline the replay is expensive in a way the email
// worker's is not:
//
//   - it re-downloads the file from Gmail, spending quota on bytes already had;
//   - a stop between `storage.store()` and `markAttachmentCompleted` leaves an
//     orphaned file on disk, since the replay stores under a fresh UUID key;
//   - with `USE_AI=true` it repeats a paid provider call;
//   - and parsing is the long pole of the job, so the interrupted work is
//     usually the most expensive part of it.
//
// The decisive cost is the last one. `maxStalledCount` defaults to 1, so a job
// interrupted TWICE is failed permanently with "job stalled more than allowable
// limit"; `removeOnFail: false` then keeps the deterministic jobId occupied, so
// nothing can re-enqueue that attachment and no reconciler exists to notice.
// Deploying is itself the event that triggers this.
//
// `close()` and never `close(true)`. The forced variant abandons the running
// job, which is the precise outcome this exists to prevent; it would satisfy
// "the worker shuts down" while making the failure mode worse.
let shuttingDown: Promise<void> | null = null;

const shutdown = (reason: string): Promise<void> => {
  // A host may send SIGTERM and then be interrupted, or a terminal may send
  // SIGINT while a SIGTERM drain is already running, or the drain check may
  // decide to exit at the moment a signal arrives. Returning the in-flight
  // promise rather than starting a second one keeps two `close()` calls off the
  // same BullMQ internals; the state IS the promise, so there is no window
  // between checking and setting it.
  if (shuttingDown) {
    return shuttingDown;
  }

  shuttingDown = (async () => {
    console.log(`${reason}, shutting down attachment worker...`);

    try {
      // Stops accepting new jobs, then waits for the active one to finish.
      await worker.close();

      // The worker's blocking connection is BullMQ's own duplicate and is
      // closed by `close()` above. This is the shared client the process itself
      // owns — the same one `attachmentQueue` was built on, which is why it is
      // quit only after the close has resolved. A failed QUIT cannot endanger a
      // job that has already drained, so it must not turn a clean shutdown into
      // a failed one.
      try {
        await redis.quit();
      } catch {
        // Already closed, or closing. Nothing left to do either way.
      }

      console.log("Attachment worker shut down successfully");

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
      console.error("Attachment worker shutdown failed", {
        reason: error instanceof Error ? error.message : String(error),
      });

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

// DRAIN-AND-EXIT (G-7.2).
//
// The third way this process can stop, and the only one it chooses for itself.
// A scheduled runtime gives a job a wall-clock budget rather than a lifetime, so
// a worker that idles on an empty queue until it is killed spends that budget
// doing nothing — and is then killed OUTSIDE the graceful path above, which is
// the very failure this file exists to close.
//
// WHY THE EVENT ALONE IS NOT ENOUGH.
//
// BullMQ emits `drained` when a fetch found nothing *immediately available* —
// it is a statement about the wait list, not about the queue. A job that fails
// with attempts remaining is moved to the DELAYED set by `moveToFailed`, and if
// nothing else is waiting the very next thing the worker does is emit `drained`.
// Exiting on the event by itself would therefore abandon a pending retry, which
// is the precise failure this mode must not introduce. Attachment jobs carry
// `attempts: 3`, so a delayed retry is an ordinary state here, not an edge case.
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
// `active` would exit and orphan it until the next run.
//
// ON `getJobCounts` NOT BEING A PURE READ, which is worth stating because it
// looks like one. Its Lua script (`getCounts-1.lua`) special-cases `wait` and
// `paused`: if the LAST element of the list is a legacy marker — a value
// prefixed "0:", from the pre-v5 scheme where markers lived in the wait list —
// and the list holds more than that one element, the script RPOPs the marker and
// returns the count without it. That is a mutation, so it is not ignored here:
//
//   - It can never remove a real job. The RPOP is gated on the "0:" prefix, the
//     whole script is one atomic Redis Lua call so the element inspected is the
//     element popped, and this queue's ids are `attachment-<n>` by construction.
//   - It cannot fire against this repository's data at all. BullMQ 5 writes
//     markers with `ZADD <prefix>:marker` and the worker blocks on that separate
//     key (`bzpopmin(keys.marker)`); nothing puts a marker in the wait list. This
//     project has only ever depended on bullmq ^5, so no legacy marker exists to
//     pop.
//   - There is no read-only alternative in the public API. Every count getter —
//     `getWaitingCount`, `getActiveCount`, `getDelayedCount` and the rest —
//     funnels through `getJobCountByTypes` into this same script, so six
//     individual calls would run it six times instead of once. Reading the keys
//     directly with LLEN/ZCARD would be read-only but would reimplement BullMQ's
//     private key layout AND would count a stale marker as a job, which would
//     keep this worker alive forever on an empty queue — strictly worse than the
//     behaviour being avoided.
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
    const counts = await attachmentQueue.getJobCounts(
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

    await shutdown("Queue attachment-processing drained");
  } catch (error) {
    // Redis refused the count. Crashing here would kill the process outside the
    // graceful path, abandoning any job the worker still holds — strictly worse
    // than staying up and letting the runtime's own timeout bound the run.
    console.error("Drain check failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
};

worker.on("drained", () => {
  void onDrained();
});
