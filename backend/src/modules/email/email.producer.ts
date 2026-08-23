import { emailQueue } from "../../infrastructure/queue/queues.js";
import { JOB_NAMES } from "../../shared/constants/queue.constants.js";

import type { EmailJobData } from "./email.types.js";

export const enqueueEmailProcessing = async (data: EmailJobData) => {
  await emailQueue.add(
    JOB_NAMES.PROCESS_EMAIL,
    {
      emailId: data.emailId,
      // Carried for cross-checking only. The worker re-derives ownership from
      // the persisted Email and treats a disagreement as a hard failure; it
      // never authorizes anything from this value (RFC-001 §9.5).
      userId: data.userId ?? null,
    },
    {
      // Derived from the Email, not random, and that is a reliability contract
      // rather than a naming choice.
      //
      // An email is persisted before it is enqueued, and the two stores cannot
      // share a transaction — so a failed enqueue leaves a row that only the
      // reconciler can rescue. The reconciler must therefore be free to enqueue
      // an email that may ALREADY have a live job (it cannot see Redis, and the
      // worker may simply not have started yet). This id is what makes that
      // safe: BullMQ refuses a second `add` while a job with the same id
      // exists, so a racing duplicate collapses into the job already queued
      // instead of becoming a second one.
      //
      // No application-side "does a job exist?" check is needed or wanted —
      // that lookup would race the very window it was meant to close.
      jobId: `email-${data.emailId}`,

      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
};
