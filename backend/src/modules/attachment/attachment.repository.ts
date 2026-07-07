import { prisma } from "../../lib/prisma.js";
import { ATTACHMENT_STATUS } from "./attachment.types.js";

// Load an attachment with its originating email AND that email's Gmail account
// in a single query, so the worker can resolve the correct refreshToken via
// Attachment -> Email -> GmailAccount without extra round trips.
export const getAttachmentById = async (id: number) => {
  return prisma.attachment.findUnique({
    where: { id },
    include: { email: { include: { gmailAccount: true } } },
  });
};

// Attachments belonging to an email that have not been successfully processed
// yet. Used when enqueueing processing jobs so completed files are never
// re-fetched.
export const getPendingAttachmentsByEmailId = async (emailId: number) => {
  return prisma.attachment.findMany({
    where: {
      emailId,
      processingStatus: { not: ATTACHMENT_STATUS.COMPLETED },
    },
  });
};

export const markAttachmentProcessing = async (id: number) => {
  return prisma.attachment.update({
    where: { id },
    data: {
      processingStatus: ATTACHMENT_STATUS.PROCESSING,
      processingError: null,
    },
  });
};

export const markAttachmentCompleted = async (
  id: number,
  storagePath: string,
  processedAt: Date,
) => {
  return prisma.attachment.update({
    where: { id },
    data: {
      processingStatus: ATTACHMENT_STATUS.COMPLETED,
      storagePath,
      processedAt,
      processingError: null,
    },
  });
};

export const markAttachmentFailed = async (id: number, reason: string) => {
  return prisma.attachment.update({
    where: { id },
    data: {
      processingStatus: ATTACHMENT_STATUS.FAILED,
      processingError: reason,
    },
  });
};
