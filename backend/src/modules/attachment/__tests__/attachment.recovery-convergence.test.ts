// G-7.3 — the reconciler and the worker must agree about what is finished.
//
// Two mechanisms now decide whether an attachment still owes work, and they use
// different inputs:
//
//   the RECONCILER decides from a SQL predicate plus the parser registry,
//     without loading the pipeline at all;
//   the WORKER decides from `isSettled`, at processing time, from the row it
//     loaded.
//
// If they disagree, one of two failures follows. Reconciler stricter than
// `isSettled` ⇒ stranded work is never recovered, silently. Reconciler looser
// ⇒ it enqueues rows the worker immediately no-ops, which complete, which frees
// the deterministic job id, which makes the row eligible again on the very next
// sweep: an unbounded churn loop.
//
// So this suite asserts the JOINT behaviour that neither module's own suite can:
// for each boundary row shape, what the reconciler does with it AND what the
// real pipeline then does with it. The reconciler is a discovery mechanism; the
// worker remains the processing-time authority, and `isSettled` is unchanged.
//
// The guarantee being demonstrated is at-least-once recovery with convergent
// effects — never exactly-once. A recovered job re-runs real work; what makes
// that safe is that it resumes rather than restarts, and that its writes
// converge.

// The generated Prisma client is ESM-only; the repository imports it only for
// the `Prisma.DbNull` sentinel. Same stub, same reason, as the sibling suites.
jest.mock("../../../../generated/prisma/client", () => ({
  Prisma: { DbNull: { __sentinel: "DbNull" } },
}));

// The one candidate row both mechanisms read, held here so the Prisma mock and
// the pipeline mock cannot drift apart.
const candidateRows: Record<string, unknown>[] = [];

// `getStaleUnfinishedAttachments` is deliberately NOT stubbed — the agreement
// under test is between the REAL recovery predicate and `isSettled`, so a
// hand-written stand-in for the query would let them agree about a fiction.
// Instead the query runs for real against a Prisma mock that honours the filter
// syntax it uses.
jest.mock("../../../lib/prisma", () => {
  const matchesLeaf = (
    row: Record<string, unknown>,
    where: Record<string, unknown>,
  ): boolean =>
    Object.entries(where).every(([column, predicate]) => {
      if (predicate !== null && typeof predicate === "object") {
        const clause = predicate as Record<string, unknown>;

        if ("lt" in clause) {
          return (row[column] as Date) < (clause.lt as Date);
        }

        if ("in" in clause) {
          return (clause.in as unknown[]).includes(row[column]);
        }
      }

      return (row[column] ?? null) === (predicate ?? null);
    });

  return {
    prisma: {
      attachment: {
        findMany: jest.fn(async (args: { where?: Record<string, unknown> }) => {
          const { OR, ...rest } = (args?.where ?? {}) as {
            OR?: Record<string, unknown>[];
          } & Record<string, unknown>;

          return candidateRows.filter(
            (row) =>
              matchesLeaf(row, rest) &&
              (OR ? OR.some((branch) => matchesLeaf(row, branch)) : true),
          );
        }),
      },
    },
  };
});

// Only the pipeline's own repository calls are stubbed; the recovery query above
// stays real.
jest.mock("../attachment.repository", () => ({
  ...jest.requireActual("../attachment.repository"),
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

jest.mock("../../document-intelligence/document-intelligence.repository", () => ({
  saveDocumentIntelligence: jest.fn(),
}));

const mockEnqueue = jest.fn(async (_attachmentId: number) => undefined);

jest.mock("../attachment.queue", () => ({
  enqueueAttachmentProcessing: mockEnqueue,
}));

import { DocumentProcessingService } from "../document-processing.service";
import { reconcileOrphanedAttachments } from "../attachment.reconciler";
import * as repo from "../attachment.repository";
import { getAttachmentData } from "../../gmail/gmail.service";
import { parserRegistry } from "../parsers/parser-registry";
import type { StorageService } from "../storage/storage.interface";
import type { AttachmentParser } from "../parsers/attachment-parser.interface";
import type { ParserRegistry } from "../parsers/parser-registry";
import type { DocumentIntelligenceService } from "../../document-intelligence/document-intelligence.service";

const ATTACHMENT_ID = 1;
const OWNER_USER_ID = 7;

const STORAGE_PATH = "/storage/attachments/abc.pdf";
const PARSED = { text: "placement drive details", metadata: { pageCount: 2 } };

const PDF = "application/pdf";
const PNG = "image/png";

const CUTOFF = new Date("2026-08-23T11:55:00.000Z");
const OLD = new Date("2026-08-23T11:00:00.000Z");

const mocked = repo as unknown as Record<string, jest.Mock>;

// One row shape, read by BOTH mechanisms: the reconciler sees it through the
// repository query, the pipeline sees it through `getAttachmentById`. That
// single source is what makes the agreement assertions meaningful.
const row = (overrides: Record<string, unknown> = {}) => ({
  id: ATTACHMENT_ID,
  userId: OWNER_USER_ID,
  emailId: 10,
  gmailAttachmentId: "gmail-att-1",
  filename: "drive.pdf",
  mimeType: PDF,
  processingStatus: "pending",
  storagePath: null,
  parsedAt: null,
  parsingError: null,
  createdAt: OLD,
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
let service: DocumentProcessingService;

// Runs the reconciler — the real query and the real registry filter — over
// exactly one candidate row, then reports whether it was enqueued.
const reconcilerEnqueues = async (
  candidate: Record<string, unknown>,
): Promise<boolean> => {
  mockEnqueue.mockClear();

  candidateRows.length = 0;
  candidateRows.push(candidate);

  await reconcileOrphanedAttachments({ olderThan: CUTOFF, batchSize: 100 });

  return mockEnqueue.mock.calls.length > 0;
};

// Runs the real pipeline over the same row, then reports whether it did work —
// i.e. whether `isSettled` let it through.
const pipelineDoesWork = async (
  candidate: Record<string, unknown>,
): Promise<boolean> => {
  (getAttachmentData as jest.Mock).mockClear();
  mocked.getAttachmentById.mockResolvedValue(candidate);

  await service.process(ATTACHMENT_ID);

  return (getAttachmentData as jest.Mock).mock.calls.length > 0;
};

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

  (getAttachmentData as jest.Mock).mockResolvedValue(Buffer.from("pdf-bytes"));
  mockEnqueue.mockImplementation(async () => undefined);

  // THE ROUTING DECISION IS THE REAL ONE; only the parser instance is stubbed.
  //
  // The reconciler imports `parserRegistry` directly, so its MIME filter is
  // genuinely the production one. The pipeline receives this delegating
  // registry, which asks the same real registry whether a format is handled and
  // then substitutes a controllable parser for the answer. Both sides therefore
  // consult one authority — a stub that invented its own routing would let them
  // agree about a fiction — while the parse itself stays deterministic and
  // never touches the filesystem.
  const registry = {
    findParser: (mimeType: string) =>
      parserRegistry.findParser(mimeType) === undefined ? undefined : parser,
  } as unknown as ParserRegistry;

  // Document Intelligence is stubbed rather than exercised: it is `USE_AI`-gated
  // and fail-soft, and this suite is about the settled/replayable boundary.
  const intelligence = {
    analyze: jest.fn(),
  } as unknown as DocumentIntelligenceService;

  service = new DocumentProcessingService(storage, registry, intelligence);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * 23. A recovered orphan actually enters the pipeline and completes it.
 * ------------------------------------------------------------------ */

describe("a recovered orphan-J attachment resumes the pipeline", () => {
  // Orphan J: the download committed, the parse never did, and the job was
  // removed on completion so nothing else can reach this row.
  const ORPHAN_J = {
    processingStatus: "completed",
    storagePath: STORAGE_PATH,
    parsedAt: null,
    parsingError: null,
  };

  test("the reconciler enqueues it", async () => {
    expect(await reconcilerEnqueues(row(ORPHAN_J))).toBe(true);
  });

  test("the recovered job then parses and persists the result", async () => {
    mocked.getAttachmentById.mockResolvedValue(row(ORPHAN_J));

    await service.process(ATTACHMENT_ID);

    // It RESUMES rather than skipping: `isSettled` is false for this row, so
    // the pipeline runs and the parse that was lost is finally durable.
    expect(parser.parse).toHaveBeenCalledWith(STORAGE_PATH);
    expect(mocked.updateParsedResult).toHaveBeenCalledWith(
      { userId: OWNER_USER_ID },
      ATTACHMENT_ID,
      PARSED,
      expect.any(Date),
    );
  });

  test("the recovered job derives its owner from the persisted row", async () => {
    mocked.getAttachmentById.mockResolvedValue(
      row({
        ...ORPHAN_J,
        userId: 42,
        email: {
          id: 10,
          userId: 42,
          gmailMessageId: "gmail-msg-1",
          gmailAccount: { id: 3, userId: 42, refreshToken: "refresh-token" },
        },
      }),
    );

    await service.process(ATTACHMENT_ID);

    // Recovery must not become a second source of ownership. The queue payload
    // carries the id alone, so the row remains the only answer (RFC-001 §9.5).
    expect(mocked.updateParsedResult).toHaveBeenCalledWith(
      { userId: 42 },
      ATTACHMENT_ID,
      PARSED,
      expect.any(Date),
    );
  });
});

/* ------------------------------------------------------------------ *
 * 24. A duplicate job for settled work stays a no-op.
 * ------------------------------------------------------------------ */

describe("a duplicate job for a settled attachment is absorbed", () => {
  test.each([
    ["already parsed", { processingStatus: "completed", parsedAt: OLD }],
    [
      "parse already failed",
      { processingStatus: "completed", parsingError: "corrupt pdf" },
    ],
  ])("%s — the pipeline does no work", async (_label, overrides) => {
    mocked.getAttachmentById.mockResolvedValue(row(overrides));

    await service.process(ATTACHMENT_ID);

    // At-least-once delivery means a duplicate job is always possible — a
    // racing sweep, a stalled-job replay. `isSettled` is what makes it cost
    // nothing: no download, no parse, no provider call.
    expect(getAttachmentData).not.toHaveBeenCalled();
    expect(parser.parse).not.toHaveBeenCalled();
    expect(mocked.markAttachmentProcessing).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * The agreement itself — the property neither module can assert alone.
 * ------------------------------------------------------------------ */

describe("the reconciler and isSettled agree on every boundary shape", () => {
  test.each([
    // [label, row overrides, both should act?]
    ["pending, never claimed", { processingStatus: "pending" }, true],
    ["claimed by a dead worker", { processingStatus: "processing" }, true],
    [
      "downloaded but never parsed (orphan J)",
      {
        processingStatus: "completed",
        storagePath: STORAGE_PATH,
        parsedAt: null,
        parsingError: null,
      },
      true,
    ],
    [
      "already parsed",
      { processingStatus: "completed", parsedAt: OLD },
      false,
    ],
    [
      "parse already failed",
      { processingStatus: "completed", parsingError: "corrupt pdf" },
      false,
    ],
    [
      "downloaded, no parser for the format",
      {
        processingStatus: "completed",
        mimeType: PNG,
        filename: "banner.png",
        storagePath: "/storage/attachments/abc.png",
        parsedAt: null,
        parsingError: null,
      },
      false,
    ],
  ])("%s", async (_label, overrides, shouldAct) => {
    const candidate = row(overrides);

    // The decisive assertion is that these two are EQUAL, not that either has a
    // particular value. Disagreement in one direction strands work forever; in
    // the other it churns forever.
    expect(await reconcilerEnqueues(candidate)).toBe(shouldAct);
    expect(await pipelineDoesWork(candidate)).toBe(shouldAct);
  });
});
