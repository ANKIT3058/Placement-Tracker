import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAttachmentData } from "../gmail/gmail.service.js";
import { storageService } from "./storage/local-storage.service.js";
import { parserRegistry, } from "./parsers/parser-registry.js";
import { getAttachmentById, markAttachmentCompleted, markAttachmentProcessing, markAttachmentFailed, updateParsedResult, markParsingFailed, } from "./attachment.repository.js";
import { ATTACHMENT_STATUS } from "./attachment.types.js";
// Build an opaque, collision-free storage key. A random UUID (not the
// attachment id or original filename) keeps the on-disk path free of any
// user-controlled data; the original filename is preserved separately in the
// database. The extension is retained so the stored file stays recognizable to
// later parsing sprints.
const buildStorageKey = (filename) => {
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
// A parser runs when the registry has one for the MIME type (e.g. PDF) and its
// result is persisted via the repository. Download and parsing are separate
// failure domains: a download failure marks the attachment failed (retryable),
// while a parse failure leaves the attachment completed and only records a
// parsingError. Unsupported formats skip parsing entirely.
export class DocumentProcessingService {
    storage;
    registry;
    constructor(storage = storageService, registry = parserRegistry) {
        this.storage = storage;
        this.registry = registry;
    }
    // Public API. Download the attachment bytes and persist the result, recording
    // failures so BullMQ can retry per the queue's backoff policy.
    async process(attachmentId) {
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
            await markAttachmentFailed(attachmentId, "Originating email has no gmailMessageId");
            return;
        }
        // Resolve the account that synced this email (Attachment -> Email ->
        // GmailAccount). The refreshToken comes from the exact account that owns the
        // message.
        const account = attachment.email.gmailAccount;
        if (!account) {
            // The email predates account tracking (or the account was disconnected);
            // not retryable.
            await markAttachmentFailed(attachmentId, "Originating email has no associated Gmail account");
            return;
        }
        await markAttachmentProcessing(attachmentId);
        let storagePath;
        try {
            storagePath = await this.downloadAttachment(attachment, account.refreshToken, messageId);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            await markAttachmentFailed(attachmentId, message);
            // Rethrow so BullMQ records the failure and retries per the queue's
            // backoff policy. Download failures are retryable (e.g. transient Gmail
            // errors).
            throw error;
        }
        // Download succeeded — the attachment is completed regardless of whether
        // parsing follows or succeeds. Marking it here ensures a later parse failure
        // never flips the download status back to failed.
        await markAttachmentCompleted(attachmentId, storagePath, new Date());
        // Best-effort parsing. Unsupported formats have no parser and are skipped.
        const parser = this.selectParser(attachment.mimeType);
        if (parser) {
            await this.parseAndPersist(attachmentId, storagePath, parser);
        }
    }
    // Download bytes from Gmail and persist them via the storage abstraction,
    // returning the opaque storage path.
    async downloadAttachment(attachment, refreshToken, messageId) {
        const data = await getAttachmentData(refreshToken, messageId, attachment.gmailAttachmentId);
        const key = buildStorageKey(attachment.filename);
        return this.storage.store(key, data);
    }
    // Ask the registry which parser (if any) handles this MIME type. Returns
    // undefined for unsupported formats — the sole source of parser routing.
    selectParser(mimeType) {
        return this.registry.findParser(mimeType);
    }
    // Parse the downloaded document and persist the result via the repository.
    //
    // Parsing is best-effort and isolated from the download lifecycle: a parse
    // failure is recorded as a parsingError (the attachment stays completed) and
    // is NOT rethrown — parse errors are typically deterministic, so retrying the
    // whole job would only re-download the file without helping.
    async parseAndPersist(attachmentId, storagePath, parser) {
        let parsed;
        try {
            parsed = await parser.parse(storagePath);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            await markParsingFailed(attachmentId, message);
            return;
        }
        await updateParsedResult(attachmentId, parsed, new Date());
    }
}
// Shared singleton used by the attachment worker.
export const documentProcessingService = new DocumentProcessingService();
//# sourceMappingURL=document-processing.service.js.map