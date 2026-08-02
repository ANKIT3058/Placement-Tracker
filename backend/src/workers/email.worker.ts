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
