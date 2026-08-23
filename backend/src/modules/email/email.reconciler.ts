import { getStalePendingEmails } from "./email.repository.js";
import { enqueueEmailProcessing } from "./email.producer.js";

/* Recovers Emails that were persisted but never handed to the queue (F-3e).
 *
 * Both ingestion paths — Gmail sync and the manual `POST /email` route — commit
 * the Email to Postgres and then enqueue to Redis. The two stores cannot share
 * a transaction, so a failed enqueue leaves a committed row with
 * `processingStatus: "pending"` and no job behind it. Nothing recovered that
 * state: the Gmail dedupe short-circuits every replay of the message, the sync
 * watermark has already advanced past it, and a manually ingested email has no
 * Gmail message to replay at all. The email was stored and never processed,
 * with nothing recording that anything had gone wrong.
 *
 * The recovery is deliberately dumb: read the rows, hand each back to the
 * normal producer. No queue introspection, no Gmail, no new state.
 *
 * SAFE TO RUN AGAINST A ROW THAT ALREADY HAS A JOB. This cannot see Redis, and
 * a row stays `pending` until a worker picks it up — so a row whose enqueue
 * actually succeeded is indistinguishable from an orphan here. That is fine,
 * and it is why `enqueueEmailProcessing` uses `jobId: email-${id}`: BullMQ
 * refuses a second `add` while a job with that id exists, so the duplicate
 * collapses into the job already queued. Checking Redis first would race the
 * exact window it was meant to close.
 */
export const reconcilePendingEmails = async ({
  olderThan,
}: {
  olderThan: Date;
}): Promise<{ enqueued: number }> => {
  // The cutoff is the caller's, never `Date.now()` here. How long to wait
  // before treating a pending row as abandoned is a deployment decision — long
  // enough to clear a normal queue backlog, short enough to matter — and this
  // function should not be the place that decides it.
  const orphans = await getStalePendingEmails(olderThan);

  let enqueued = 0;

  // Sequential, with a per-row catch, matching how every other background loop
  // in this codebase treats a batch: one row's failure never aborts the rest.
  for (const email of orphans) {
    try {
      // Through the normal producer, so job name, options and the deterministic
      // id stay defined in exactly one place. A second `queue.add` call here
      // would be free to drift from it.
      await enqueueEmailProcessing({
        emailId: email.id,
        // The row's own owner. Background work has no caller to derive a tenant
        // from, so ownership travels with the row — never a shared or invented
        // context.
        userId: email.userId,
      });

      enqueued += 1;
    } catch (error) {
      // Counted as failure, not success, and the row is left `pending` on
      // purpose: it stays eligible for the next pass. Marking it processed here
      // would erase the only evidence that the work is still owed.
      //
      // `processingStatus` is never written by this function at all. The worker
      // owns the pending → processing → completed/ignored/failed transitions,
      // and a second writer would make that lifecycle ambiguous.
      console.error(
        `[email-reconciler] Failed to enqueue email ${email.id}`,
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }

  return { enqueued };
};
