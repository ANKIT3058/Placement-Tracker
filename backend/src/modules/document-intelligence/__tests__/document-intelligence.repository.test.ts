// One intelligence row per attachment, enforced by the database.
//
// Attachment processing is replayed whenever the worker dies holding its BullMQ
// lock, and DocumentProcessingService's already-completed guard sits BEFORE the
// parse step — so this write is genuinely reachable more than once for a single
// attachment. The guarantee being pinned here is DATABASE-enforced uniqueness on
// (attachmentId, userId), so the fake store below actually enforces it: `create`
// rejects a second row for a key that already exists, exactly as the unique
// index does, and `upsert` resolves on the composite selector.
//
// That is what makes this file fail against a findFirst-then-create
// implementation for the right reason — the second `create` is refused — rather
// than because a spy counted wrong. It follows the convention established by
// extraction.idempotency.test.ts, for the same reason and against the same class
// of bug.
//
// There is deliberately no database here: the repository has no local Postgres
// and `backend/.env` points at PRODUCTION, so an integration test would have to
// be pointed at the live database. Modelling the constraint is the honest
// substitute; the constraint itself is verified by inspecting the migration SQL.

// The sentinel the generated client exports for "write SQL NULL into this JSON
// column". The fake store below resolves it to `null`, which is what the column
// actually ends up holding — so assertions read the stored value, not the
// marker.
const DB_NULL = { __dbNull: true } as const;

jest.mock("../../../../generated/prisma/client", () => ({
  Prisma: { DbNull: DB_NULL },
}));

type Row = {
  id: number;
  attachmentId: number;
  userId: number;
  classification: string;
  classificationConfidence: number;
  summary: string;
  eventInformation: unknown;
  participantInformation: unknown;
  extractedAt: Date;
  createdAt: Date;
};

const rows: Row[] = [];

const find = (attachmentId: number, userId: number) =>
  rows.find(
    (row) => row.attachmentId === attachmentId && row.userId === userId,
  );

const uniqueViolation = () => {
  const error = new Error(
    "Unique constraint failed on the fields: (`attachmentId`,`userId`)",
  ) as Error & { code: string; meta: { target: string[] } };

  error.code = "P2002";
  error.meta = { target: ["attachmentId", "userId"] };

  return error;
};

// Resolve the DbNull sentinel the way Postgres would: the column holds NULL.
const resolveJson = (value: unknown): unknown =>
  value === DB_NULL ? null : value;

const materialise = (data: Record<string, unknown>): Row => ({
  id: rows.length + 1,
  attachmentId: data.attachmentId as number,
  userId: data.userId as number,
  classification: data.classification as string,
  classificationConfidence: data.classificationConfidence as number,
  summary: data.summary as string,
  eventInformation: resolveJson(data.eventInformation),
  participantInformation: resolveJson(data.participantInformation),
  extractedAt: data.extractedAt as Date,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

const upsertSpy = jest.fn();

jest.mock("../../../lib/prisma", () => ({
  prisma: {
    documentIntelligence: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (find(data.attachmentId as number, data.userId as number)) {
          throw uniqueViolation();
        }

        const row = materialise(data);
        rows.push(row);

        return row;
      }),

      upsert: jest.fn(
        async (args: {
          where: {
            attachmentId_userId?: { attachmentId: number; userId: number };
          };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          upsertSpy(args);

          const selector = args.where.attachmentId_userId;

          // A selector that is not the composite key cannot address the row the
          // constraint protects. Failing loudly here stops a wrong-key upsert
          // from looking like a passing test.
          if (!selector) {
            throw new Error(
              "upsert must resolve on the composite attachmentId_userId selector",
            );
          }

          const existing = find(selector.attachmentId, selector.userId);

          if (!existing) {
            const row = materialise(args.create);
            rows.push(row);

            return row;
          }

          // Apply the update payload the way Prisma would, resolving the JSON
          // sentinel. Applying it verbatim is what lets a test catch an
          // implementation that sent `undefined` instead of an explicit null.
          for (const [key, value] of Object.entries(args.update)) {
            (existing as unknown as Record<string, unknown>)[key] =
              resolveJson(value);
          }

          return existing;
        },
      ),
    },
  },
}));

import { saveDocumentIntelligence } from "../document-intelligence.repository";
import { DOCUMENT_TYPE } from "../document-type";
import type { DocumentInsights } from "../document-insights.types";

const ATTACHMENT = 42;
const OWNER = { userId: 7 };
const AT = new Date("2026-08-24T10:00:00.000Z");

const insights = (
  overrides: Partial<DocumentInsights> = {},
): DocumentInsights => ({
  classification: DOCUMENT_TYPE.SHORTLIST,
  confidence: 0.9,
  summary: "Shortlist for the Amazon OA.",
  ...overrides,
});

const WITH_PARTICIPANTS = insights({
  participantInformation: {
    participants: [{ attributes: { roll_no: "21BCE1234" } }],
  },
});

describe("an attachment has exactly one intelligence row, whatever the worker does", () => {
  beforeEach(() => {
    rows.length = 0;
    jest.clearAllMocks();
  });

  test("the first call inserts one row", async () => {
    await saveDocumentIntelligence(OWNER, ATTACHMENT, WITH_PARTICIPANTS, AT);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attachmentId: ATTACHMENT,
      userId: OWNER.userId,
      classification: DOCUMENT_TYPE.SHORTLIST,
      classificationConfidence: 0.9,
      summary: "Shortlist for the Amazon OA.",
      extractedAt: AT,
    });
    expect(rows[0].participantInformation).toEqual({
      participants: [{ attributes: { roll_no: "21BCE1234" } }],
    });
  });

  test("a replay updates the same row rather than inserting a second", async () => {
    // The BullMQ replay: identical job, same attachment, run again after the
    // first attempt died before the job was acknowledged.
    await saveDocumentIntelligence(OWNER, ATTACHMENT, WITH_PARTICIPANTS, AT);
    await saveDocumentIntelligence(OWNER, ATTACHMENT, WITH_PARTICIPANTS, AT);

    expect(rows).toHaveLength(1);
  });

  test("the latest successful result wins", async () => {
    await saveDocumentIntelligence(OWNER, ATTACHMENT, WITH_PARTICIPANTS, AT);

    // Not hypothetical: classification and extraction are non-deterministic
    // model calls, so a replay can legitimately reach a different answer. The
    // row must describe the attempt that actually completed.
    const later = new Date("2026-08-24T11:00:00.000Z");
    await saveDocumentIntelligence(
      OWNER,
      ATTACHMENT,
      insights({
        classification: DOCUMENT_TYPE.RESULT,
        confidence: 0.42,
        summary: "Final results.",
      }),
      later,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      classification: DOCUMENT_TYPE.RESULT,
      classificationConfidence: 0.42,
      summary: "Final results.",
      extractedAt: later,
    });
  });

  test("an explicit null replaces JSON written by a previous attempt", async () => {
    await saveDocumentIntelligence(OWNER, ATTACHMENT, WITH_PARTICIPANTS, AT);
    expect(rows[0].participantInformation).not.toBeNull();

    // A replay that understood LESS — a provider outage degrading the document
    // to UNKNOWN with no extraction. Prisma reads `undefined` as "leave this
    // column alone", so an implementation that sent undefined would silently
    // retain the previous run's participants and leave the row describing
    // neither attempt.
    await saveDocumentIntelligence(
      OWNER,
      ATTACHMENT,
      insights({
        classification: DOCUMENT_TYPE.UNKNOWN,
        confidence: 0,
        summary: "",
      }),
      AT,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].participantInformation).toBeNull();
    expect(rows[0].eventInformation).toBeNull();
  });

  test("an absent slice is written as an explicit null on first insert", async () => {
    await saveDocumentIntelligence(OWNER, ATTACHMENT, insights(), AT);

    expect(rows[0].eventInformation).toBeNull();
    expect(rows[0].participantInformation).toBeNull();
  });

  test("different attachments keep separate rows", async () => {
    await saveDocumentIntelligence(OWNER, ATTACHMENT, insights(), AT);
    await saveDocumentIntelligence(OWNER, 43, insights(), AT);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.attachmentId).sort()).toEqual([42, 43]);
  });

  test("the same attachment id under a different owner does not collide", async () => {
    await saveDocumentIntelligence(OWNER, ATTACHMENT, insights(), AT);
    await saveDocumentIntelligence({ userId: 8 }, ATTACHMENT, insights(), AT);

    // Proves the key is composite. Keyed on attachmentId alone, the second
    // write would overwrite another tenant's row.
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.userId).sort()).toEqual([7, 8]);
  });

  test("the write resolves on the composite attachmentId_userId selector", async () => {
    await saveDocumentIntelligence(OWNER, ATTACHMENT, insights(), AT);

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0].where).toEqual({
      attachmentId_userId: { attachmentId: ATTACHMENT, userId: OWNER.userId },
    });
  });

  test("identity columns are never rewritten by the update branch", async () => {
    await saveDocumentIntelligence(OWNER, ATTACHMENT, insights(), AT);
    await saveDocumentIntelligence(OWNER, ATTACHMENT, insights(), AT);

    const update = upsertSpy.mock.calls[1][0].update;

    expect(update).not.toHaveProperty("attachmentId");
    expect(update).not.toHaveProperty("userId");
    expect(update).not.toHaveProperty("id");
    // createdAt records when the attachment was FIRST understood; a replay is
    // not a new understanding.
    expect(update).not.toHaveProperty("createdAt");
  });

  test("every mutable field is present in the update branch", async () => {
    await saveDocumentIntelligence(OWNER, ATTACHMENT, insights(), AT);
    await saveDocumentIntelligence(OWNER, ATTACHMENT, insights(), AT);

    // The complement of the test above: a field omitted here is a field a
    // replay could leave stale.
    expect(Object.keys(upsertSpy.mock.calls[1][0].update).sort()).toEqual([
      "classification",
      "classificationConfidence",
      "eventInformation",
      "extractedAt",
      "participantInformation",
      "summary",
    ]);
  });

  test("a database error is propagated, not swallowed", async () => {
    const { prisma } = jest.requireMock("../../../lib/prisma") as {
      prisma: { documentIntelligence: { upsert: jest.Mock } };
    };

    prisma.documentIntelligence.upsert.mockRejectedValueOnce(
      new Error("connection terminated"),
    );

    // A failed write must not be reported as a successful understanding.
    await expect(
      saveDocumentIntelligence(OWNER, ATTACHMENT, insights(), AT),
    ).rejects.toThrow("connection terminated");
  });
});
