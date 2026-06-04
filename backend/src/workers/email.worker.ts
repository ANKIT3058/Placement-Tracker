import "dotenv/config";
import { Worker } from "bullmq";
import { redis } from "../infrastructure/redis/redis.js";
import { QUEUE_NAMES } from "../shared/constants/queue.constants.js";
import { processEmailJob } from "../modules/email/email.processor.js";
import { getEmailById } from "../modules/email/email.repository.js";
import type { EmailJobData } from "../modules/email/email.types.js";
import { Prisma } from "../../generated/prisma/client.js";

const worker = new Worker(
  QUEUE_NAMES.EMAIL_PROCESSING,
  async (job) => {
    const { emailId } = job.data as EmailJobData;

    const email = await getEmailById(emailId);

    if (!email) {
      throw new Error("Email not found");
    }

    console.log({
      jobId: job.id,
      queue: job.queueName,
      emailSubject: email.subject,
      attempts: job.attemptsMade,
    });
    try {
      await processEmailJob(emailId);
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
