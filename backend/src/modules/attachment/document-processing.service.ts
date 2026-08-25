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
  updateParsedResult,
  markParsingFailed,
} from "./attachment.repository.js";
import { ATTACHMENT_STATUS } from "./attachment.types.js";
// Imported from the concrete modules rather than the document-intelligence
// barrel: the barrel also re-exports the repository, so importing it here would
// pull `lib/prisma` into this module's graph through a path that says nothing
// about why. These two imports state exactly what this pipeline uses.
import {
  DocumentIntelligenceService,
  documentIntelligenceService,
} from "../document-intelligence/document-intelligence.service.js";
import { saveDocumentIntelligence } from "../document-intelligence/document-intelligence.repository.js";
import type { OwnershipContext } from "../auth/tenant-context.js";

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
// A parser runs when the registry has one for the MIME type (e.g. PDF) and its
// result is persisted via the repository. Download and parsing are separate
// failure domains: a download failure marks the attachment failed (retryable),
// while a parse failure leaves the attachment completed and only records a
// parsingError. Unsupported formats skip parsing entirely.
export class DocumentProcessingService {
  private readonly storage: StorageService;
  private readonly registry: ParserRegistry;
  private readonly documentIntelligence: DocumentIntelligenceService;

  constructor(
    storage: StorageService = storageService,
    registry: ParserRegistry = parserRegistry,
    documentIntelligence: DocumentIntelligenceService = documentIntelligenceService,
  ) {
    this.storage = storage;
    this.registry = registry;
    this.documentIntelligence = documentIntelligence;
  }

  // Public API. Download the attachment bytes and persist the result, recording
  // failures so BullMQ can retry per the queue's backoff policy.
  async process(attachmentId: number): Promise<void> {
    const attachment = await getAttachmentById(attachmentId);

    if (!attachment) {
      throw new Error(`Attachment ${attachmentId} not found`);
    }

    // Idempotent: a replayed/duplicated job with nothing left to do is a no-op.
    //
    // The test is "is this pipeline finished", NOT "is the download finished"
    // (G-7.1). Those were the same question when this service ended at the
    // download; they have not been since parsing was added, and `completed`
    // records only the download (attachment.repository markAttachmentCompleted).
    // Reading it as a whole-pipeline fact left a window — from the moment
    // completion commits below until parsing finishes — in which a crash and
    // replay would hit the guard and skip parsing and Document Intelligence
    // PERMANENTLY: nothing re-enqueues such a row either, because the enqueue
    // filter excludes `completed` too.
    if (this.isSettled(attachment)) {
      return;
    }

    // The authoritative owner of this unit of work, derived from the persisted
    // row rather than from the job payload (RFC-001 §9.5). The queue carries an
    // id and nothing else, so this is the only place ownership can come from —
    // and every write below is scoped by it.
    const owner: OwnershipContext = { userId: attachment.userId };

    const messageId = attachment.email.gmailMessageId;

    if (!messageId) {
      // Without the originating Gmail message id there is nothing to fetch; this
      // is not retryable, so fail permanently rather than throwing forever.
      await markAttachmentFailed(
        owner,
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
        owner,
        attachmentId,
        "Originating email has no associated Gmail account",
      );
      return;
    }

    await markAttachmentProcessing(owner, attachmentId);

    let storagePath: string;
    try {
      storagePath = await this.downloadAttachment(
        attachment,
        account.refreshToken,
        messageId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      await markAttachmentFailed(owner, attachmentId, message);

      // Rethrow so BullMQ records the failure and retries per the queue's
      // backoff policy. Download failures are retryable (e.g. transient Gmail
      // errors).
      throw error;
    }

    // Download succeeded — the attachment is completed regardless of whether
    // parsing follows or succeeds. Marking it here ensures a later parse failure
    // never flips the download status back to failed.
    await markAttachmentCompleted(owner, attachmentId, storagePath, new Date());

    // Best-effort parsing. Unsupported formats have no parser and are skipped.
    const parser = this.selectParser(attachment.mimeType);
    if (parser) {
      await this.parseAndPersist(owner, attachmentId, storagePath, parser);
    }
  }

  // Whether this attachment's pipeline has nothing left to do, decided from the
  // row already loaded above — no extra query, and no new column: every fact
  // this needs is already durable (G-7.1).
  //
  // DOWNLOAD, then PARSE. Anything short of `completed` re-runs from the top,
  // exactly as before. Past that, the parse columns are the discriminator the
  // status cannot be: `parsedAt` records a successful parse and `parsingError` a
  // failed one, and a row carrying neither, for a MIME type the registry
  // handles, is precisely the crash window described in `process`.
  //
  // `parsingError` counts as SETTLED, deliberately. A recorded parse failure is
  // a terminal state, not an unfinished one: parse errors are deterministic, so
  // they are never rethrown and never retried (see parseAndPersist). Treating
  // one as unfinished would quietly turn it into a retryable failure and
  // re-download the file on every replay to fail identically.
  //
  // Document Intelligence is deliberately ABSENT from this test. It is
  // fail-soft and gated on `USE_AI`, so a missing understanding is a normal,
  // expected outcome — with the gate off no row is ever written, and including
  // it would leave every attachment permanently unsettled and re-download it on
  // every replay. A crash inside that step is indistinguishable in durable state
  // from the provider failure this pipeline already tolerates, and is handled
  // the same way: it is skipped, not retried.
  //
  // `!= null` rather than truthiness, for both columns: an absent field may
  // arrive as `undefined` rather than `null`, and an empty-string
  // `parsingError` must not read as "never attempted".
  private isSettled(attachment: LoadedAttachment): boolean {
    if (attachment.processingStatus !== ATTACHMENT_STATUS.COMPLETED) {
      return false;
    }

    if (attachment.parsedAt != null || attachment.parsingError != null) {
      return true;
    }

    // No parse work exists for this format. The registry stays the single
    // authority on that question — the same call `process` makes to decide
    // whether to parse at all, so the two can never disagree.
    return this.selectParser(attachment.mimeType) === undefined;
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

  // Parse the downloaded document and persist the result via the repository.
  //
  // Parsing is best-effort and isolated from the download lifecycle: a parse
  // failure is recorded as a parsingError (the attachment stays completed) and
  // is NOT rethrown — parse errors are typically deterministic, so retrying the
  // whole job would only re-download the file without helping.
  private async parseAndPersist(
    owner: OwnershipContext,
    attachmentId: number,
    storagePath: string,
    parser: AttachmentParser,
  ): Promise<void> {
    let parsed: ParsedAttachment;
    try {
      parsed = await parser.parse(storagePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await markParsingFailed(owner, attachmentId, message);
      return;
    }

    await updateParsedResult(owner, attachmentId, parsed, new Date());

    // AFTER the parsed content is durable, never before (G-6.3). Understanding
    // describes what a document means; it is derived from the parsed text and
    // must not be able to exist for content that was never stored.
    await this.runDocumentIntelligence(owner, attachmentId, parsed);
  }

  // Understand the parsed document and persist that understanding (G-6.3).
  //
  // This is the call site the Document Intelligence layer was built for: the
  // classifier, extractors and assembler have existed and been tested since
  // G-6.2, and the row they write to since G-6.1, but nothing invoked them —
  // the gap the handbook records as G-6.
  //
  // GATED ON `USE_AI`, read per call rather than at module load, matching
  // `extraction.service`. Anything other than the exact string "true" — a
  // missing, empty or mistyped value — means no provider call and no row. That
  // is not merely a cost control: the production worker deliberately ships no
  // OPENAI_API_KEY, so an ungated call would fail on every attachment forever
  // and log a failure for each one.
  //
  // FAIL-SOFT, and deliberately the ONLY place that policy lives. Neither
  // collaborator applies it for itself: the three AI components are
  // contractually no-throw and degrade to values, while
  // `saveDocumentIntelligence` propagates database errors on purpose, so a
  // failed write is not reported as a successful understanding. Catching here
  // is what keeps either failure from taking down an attachment job whose
  // download and parse both succeeded — the same isolation `parseAndPersist`
  // already gives a parse failure, and for the same reason: retrying the job
  // would re-download the file without making the failure any likelier to
  // resolve.
  //
  // The log carries safe scalars only, never the error object (PR-9L): this
  // path can surface provider errors whose payloads may carry request context.
  private async runDocumentIntelligence(
    owner: OwnershipContext,
    attachmentId: number,
    parsed: ParsedAttachment,
  ): Promise<void> {
    if (process.env.USE_AI !== "true") {
      return;
    }

    try {
      const insights = await this.documentIntelligence.analyze(parsed);

      await saveDocumentIntelligence(owner, attachmentId, insights, new Date());
    } catch (error) {
      console.error("[attachment] Document intelligence failed", {
        attachmentId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// Shared singleton used by the attachment worker.
export const documentProcessingService = new DocumentProcessingService();
