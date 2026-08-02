import { prisma } from "../../lib/prisma.js";

// Connect a mailbox and attach it to the User who authorized it.
//
// Expressed as read-then-write rather than an upsert because the ownership rule
// is conditional and an upsert cannot express it: a mailbox already owned by a
// *different* User keeps its owner. Ownership is never transferred by a
// reconnect (RFC-001 §7.3) — the alternative silently moves the mailbox and its
// entire Email history to whoever connected most recently.
//
// The conflict is refused by omission here rather than by returning an error,
// which preserves the endpoint's current contract. The explicit
// `409 MAILBOX_ALREADY_LINKED` response belongs to AC-5.6, which owns the
// mailbox connection flow. In practice the case is unreachable today: a mailbox
// can only be authorized by the Google account that owns it, so the resolved
// User is the same one every time.
export const connectGmailAccount = async (
  email: string,
  refreshToken: string,
  userId: number,
) => {
  const existing = await prisma.gmailAccount.findUnique({
    where: {
      email,
    },
  });

  if (!existing) {
    return prisma.gmailAccount.create({
      data: {
        email,
        refreshToken,
        userId,
      },
    });
  }

  const isLinkable = existing.userId === null || existing.userId === userId;

  if (!isLinkable) {
    console.warn(
      `[gmail] Mailbox ${email} is owned by user ${existing.userId}; refusing to relink to user ${userId}`,
    );
  }

  return prisma.gmailAccount.update({
    where: {
      email,
    },
    data: {
      refreshToken,
      ...(isLinkable ? { userId } : {}),
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

// Used by the background scheduler to sync every connected account.
export const getAllGmailAccounts = async () => {
  return prisma.gmailAccount.findMany();
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
