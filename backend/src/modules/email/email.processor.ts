import { processEmail } from "./email.service.js";
import { getEmailById, updateEmailStatus, markEmailFailed } from "./email.repository.js";
import { EMAIL_STATUS } from "../../shared/constants/email.constants.js";
import { enqueueAttachmentJobs } from "../attachment/attachment.service.js";
import type { OwnershipContext } from "../auth/tenant-context.js";

// `owner` is derived by the worker from the persisted Email and passed down
// explicitly. It is not re-derived here: one derivation, one place, so there is
// exactly one answer to "who owns this work" per job (RFC-001 §9.5).
export const processEmailJob = async (
  owner: OwnershipContext,
  emailId: number,
) => {
  const email = await getEmailById(emailId);

  if (!email) {
    throw new Error("Email not found");
  }

  await updateEmailStatus(emailId, EMAIL_STATUS.PROCESSING);

  try {
    await processEmail(owner, email, emailId);

    await updateEmailStatus(emailId, EMAIL_STATUS.COMPLETED);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    await markEmailFailed(emailId, message);

    throw error;
  }

  // Fan out attachment processing to the dedicated queue only AFTER the email
  // has been processed successfully. If extraction/matching throws above we
  // return early via the rethrow and never reach here, so a failed email never
  // starts attachment processing. The enqueue is idempotent (deterministic
  // jobIds + "not completed" filter), so an email-job retry that re-runs this
  // line never duplicates jobs.
  await enqueueAttachmentJobs(emailId);
};
