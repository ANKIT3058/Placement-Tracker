import type { AttachmentMetadata } from "../attachment/attachment.types.js";

export interface EmailInput {
  gmailMessageId?: string | null;
  gmailAccountId?: number | null;
  subject: string;
  body: string;
  sender: string;
  attachments?: AttachmentMetadata[];
}

export type EmailJobData = {
  emailId: number;
};
