import { prisma } from "../../lib/prisma.js";
import type { EmailInput } from "./email.types.js";

export const createEmail = async (email: EmailInput) => {
  return prisma.email.create({
    data: {
      subject: email.subject,
      body: email.body,
      sender: email.sender,
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
