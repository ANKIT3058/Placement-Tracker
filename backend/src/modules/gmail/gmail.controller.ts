import { Request, Response } from "express";
import {
  generateAuthUrl,
  getTokens,
  getGmailAddress,
  getRecentMessages,
} from "./gmail.service.js";
import { createGmailAccount, getGmailAccount } from "./gmail.repository.js";
import { syncSingleMessage } from "./gmail.sync.service.js";

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

export const gmailSyncController = async (req: Request, res: Response) => {
  const account = await getGmailAccount("ankitanand3058@gmail.com");

  if (!account) {
    return res.status(404).json({
      success: false,
    });
  }

  const messages = await getRecentMessages(account.refreshToken);

  let processed = 0;
  let duplicates = 0;
  let queued = 0;
  let failed = 0;

  for (const message of messages) {
    try {
      if (!message.id) {
        continue;
      }

      const result = await syncSingleMessage(account.refreshToken, message.id);

      if (result.status === "duplicate") {
        duplicates += 1;
      } else {
        processed += 1;
        queued += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(`Failed to sync message ${message.id}`, error);
    }
  }

  return res.json({
    success: true,
    totalFetched: messages.length,
    processed,
    duplicates,
    queued,
    failed,
  });
};
