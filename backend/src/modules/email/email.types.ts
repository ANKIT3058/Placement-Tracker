import type { AttachmentMetadata } from "../attachment/attachment.types.js";

export interface EmailInput {
  gmailMessageId?: string | null;
  gmailAccountId?: number | null;
  // Owner, copied from the mailbox that produced this observation. Nullable
  // while ownership is nullable; an Email ingested from an unlinked mailbox has
  // no owner rather than a guessed one.
  userId?: number | null;
  subject: string;
  body: string;
  sender: string;
  attachments?: AttachmentMetadata[];
}

// Queue payloads are NOT an authenticated channel: anything with Redis access
// can enqueue one, so `userId` here is a hint, never a claim. The worker
// re-derives the owner from the persisted Email and refuses the job if the two
// disagree (RFC-001 §9.5). The field is carried anyway so that disagreement is
// detectable at all.
export type EmailJobData = {
  emailId: number;
  userId?: number | null;
};
