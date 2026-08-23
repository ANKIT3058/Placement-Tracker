import {
  getMessageDetails,
  parseMessage,
  getLatestHistoryId,
  getRecentMessages,
  getHistoryChanges,
} from "./gmail.service.js";
import {
  createEmail,
  getEmailByGmailMessageId,
} from "../email/email.repository.js";
import { enqueueEmailProcessing } from "../email/email.producer.js";
import {
  updateHistoryId,
  getGmailAccountsByUser,
  setGmailAccountReauthRequired,
} from "./gmail.repository.js";
import type { TenantContext } from "../auth/tenant-context.js";
import {
  describeGmailError,
  isPermanentGmailAuthFailure,
} from "./gmail.errors.js";

export type SyncMessageResult =
  | { status: "duplicate"; emailId: number }
  | { status: "created"; emailId: number };

export const syncSingleMessage = async (
  account: SyncableAccount,
  gmailMessageId: string,
): Promise<SyncMessageResult> => {
  const details = await getMessageDetails(account.refreshToken, gmailMessageId);

  const parsed = parseMessage(details);

  if (parsed.messageId) {
    const existing = await getEmailByGmailMessageId(parsed.messageId);

    if (existing) {
      return { status: "duplicate", emailId: existing.id };
    }
  }

  // Record the originating Gmail account so the attachment worker can later
  // resolve the correct refreshToken via Attachment -> Email -> GmailAccount,
  // instead of guessing with getFirstGmailAccount().
  const savedEmail = await createEmail({
    gmailMessageId: parsed.messageId,
    gmailAccountId: account.id,
    // Ownership flows from the mailbox that produced the observation. A mailbox
    // that has not been linked to a User yet yields an unowned Email rather
    // than a guess.
    userId: account.userId,
    subject: parsed.subject ?? "",
    body: parsed.body || parsed.snippet || "",
    sender: parsed.sender ?? "",
    attachments: parsed.attachments,
  });

  await enqueueEmailProcessing({
    emailId: savedEmail.id,
    userId: savedEmail.userId,
  });

  return { status: "created", emailId: savedEmail.id };
};

export type SyncStats = {
  processed: number;
  duplicates: number;
  queued: number;
  failed: number;
};

export type SyncAccountResult = {
  mode: "full" | "incremental";
  totalFetched: number;
  stats: SyncStats;
  latestHistoryId: string;
};

// Minimal shape required to sync an account, so callers (controller and
// scheduler) can pass a Prisma GmailAccount without coupling to its full type.
export type SyncableAccount = {
  id: number;
  email: string;
  refreshToken: string;
  historyId: string | null;
  // Owner of the mailbox, propagated onto every Email it produces. Required as
  // of AC-5.9 — every mailbox has an owner.
  userId: number;
  // Set when Google last refused this mailbox permanently (PR-8F). Read only to
  // avoid a redundant write when clearing it after a successful sync; optional
  // so callers constructing a minimal account shape stay valid.
  reauthRequiredAt?: Date | null;
};

const isHistoryIdExpired = (error: unknown): boolean => {
  const candidate = error as {
    code?: number;
    status?: number;
    response?: { status?: number };
  };

  return (
    candidate?.code === 404 ||
    candidate?.status === 404 ||
    candidate?.response?.status === 404
  );
};

const processMessages = async (
  account: SyncableAccount,
  messageIds: string[],
): Promise<SyncStats> => {
  let processed = 0;
  let duplicates = 0;
  let queued = 0;
  let failed = 0;

  for (const messageId of messageIds) {
    try {
      const result = await syncSingleMessage(account, messageId);

      if (result.status === "duplicate") {
        duplicates += 1;
      } else {
        processed += 1;
        queued += 1;
      }
    } catch (error) {
      failed += 1;
      // Safe diagnostics only: a Gmail refresh failure arrives here as a
      // GaxiosError carrying the mailbox's credentials in its request config,
      // and logging the raw error would print them (RFC-001 §13.2).
      console.error(
        `Failed to sync message ${messageId}`,
        describeGmailError(error),
      );
    }
  }

  return { processed, duplicates, queued, failed };
};

// Per-account incremental sync flow. Extracted from gmailSyncController so the
// background scheduler can reuse the exact same logic without duplication.
export const syncGmailAccount = async (
  account: SyncableAccount,
): Promise<SyncAccountResult> => {
  const refreshToken = account.refreshToken;

  // Capture the watermark BEFORE listing so messages arriving mid-sync are
  // picked up by the next incremental run (overlap is safe, gaps are not).
  const runFullSync = async (): Promise<SyncAccountResult> => {
    const latestHistoryId = await getLatestHistoryId(refreshToken);

    const messages = await getRecentMessages(refreshToken);

    const messageIds = messages
      .map((message) => message.id)
      .filter((id): id is string => Boolean(id));

    const stats = await processMessages(account, messageIds);

    return {
      mode: "full",
      totalFetched: messages.length,
      stats,
      latestHistoryId,
    };
  };

  const runSync = async (): Promise<SyncAccountResult> => {
    if (!account.historyId) {
      return runFullSync();
    }

    try {
      const { messageIds, latestHistoryId } = await getHistoryChanges(
        refreshToken,
        account.historyId,
      );

      const stats = await processMessages(account, messageIds);

      return {
        mode: "incremental",
        totalFetched: messageIds.length,
        stats,
        latestHistoryId,
      };
    } catch (error) {
      if (!isHistoryIdExpired(error)) {
        throw error;
      }

      console.warn(
        `History ID ${account.historyId} expired, falling back to full sync`,
      );

      return runFullSync();
    }
  };

  let result: SyncAccountResult;

  // The one place that knows BOTH which mailbox failed and why, which is why
  // the transition lives here rather than in either caller. Both the scheduler
  // and an explicit user sync reach this, so neither can drift from the other.
  try {
    result = await runSync();
  } catch (error) {
    if (isPermanentGmailAuthFailure(error)) {
      // Google will not accept this refresh token again, so record that and let
      // the automatic scheduler skip the mailbox until the user reconnects. The
      // token itself is left in place: Google has already invalidated it, so
      // deleting it protects nothing and only makes reconnect harder to reason
      // about (PR-8F).
      await setGmailAccountReauthRequired(account.email, new Date());
    }

    // Rethrown unchanged. Callers still count the failure, still log it through
    // the safe formatter, and still move on to the next mailbox.
    throw error;
  }

  await updateHistoryId(account.email, result.latestHistoryId);

  // Reaching here means the mailbox authenticated and completed a sync, so a
  // previous permanent failure is over. Written only when the flag was actually
  // set, to keep the ordinary success path at one write.
  if (account.reauthRequiredAt) {
    await setGmailAccountReauthRequired(account.email, null);
  }

  return result;
};

export type MailboxSyncOutcome =
  | { email: string; status: "synced"; result: SyncAccountResult }
  | { email: string; status: "failed"; error: string };

export type UserSyncResult = {
  mailboxes: MailboxSyncOutcome[];
  synced: number;
  failed: number;
};

// Synchronize every mailbox owned by the caller — RFC-001 §10's `Synchronize(userId)`.
//
// The service resolves the mailboxes itself rather than accepting them from the
// controller. That is the point of the change: a caller cannot pass in the wrong
// mailbox, because a caller does not choose the mailbox at all. It is derived
// from the tenant, and the tenant is derived from the session.
//
// Zero mailboxes is a normal outcome, not an error. A User may own none — that
// is the state of every User between authenticating and connecting a mailbox
// (RFC-001 §6.2 P2).
//
// Each mailbox is synchronized independently and sequentially, preserving the
// existing per-account semantics exactly: its own `historyId` cursor, its own
// full-versus-incremental decision, its own expired-cursor fallback. One
// mailbox's failure is captured and reported, never allowed to abort the
// mailboxes behind it — the same guarantee the background scheduler already
// provides (RFC-001 §14.2 S2).
export const syncUserMailboxes = async (
  context: TenantContext,
): Promise<UserSyncResult> => {
  const accounts = await getGmailAccountsByUser(context);

  const mailboxes: MailboxSyncOutcome[] = [];

  let synced = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      const result = await syncGmailAccount(account);

      synced += 1;

      mailboxes.push({ email: account.email, status: "synced", result });
    } catch (error) {
      failed += 1;

      const message = error instanceof Error ? error.message : "Unknown error";

      // The raw error is never logged — see `describeGmailError`. The mailbox,
      // the user and Google's own reason survive, which is what makes a
      // revoked mailbox diagnosable without disclosing its refresh token.
      console.error(
        `[gmail-sync] Failed to sync mailbox ${account.email} for user ${context.userId}`,
        describeGmailError(error),
      );

      mailboxes.push({ email: account.email, status: "failed", error: message });
    }
  }

  return { mailboxes, synced, failed };
};
