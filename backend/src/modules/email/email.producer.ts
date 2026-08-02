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
