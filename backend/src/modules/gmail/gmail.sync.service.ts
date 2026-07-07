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
import { updateHistoryId } from "./gmail.repository.js";

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
    subject: parsed.subject ?? "",
    body: parsed.body || parsed.snippet || "",
    sender: parsed.sender ?? "",
    attachments: parsed.attachments,
  });

  await enqueueEmailProcessing(savedEmail.id);

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
      console.error(`Failed to sync message ${messageId}`, error);
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

  let result: SyncAccountResult;

  if (!account.historyId) {
    result = await runFullSync();
  } else {
    try {
      const { messageIds, latestHistoryId } = await getHistoryChanges(
        refreshToken,
        account.historyId,
      );

      const stats = await processMessages(account, messageIds);

      result = {
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

      result = await runFullSync();
    }
  }

  await updateHistoryId(account.email, result.latestHistoryId);

  return result;
};
