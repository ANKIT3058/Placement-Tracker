import "dotenv/config";
import { Worker } from "bullmq";
import { redis } from "../../infrastructure/redis/redis.js";
import { QUEUE_NAMES } from "../../shared/constants/queue.constants.js";
import { documentProcessingService } from "./document-processing.service.js";
import type { AttachmentJobData } from "./attachment.types.js";
import { describeGmailError } from "../gmail/gmail.errors.js";

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
