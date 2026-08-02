import { prisma } from "../../lib/prisma.js";
import type { EmailInput } from "./email.types.js";

export const createEmail = async (email: EmailInput) => {
  const attachments = email.attachments ?? [];

  // Nested create runs the Email insert and all Attachment inserts inside a
  // single implicit Prisma transaction — either the email and its attachment
  // metadata all persist, or none do. Duplicate emails are guarded upstream in
  // the sync flow (existing gmailMessageId short-circuits before create), so
  // attachment metadata is never inserted twice.
  // Ownership is copied onto the Attachment rows as well as the Email. They
  // must agree: AC-5.11 attaches a composite foreign key to Email(id, userId)
  // that makes disagreement unrepresentable (RFC-001 §12.3), and writing them
  // together now means that migration has nothing to reconcile.
  const userId = email.userId ?? null;

  return prisma.email.create({
    data: {
      gmailMessageId: email.gmailMessageId,
      gmailAccountId: email.gmailAccountId,
      userId,
      subject: email.subject,
      body: email.body,
      sender: email.sender,
      attachments: attachments.length
        ? {
            create: attachments.map((attachment) => ({
              gmailAttachmentId: attachment.gmailAttachmentId,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              size: attachment.size,
              userId,
            })),
          }
        : undefined,
    },
  });
};

export const getEmailByGmailMessageId = async (gmailMessageId: string) => {
  return prisma.email.findUnique({
    where: {
      gmailMessageId,
    },
  });
};

export const getEmailById = async (id: number) => {
  return prisma.email.findUnique({
    where: {
      id,
    },
  });
};

export const updateEmailStatus = async (id: number, status: string) => {
  return prisma.email.update({
    where: {
      id,
    },

    data: {
      processingStatus: status,
    },
  });
};

export const markEmailFailed = async (id: number, reason: string) => {
  return prisma.email.update({
    where: {
      id,
    },

    data: {
      processingStatus: "failed",
      failureReason: reason,
    },
  });
};

export const getFailedEmails = async () => {
  return prisma.email.findMany({
    where: {
      processingStatus: "failed",
    },
  });
};

export const getPendingEmails = async () => {
  return prisma.email.findMany({
    where: {
      processingStatus: "pending",
    },
  });
};
