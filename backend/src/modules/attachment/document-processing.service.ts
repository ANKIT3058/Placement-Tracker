import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAttachmentData } from "../gmail/gmail.service.js";
import { storageService } from "./storage/local-storage.service.js";
import type { StorageService } from "./storage/storage.interface.js";
import {
  parserRegistry,
  type ParserRegistry,
} from "./parsers/parser-registry.js";
import type { AttachmentParser } from "./parsers/attachment-parser.interface.js";
import type { ParsedAttachment } from "./parsers/parsed-attachment.types.js";
import {
  getAttachmentById,
  markAttachmentCompleted,
  markAttachmentProcessing,
  markAttachmentFailed,
} from "./attachment.repository.js";
import { ATTACHMENT_STATUS } from "./attachment.types.js";

// An attachment loaded with its email + Gmail account (see getAttachmentById).
type LoadedAttachment = NonNullable<
  Awaited<ReturnType<typeof getAttachmentById>>
>;

// Build an opaque, collision-free storage key. A random UUID (not the
// attachment id or original filename) keeps the on-disk path free of any
// user-controlled data; the original filename is preserved separately in the
// database. The extension is retained so the stored file stays recognizable to
// later parsing sprints.
const buildStorageKey = (filename: string): string => {
  const ext = path.extname(path.basename(filename)).toLowerCase();
  return `${randomUUID()}${ext}`;
};

// Owns the end-to-end processing of a single attachment/document. The attachment
// worker only orchestrates BullMQ jobs and delegates the actual work here.
//
// The pipeline is: download -> select parser -> parse -> persist. Parser
// selection is delegated to the registry, so this service contains NO
// MIME-type-specific logic and never changes when a new format is added.
//
// Parsing is not wired up yet (parsers are placeholders that throw). Today the
// service behaves exactly as before: it downloads the file, stores it, and marks
// the attachment completed. The parse/persist seams are in place for future
// sprints.
export class DocumentProcessingService {
  private readonly storage: StorageService;
  private readonly registry: ParserRegistry;

  constructor(
    storage: StorageService = storageService,
    registry: ParserRegistry = parserRegistry,
  ) {
    this.storage = storage;
    this.registry = registry;
  }

  // Public API. Download the attachment bytes and persist the result, recording
  // failures so BullMQ can retry per the queue's backoff policy.
  async process(attachmentId: number): Promise<void> {
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
    // GmailAccount). The refreshToken comes from the exact account that owns the
    // message.
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
      const storagePath = await this.downloadAttachment(
        attachment,
        account.refreshToken,
        messageId,
      );

      const parser = this.selectParser(attachment.mimeType);
      const parsed = await this.parseDocument(parser, storagePath);

      await this.persistResult(attachmentId, storagePath, parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      await markAttachmentFailed(attachmentId, message);

      // Rethrow so BullMQ records the failure and retries per the queue's
      // backoff policy.
      throw error;
    }
  }

  // Download bytes from Gmail and persist them via the storage abstraction,
  // returning the opaque storage path.
  private async downloadAttachment(
    attachment: LoadedAttachment,
    refreshToken: string,
    messageId: string,
  ): Promise<string> {
    const data = await getAttachmentData(
      refreshToken,
      messageId,
      attachment.gmailAttachmentId,
    );

    const key = buildStorageKey(attachment.filename);
    return this.storage.store(key, data);
  }

  // Ask the registry which parser (if any) handles this MIME type. Returns
  // undefined for unsupported formats — the sole source of parser routing.
  private selectParser(mimeType: string): AttachmentParser | undefined {
    return this.registry.findParser(mimeType);
  }

  // Parse the downloaded document into the normalized ParsedAttachment shape.
  //
  // Parsing is deferred: the parser implementations are placeholders that throw
  // "Not implemented", so we do not invoke `parser.parse()` yet — doing so would
  // break today's download-only behavior. When a format's parser is implemented,
  // this method invokes it here; unsupported formats (no parser) simply skip
  // parsing and are still considered successfully processed.
  private async parseDocument(
    parser: AttachmentParser | undefined,
    _storagePath: string,
  ): Promise<ParsedAttachment | undefined> {
    if (!parser) {
      return undefined;
    }

    // Future sprint: `return parser.parse(_storagePath);`
    return undefined;
  }

  // Record the outcome. Storing parsed content has no schema yet, so for now
  // this only records the stored file path and completion — identical to the
  // pre-framework behavior.
  private async persistResult(
    attachmentId: number,
    storagePath: string,
    _parsed: ParsedAttachment | undefined,
  ): Promise<void> {
    await markAttachmentCompleted(attachmentId, storagePath, new Date());
  }
}

// Shared singleton used by the attachment worker.
export const documentProcessingService = new DocumentProcessingService();
