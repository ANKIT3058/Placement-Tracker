import { prisma } from "../../lib/prisma.js";
import type {
  TenantContext,
  OwnershipContext,
} from "../auth/tenant-context.js";

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

// Currently uncalled. Resolving a mailbox by address is a legitimate operation,
// but only within an owner: the address is caller-supplied, and an unscoped
// lookup answers "does this person use this system, and with which mailbox" to
// anyone who can name an address.
export const getGmailAccount = async (
  owner: OwnershipContext,
  email: string,
) => {
  return prisma.gmailAccount.findFirst({
    where: {
      email,
      userId: owner.userId,
    },
  });
};

// Every mailbox owned by a User, oldest connection first so the order a caller
// observes is stable across requests (RFC-001 §14.1).
//
// This is the only mailbox resolver an authenticated flow may use. It answers
// "which mailboxes belong to this caller", which is a question about ownership;
// the resolvers below answer "which mailbox happens to be around", which is a
// question about global state and has no correct answer once more than one User
// exists.
//
// Deliberately not filtered on `syncStatus` yet, though RFC-001 §14.1 specifies
// that filter. The column defaults to `pending` and nothing transitions it to
// `active` until the mailbox lifecycle lands, so applying the filter now would
// resolve zero mailboxes for every caller. The filter belongs with the
// transitions that populate it.
export const getGmailAccountsByUser = async (context: TenantContext) => {
  return prisma.gmailAccount.findMany({
    where: {
      userId: context.userId,
    },
    orderBy: {
      connectedAt: "asc",
    },
  });
};

// Single-account model for now: pick whichever account is connected.
//
// DEAD as of AC-5.6 and retained only until AC-5.11 deletes it. Both of these
// resolve a mailbox from global state, which is the single-user assumption this
// RFC removes. Neither may be called from an authenticated flow — use
// `getGmailAccountsByUser`.
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

// Used by the background scheduler to sync every connected account.
//
// Still global, deliberately: the scheduler is background work with no caller to
// derive a tenant from, and scheduler changes are out of scope for AC-5.6. It
// remains correct for now because each account carries its own owner and its own
// cursor, so a per-account sync is already tenant-safe (RFC-001 §14.2 S2).
export const getAllGmailAccounts = async () => {
  return prisma.gmailAccount.findMany();
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
