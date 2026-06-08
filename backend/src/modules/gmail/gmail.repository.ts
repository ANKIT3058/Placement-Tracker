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
