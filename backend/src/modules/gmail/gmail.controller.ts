import { Request, Response } from "express";
import {
  generateAuthUrl,
  getTokens,
  getGmailAddress,
  getRecentMessages,
  getLatestHistoryId,
  getHistoryChanges,
} from "./gmail.service.js";
import {
  createGmailAccount,
  getFirstGmailAccount,
  updateHistoryId,
} from "./gmail.repository.js";
import { syncSingleMessage } from "./gmail.sync.service.js";
import { getLatestConnectedGmailAccount } from "./gmail.repository.js";

export const gmailAuthController = (req: Request, res: Response) => {
  const url = generateAuthUrl();

  return res.redirect(url);
};

export const gmailCallbackController = async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string;

    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Authorization code missing",
      });
    }

    const tokens = await getTokens(code);

    const email = await getGmailAddress(tokens);

    if (!tokens.refresh_token) {
      throw new Error("Refresh token not received");
    }

    if (!email) {
      throw new Error("Unable to retrieve Gmail address");
    }

    await createGmailAccount(email, tokens.refresh_token);

    return res.json({
      success: true,
      email,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Failed to exchange code",
    });
  }
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

const processMessages = async (refreshToken: string, messageIds: string[]) => {
  let processed = 0;
  let duplicates = 0;
  let queued = 0;
  let failed = 0;

  for (const messageId of messageIds) {
    try {
      const result = await syncSingleMessage(refreshToken, messageId);

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

export const gmailSyncController = async (req: Request, res: Response) => {
  const account = await getLatestConnectedGmailAccount();

  if (!account) {
    return res.status(404).json({
      success: false,
    });
  }

  const refreshToken = account.refreshToken;

  // Capture the watermark BEFORE listing so messages arriving mid-sync are
  // picked up by the next incremental run (overlap is safe, gaps are not).
  const runFullSync = async () => {
    const latestHistoryId = await getLatestHistoryId(refreshToken);

    const messages = await getRecentMessages(refreshToken);

    const messageIds = messages
      .map((message) => message.id)
      .filter((id): id is string => Boolean(id));

    const stats = await processMessages(refreshToken, messageIds);

    return {
      mode: "full" as const,
      totalFetched: messages.length,
      stats,
      latestHistoryId,
    };
  };

  let result: {
    mode: "full" | "incremental";
    totalFetched: number;
    stats: {
      processed: number;
      duplicates: number;
      queued: number;
      failed: number;
    };
    latestHistoryId: string;
  };

  if (!account.historyId) {
    result = await runFullSync();
  } else {
    try {
      const { messageIds, latestHistoryId } = await getHistoryChanges(
        refreshToken,
        account.historyId,
      );

      const stats = await processMessages(refreshToken, messageIds);

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

  console.log({
    mode: result.mode,
    totalFetched: result.totalFetched,
    processed: result.stats.processed,
    duplicates: result.stats.duplicates,
    queued: result.stats.queued,
    failed: result.stats.failed,
    latestHistoryId: result.latestHistoryId,
  });

  return res.json({
    success: true,
    mode: result.mode,
    totalFetched: result.totalFetched,
    processed: result.stats.processed,
    duplicates: result.stats.duplicates,
    queued: result.stats.queued,
    failed: result.stats.failed,
    latestHistoryId: result.latestHistoryId,
  });
};
