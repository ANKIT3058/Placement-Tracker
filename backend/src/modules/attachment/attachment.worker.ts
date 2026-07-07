import "dotenv/config";
import { Worker } from "bullmq";
import { redis } from "../../infrastructure/redis/redis.js";
import { QUEUE_NAMES } from "../../shared/constants/queue.constants.js";
import { processAttachmentJob } from "./attachment.service.js";
import type { AttachmentJobData } from "./attachment.types.js";

// Standalone worker process (run via `npm run worker:attachment`), mirroring
// the email worker. Today it ONLY downloads and stores files — no parsing, no
// AI, no event mutation — but the queue is named for the full processing
// pipeline it will grow into. Failures rethrow so BullMQ applies the queue's
// retry backoff, making processing retryable.
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

    await processAttachmentJob(attachmentId);
  },
  {
    connection: redis,
  },
);

worker.on("completed", (job) => {
  console.log(`Attachment job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`Attachment job ${job?.id} failed`, err);
});
