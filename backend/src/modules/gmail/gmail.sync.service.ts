import { getMessageDetails, parseMessage } from "./gmail.service.js";
import {
  createEmail,
  getEmailByGmailMessageId,
} from "../email/email.repository.js";
import { enqueueEmailProcessing } from "../email/email.producer.js";

export type SyncMessageResult =
  | { status: "duplicate"; emailId: number }
  | { status: "created"; emailId: number };

export const syncSingleMessage = async (
  refreshToken: string,
  gmailMessageId: string,
): Promise<SyncMessageResult> => {
  const details = await getMessageDetails(refreshToken, gmailMessageId);

  const parsed = parseMessage(details);

  if (parsed.messageId) {
    const existing = await getEmailByGmailMessageId(parsed.messageId);

    if (existing) {
      return { status: "duplicate", emailId: existing.id };
    }
  }

  const savedEmail = await createEmail({
    gmailMessageId: parsed.messageId,
    subject: parsed.subject ?? "",
    body: parsed.body || parsed.snippet || "",
    sender: parsed.sender ?? "",
  });

  await enqueueEmailProcessing(savedEmail.id);

  return { status: "created", emailId: savedEmail.id };
};
