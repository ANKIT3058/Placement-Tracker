import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAttachmentData } from "../gmail/gmail.service.js";
import { enqueueAttachmentProcessing } from "./attachment.queue.js";
import { storageService } from "./storage/local-storage.service.js";
import {
  getAttachmentById,
  getPendingAttachmentsByEmailId,
  markAttachmentCompleted,
  markAttachmentProcessing,
  markAttachmentFailed,
} from "./attachment.repository.js";
import { ATTACHMENT_STATUS } from "./attachment.types.js";

// Enqueue a processing job for every not-yet-completed attachment on an email.
// Called from the email worker AFTER the email has been processed successfully;
// processing is fully decoupled from AI extraction and event matching.
export const enqueueAttachmentJobs = async (emailId: number) => {
  const attachments = await getPendingAttachmentsByEmailId(emailId);

  for (const attachment of attachments) {
    await enqueueAttachmentProcessing(attachment.id);
  }

  return attachments.length;
};

// Build an opaque, collision-free storage key. A random UUID (not the
// attachment id or original filename) keeps the on-disk path free of any
// user-controlled data; the original filename is preserved separately in the
// database. The extension is retained so the stored file stays recognizable to
// later parsing sprints.
const buildStorageKey = (filename: string): string => {
  const ext = path.extname(path.basename(filename)).toLowerCase();
  return `${randomUUID()}${ext}`;
};

// Single-job orchestration: download bytes from Gmail and persist them via the
// storage abstraction, then record the result. Downloading is the ONLY
// responsibility today — PDF/Excel parsing, AI and event mutation arrive in
// later sprints.
export const processAttachmentJob = async (attachmentId: number) => {
  const attachment = await getAttachmentById(attachmentId);

  if (!attachment) {
    throw new Error(`Attachment ${attachmentId} not found`);
  }

  // Idempotent: a retried/duplicated job for an already-completed file is a
  // no-op.
  if (attachment.processingStatus === ATTACHMENT_STATUS.COMPLETED) {
    return;
  }

  const messageId = attachment.email.gmailMessageId;

  if (!messageId) {
    // Without the originating Gmail message id there is nothing to fetch; this
    // is not retryable, so fail permanently rather than throwing forever.
    await markAttachmentFailed(
      attachmentId,
      "Originating email has no gmailMessageId",
    );
    return;
  }

  // Resolve the account that synced this email (Attachment -> Email ->
  // GmailAccount). No guessing with getFirstGmailAccount(); the refreshToken
  // comes from the exact account that owns the message.
  const account = attachment.email.gmailAccount;

  if (!account) {
    // The email predates account tracking (or the account was disconnected);
    // not retryable.
    await markAttachmentFailed(
      attachmentId,
      "Originating email has no associated Gmail account",
    );
    return;
  }

  await markAttachmentProcessing(attachmentId);

  try {
    const data = await getAttachmentData(
      account.refreshToken,
      messageId,
      attachment.gmailAttachmentId,
    );

    const key = buildStorageKey(attachment.filename);
    const storagePath = await storageService.store(key, data);

    await markAttachmentCompleted(attachmentId, storagePath, new Date());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    await markAttachmentFailed(attachmentId, message);

    // Rethrow so BullMQ records the failure and retries per the queue's
    // backoff policy.
    throw error;
  }
};
