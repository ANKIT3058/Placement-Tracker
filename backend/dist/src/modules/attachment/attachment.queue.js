import { Queue } from "bullmq";
import { redis } from "../../infrastructure/redis/redis.js";
import { QUEUE_NAMES, JOB_NAMES, } from "../../shared/constants/queue.constants.js";
export const attachmentQueue = new Queue(QUEUE_NAMES.ATTACHMENT_PROCESSING, {
    connection: redis,
});
// Enqueue a processing job for a single attachment. A deterministic jobId makes
// the enqueue idempotent: if the upstream email job is retried by BullMQ, the
// same attachment is not queued twice while a job is still waiting/active.
export const enqueueAttachmentProcessing = async (attachmentId) => {
    await attachmentQueue.add(JOB_NAMES.PROCESS_ATTACHMENT, { attachmentId }, {
        jobId: `attachment-${attachmentId}`,
        attempts: 3,
        backoff: {
            type: "exponential",
            delay: 2000,
        },
        removeOnComplete: true,
        removeOnFail: false,
    });
};
//# sourceMappingURL=attachment.queue.js.map