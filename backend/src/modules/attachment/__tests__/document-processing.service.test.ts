// Ownership derivation in the attachment processing pipeline.
//
// The attachment queue payload is `{ attachmentId }` and deliberately stays
// that way (see attachment.queue.test.ts). That makes the persisted
// `Attachment.userId` the ONLY possible source of ownership for this pipeline:
// the worker loads the row, reads the owner off it, and carries that owner into
// every subsequent write — the same derivation the email worker performs
// against `Email.userId` (RFC-001 §9.5).
//
// These tests assert the threading, not the storage: `attachment.repository`
// is mocked, so what is under test here is "which owner does the service hand
// to each mutation", while the repository's own WHERE predicates are pinned in
// attachment.repository.test.ts.
//
// The owner travels as an `OwnershipContext` ({ userId }) in the FIRST argument
// position, matching how `email.processor` and `email.repository` already pass
// ownership (`updateEmailStatus(owner, id, status)`).

jest.mock("../attachment.repository", () => ({
  getAttachmentById: jest.fn(),
  markAttachmentProcessing: jest.fn(),
  markAttachmentCompleted: jest.fn(),
  markAttachmentFailed: jest.fn(),
  updateParsedResult: jest.fn(),
  markParsingFailed: jest.fn(),
}));

jest.mock("../../gmail/gmail.service", () => ({
  getAttachmentData: jest.fn(),
}));

import { DocumentProcessingService } from "../document-processing.service";
import * as repo from "../attachment.repository";
import { getAttachmentData } from "../../gmail/gmail.service";
import type { StorageService } from "../storage/storage.interface";
import type { AttachmentParser } from "../parsers/attachment-parser.interface";
import type { ParserRegistry } from "../parsers/parser-registry";
import type { OwnershipContext } from "../../auth/tenant-context";

const ATTACHMENT_ID = 1;
const OWNER_USER_ID = 7;

// What the service is expected to BUILD from the persisted row and hand to
// every mutation: an `OwnershipContext`, in the first argument position — the
// same shape and position `email.processor` threads through its own writes.
const OWNER: OwnershipContext = { userId: OWNER_USER_ID };

const STORAGE_PATH = "/storage/attachments/abc.pdf";

const PARSED = { text: "placement drive details", metadata: { pageCount: 2 } };

// Loosely-typed handles: the scoped repository signatures do not exist yet, so
// asserting on them through the real types would be a compile error rather than
// the behavioural RED these tests are meant to produce.
const mocked = repo as unknown as Record<string, jest.Mock>;

const attachmentRow = (overrides: Record<string, unknown> = {}) => ({
  id: ATTACHMENT_ID,
  userId: OWNER_USER_ID,
  emailId: 10,
  gmailAttachmentId: "gmail-att-1",
  filename: "drive.pdf",
  mimeType: "application/pdf",
  processingStatus: "pending",
  storagePath: null,
  email: {
    id: 10,
    userId: OWNER_USER_ID,
    gmailMessageId: "gmail-msg-1",
    gmailAccount: { id: 3, userId: OWNER_USER_ID, refreshToken: "refresh-token" },
  },
  ...overrides,
});

let storage: jest.Mocked<StorageService>;
let parser: jest.Mocked<AttachmentParser>;
let registry: ParserRegistry;
let service: DocumentProcessingService;

beforeEach(() => {
  jest.clearAllMocks();

  storage = {
    store: jest.fn().mockResolvedValue(STORAGE_PATH),
    read: jest.fn(),
    delete: jest.fn(),
  };

  parser = {
    supports: jest.fn().mockReturnValue(true),
    parse: jest.fn().mockResolvedValue(PARSED),
  };

  registry = { findParser: jest.fn().mockReturnValue(parser) } as unknown as ParserRegistry;

  (getAttachmentData as jest.Mock).mockResolvedValue(Buffer.from("pdf-bytes"));
  mocked.getAttachmentById.mockResolvedValue(attachmentRow());

  service = new DocumentProcessingService(storage, registry);
});

// ---------------------------------------------------------------------------
// 5. The owner is derived from the persisted Attachment.
// ---------------------------------------------------------------------------

describe("ownership derivation", () => {
  test("loads the attachment by id alone — the only input it receives", async () => {
    await service.process(ATTACHMENT_ID);

    expect(mocked.getAttachmentById).toHaveBeenCalledWith(ATTACHMENT_ID);
  });

  // The decisive test: the owner threaded into the writes TRACKS the persisted
  // row. A hard-coded constant, or a value smuggled in from anywhere other than
  // the loaded Attachment, cannot satisfy both cases.
  test.each([7, 42, 1234])(
    "threads the persisted userId (%i) into every mutation",
    async (persistedUserId) => {
      mocked.getAttachmentById.mockResolvedValue(
        attachmentRow({
          userId: persistedUserId,
          email: {
            id: 10,
            userId: persistedUserId,
            gmailMessageId: "gmail-msg-1",
            gmailAccount: {
              id: 3,
              userId: persistedUserId,
              refreshToken: "refresh-token",
            },
          },
        }),
      );

      await service.process(ATTACHMENT_ID);

      // Deep equality on the context object: the service must build
      // `{ userId }` from the row it loaded, not pass the scalar or a
      // context belonging to anyone else.
      expect(mocked.markAttachmentProcessing).toHaveBeenCalledWith(
        { userId: persistedUserId },
        ATTACHMENT_ID,
      );
      expect(mocked.markAttachmentCompleted).toHaveBeenCalledWith(
        { userId: persistedUserId },
        ATTACHMENT_ID,
        STORAGE_PATH,
        expect.any(Date),
      );
      expect(mocked.updateParsedResult).toHaveBeenCalledWith(
        { userId: persistedUserId },
        ATTACHMENT_ID,
        PARSED,
        expect.any(Date),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Every mutation on every path carries the owner — including the paths that
// only run when something goes wrong, which are the easiest ones to forget.
// ---------------------------------------------------------------------------

describe("every mutation carries the derived owner", () => {
  test("markAttachmentProcessing", async () => {
    await service.process(ATTACHMENT_ID);

    expect(mocked.markAttachmentProcessing).toHaveBeenCalledWith(
      OWNER,
      ATTACHMENT_ID,
    );
  });

  test("markAttachmentCompleted", async () => {
    await service.process(ATTACHMENT_ID);

    expect(mocked.markAttachmentCompleted).toHaveBeenCalledWith(
      OWNER,
      ATTACHMENT_ID,
      STORAGE_PATH,
      expect.any(Date),
    );
  });

  test("updateParsedResult", async () => {
    await service.process(ATTACHMENT_ID);

    expect(mocked.updateParsedResult).toHaveBeenCalledWith(
      OWNER,
      ATTACHMENT_ID,
      PARSED,
      expect.any(Date),
    );
  });

  test("markParsingFailed — parse failure path", async () => {
    parser.parse.mockRejectedValue(new Error("corrupt pdf"));

    await service.process(ATTACHMENT_ID);

    expect(mocked.markParsingFailed).toHaveBeenCalledWith(
      OWNER,
      ATTACHMENT_ID,
      "corrupt pdf",
    );
  });

  test("markAttachmentFailed — download failure path", async () => {
    (getAttachmentData as jest.Mock).mockRejectedValue(new Error("gmail 500"));

    await expect(service.process(ATTACHMENT_ID)).rejects.toThrow("gmail 500");

    expect(mocked.markAttachmentFailed).toHaveBeenCalledWith(
      OWNER,
      ATTACHMENT_ID,
      "gmail 500",
    );
  });

  test("markAttachmentFailed — missing gmailMessageId path", async () => {
    mocked.getAttachmentById.mockResolvedValue(
      attachmentRow({
        email: {
          id: 10,
          userId: OWNER_USER_ID,
          gmailMessageId: null,
          gmailAccount: { id: 3, userId: OWNER_USER_ID, refreshToken: "refresh-token" },
        },
      }),
    );

    await service.process(ATTACHMENT_ID);

    expect(mocked.markAttachmentFailed).toHaveBeenCalledWith(
      OWNER,
      ATTACHMENT_ID,
      "Originating email has no gmailMessageId",
    );
  });

  test("markAttachmentFailed — missing Gmail account path", async () => {
    mocked.getAttachmentById.mockResolvedValue(
      attachmentRow({
        email: {
          id: 10,
          userId: OWNER_USER_ID,
          gmailMessageId: "gmail-msg-1",
          gmailAccount: null,
        },
      }),
    );

    await service.process(ATTACHMENT_ID);

    expect(mocked.markAttachmentFailed).toHaveBeenCalledWith(
      OWNER,
      ATTACHMENT_ID,
      "Originating email has no associated Gmail account",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Existing behaviour for the legitimate owner is unchanged. These are
// regression guards: scoping the writes must not alter the pipeline itself.
// ---------------------------------------------------------------------------

describe("existing processing behaviour is unchanged", () => {
  test("downloads via the originating account's refresh token", async () => {
    await service.process(ATTACHMENT_ID);

    expect(getAttachmentData).toHaveBeenCalledWith(
      "refresh-token",
      "gmail-msg-1",
      "gmail-att-1",
    );
  });

  test("stores the downloaded bytes under an opaque key", async () => {
    await service.process(ATTACHMENT_ID);

    expect(storage.store).toHaveBeenCalledTimes(1);

    const [key, data] = storage.store.mock.calls[0]!;
    // Opaque: a UUID plus the original extension — no id, no filename, no owner.
    expect(key).toMatch(/^[0-9a-f-]{36}\.pdf$/i);
    expect(data).toEqual(Buffer.from("pdf-bytes"));
  });

  test("parses via the registry and persists the result", async () => {
    await service.process(ATTACHMENT_ID);

    expect(registry.findParser).toHaveBeenCalledWith("application/pdf");
    expect(parser.parse).toHaveBeenCalledWith(STORAGE_PATH);
    expect(mocked.updateParsedResult).toHaveBeenCalled();
  });

  test("skips parsing when no parser handles the MIME type", async () => {
    (registry.findParser as jest.Mock).mockReturnValue(undefined);

    await service.process(ATTACHMENT_ID);

    expect(mocked.markAttachmentCompleted).toHaveBeenCalled();
    expect(mocked.updateParsedResult).not.toHaveBeenCalled();
    expect(mocked.markParsingFailed).not.toHaveBeenCalled();
  });

  test("is idempotent for an already-completed attachment", async () => {
    mocked.getAttachmentById.mockResolvedValue(
      attachmentRow({ processingStatus: "completed" }),
    );

    await service.process(ATTACHMENT_ID);

    expect(mocked.markAttachmentProcessing).not.toHaveBeenCalled();
    expect(getAttachmentData).not.toHaveBeenCalled();
    expect(mocked.markAttachmentCompleted).not.toHaveBeenCalled();
  });

  test("throws when the attachment does not exist", async () => {
    mocked.getAttachmentById.mockResolvedValue(null);

    await expect(service.process(ATTACHMENT_ID)).rejects.toThrow(
      `Attachment ${ATTACHMENT_ID} not found`,
    );

    expect(mocked.markAttachmentProcessing).not.toHaveBeenCalled();
  });

  test("a parse failure leaves the download completed", async () => {
    parser.parse.mockRejectedValue(new Error("corrupt pdf"));

    await service.process(ATTACHMENT_ID);

    expect(mocked.markAttachmentCompleted).toHaveBeenCalled();
    expect(mocked.markAttachmentFailed).not.toHaveBeenCalled();
  });
});
