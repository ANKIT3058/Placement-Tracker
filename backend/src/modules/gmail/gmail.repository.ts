import { prisma } from "../../lib/prisma.js";

export const createGmailAccount = async (
  email: string,
  refreshToken: string,
) => {
  return prisma.gmailAccount.upsert({
    where: {
      email,
    },
    update: {
      refreshToken,
    },
    create: {
      email,
      refreshToken,
    },
  });
};

export const getGmailAccount = async (email: string) => {
  return prisma.gmailAccount.findUnique({
    where: {
      email,
    },
  });
};

// Single-account model for now: pick whichever account is connected.
export const getFirstGmailAccount = async () => {
  return prisma.gmailAccount.findFirst();
};

export const getLatestConnectedGmailAccount = async () => {
  return prisma.gmailAccount.findFirst({
    orderBy: {
      connectedAt: "desc",
    },
  });
};

export const updateHistoryId = async (email: string, historyId: string) => {
  return prisma.gmailAccount.update({
    where: {
      email,
    },
    data: {
      historyId,
    },
  });
};
