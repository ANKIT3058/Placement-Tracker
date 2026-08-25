// G-7.3 — recovering attachment work that Postgres owes and BullMQ has lost.
//
// An attachment row can say the pipeline is unfinished while no job exists for
// `attachment-${id}`: the enqueue never ran, Redis lost the job, or — the case
// that motivated this — the job COMPLETED on a half-finished pipeline.
// `markAttachmentCompleted` commits after the download and before the parse
// (G-7.1), so a worker killed mid-parse leaves a row reading `completed` with
// nothing parsed, and `removeOnComplete: true` then deleted the job. Nothing
// else can reach that row: the normal enqueue filter,
// `getPendingAttachmentsByEmailId`, excludes `completed`.
//
// THE CONTRACT THIS FILE SPECIFIES:
//
//     unfinished durable state + old enough + a parser exists
//         ↓
//     reconcileOrphanedAttachments({ olderThan, batchSize })
//         ↓
//     enqueueAttachmentProcessing(id)        ← the id ALONE, no owner
//         ↓
//     jobId attachment-${id}  ⇒ BullMQ collapses a racing duplicate
//
// The cutoff and the bound are injected rather than read from a clock or a
// constant, so no test waits on real time and no deployment decision is baked
// into the suite.
//
// WHAT IS NOT SPECIFIED HERE. Exactly-once processing is not the target and is
// not achievable across Postgres and Redis. The guarantee is at-least-once
// recovery with convergent effects: the deterministic job id suppresses
// duplicate JOBS, `isSettled` makes a duplicate RUN resume rather than restart,
// and the parse columns and the Document Intelligence upsert converge. Two
// non-idempotent effects survive a duplicate run and are accepted — a file
// stored under a fresh UUID, and a repeated provider call when `USE_AI=true`.
//
// The Prisma mock below honours the subset of filter syntax the recovery query
// actually uses, so seeding rows and observing which get enqueued exercises the
// REAL predicate rather than a restatement of it — the same approach, for the
// same reason, as `email.reconciliation.test.ts`.

// The generated Prisma client is ESM-only (it uses `import.meta`), which the
// CommonJS ts-jest transform cannot parse. The repository imports it solely for
// the `Prisma.DbNull` sentinel that `toJsonInput` returns for absent parser
// output — nothing the recovery query touches — so a stub of exactly that is
// enough, and keeps this suite from dragging the real client into the test
// runtime. Same stub, for the same reason, as attachment.repository.test.ts.
jest.mock("../../../../generated/prisma/client", () => ({
  Prisma: { DbNull: { __sentinel: "DbNull" } },
}));

type Row = Record<string, unknown>;

const mockAttachments: Row[] = [];

// Records the arguments the repository handed Prisma, so the query's shape can
// be asserted alongside its behaviour.
const mockFindMany = jest.fn();

jest.mock("../../../lib/prisma", () => {
  // Honours exactly what the recovery query uses: `lt`, `in`, `OR`, scalar
  // equality (including an explicit `null`), `orderBy` and `take`.
  const matchesLeaf = (row: Row, where: Row): boolean =>
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

  const matches = (row: Row, where: Row): boolean => {
    const { OR, ...rest } = where as { OR?: Row[] } & Row;

    if (!matchesLeaf(row, rest)) {
      return false;
    }

    return OR ? OR.some((branch) => matchesLeaf(row, branch)) : true;
  };

  return {
    prisma: {
      attachment: {
        findMany: jest.fn(
          async (args: {
            where?: Row;
            orderBy?: { createdAt?: "asc" | "desc" };
            take?: number;
          }) => {
            mockFindMany(args);

            let rows = mockAttachments.filter((row) =>
              matches(row, args?.where ?? {}),
            );

            if (args?.orderBy?.createdAt === "asc") {
              rows = [...rows].sort(
                (a, b) =>
                  (a.createdAt as Date).getTime() -
                  (b.createdAt as Date).getTime(),
              );
            }

            return typeof args?.take === "number"
              ? rows.slice(0, args.take)
              : rows;
          },
        ),
      },
    },
  };
});

const mockEnqueue = jest.fn(async (_attachmentId: number) => undefined);

jest.mock("../attachment.queue", () => ({
  enqueueAttachmentProcessing: mockEnqueue,
}));

// The parser registry is deliberately NOT mocked. The unsupported-MIME
// exclusion is the assertion that keeps this reconciler from becoming a churn
// loop, and it is only worth anything if it runs the real MIME routing — a
// mocked registry would prove the reconciler called something, not that a PNG
// is correctly recognised as having nothing to parse.

import { reconcileOrphanedAttachments } from "../attachment.reconciler";

const CUTOFF = new Date("2026-08-23T11:55:00.000Z");
const OLD = new Date("2026-08-23T11:00:00.000Z");
const OLDER = new Date("2026-08-23T10:00:00.000Z");
const RECENT = new Date("2026-08-23T11:59:00.000Z");

const BATCH = 100;

const PDF = "application/pdf";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PNG = "image/png";

// A row in the shape the recovery query reads. Defaults describe the plainest
// orphan: persisted, never claimed, old enough, and a format with a parser.
const seed = (overrides: Row = {}): Row => {
  const row: Row = {
    id: mockAttachments.length + 1,
    userId: 7,
    emailId: 10,
    filename: "drive.pdf",
    mimeType: PDF,
    processingStatus: "pending",
    storagePath: null,
    processingError: null,
    processedAt: null,
    parsedAt: null,
    parsingError: null,
    createdAt: OLD,
    ...overrides,
  };

  mockAttachments.push(row);

  return row;
};

const sweep = () =>
  reconcileOrphanedAttachments({ olderThan: CUTOFF, batchSize: BATCH });

const enqueuedIds = () =>
  mockEnqueue.mock.calls.map(([attachmentId]) => attachmentId).sort();

beforeEach(() => {
  jest.clearAllMocks();
  mockAttachments.length = 0;
  mockEnqueue.mockImplementation(async () => undefined);
});

/* ------------------------------------------------------------------ *
 * Discovery. Every shape of stranded work must be found.
 * ------------------------------------------------------------------ */

describe("stranded attachments are recovered", () => {
  test("a stale pending attachment is enqueued", async () => {
    const orphan = seed();

    const result = await sweep();

    expect(enqueuedIds()).toEqual([orphan.id]);
    expect(result.enqueued).toBe(1);
  });

  test("a stale processing attachment is enqueued", async () => {
    const orphan = seed({ processingStatus: "processing" });

    await sweep();

    // The worker claimed it and no longer exists. If its job is still alive the
    // enqueue collapses into it; if Redis lost the job, this is the only thing
    // that brings it back.
    expect(enqueuedIds()).toEqual([orphan.id]);
  });

  // THE CASE THE RECONCILER EXISTS FOR.
  test("a completed-but-unparsed attachment is enqueued", async () => {
    const orphan = seed({
      processingStatus: "completed",
      storagePath: "/storage/attachments/abc.pdf",
      processedAt: OLD,
      parsedAt: null,
      parsingError: null,
    });

    await sweep();

    // The G-7.1 crash window. `getPendingAttachmentsByEmailId` filters on
    // `not: completed`, so no other path in the system can re-enqueue this row.
    expect(enqueuedIds()).toEqual([orphan.id]);
  });

  test("every eligible row is enqueued, not just the first", async () => {
    const first = seed();
    const second = seed({ processingStatus: "processing" });
    const third = seed({ processingStatus: "completed" });

    await sweep();

    // An implementation that stopped after one row would leave a backlog that
    // never drains — a Redis outage strands every attachment synced during it,
    // not one.
    expect(enqueuedIds()).toEqual([first.id, second.id, third.id].sort());
  });

  test("the enqueue carries the attachment id alone", async () => {
    seed();

    await sweep();

    // The payload contract is pinned in attachment.queue.test.ts: a queue is not
    // an authenticated channel, so a `userId` here would be a claim sitting
    // beside the authoritative answer already in the database. The worker
    // derives the owner from the row it loads (RFC-001 §9.5).
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue.mock.calls[0]).toEqual([1]);
  });

  test("both parseable formats are recovered", async () => {
    const pdf = seed({ mimeType: PDF });
    const xlsx = seed({ mimeType: XLSX, filename: "shortlist.xlsx" });

    await sweep();

    expect(enqueuedIds()).toEqual([pdf.id, xlsx.id].sort());
  });
});

/* ------------------------------------------------------------------ *
 * Exclusion. Everything already settled, retrying, or too new.
 * ------------------------------------------------------------------ */

describe("settled and in-flight attachments are left alone", () => {
  test("a parsed attachment is never enqueued", async () => {
    seed({ processingStatus: "completed", parsedAt: OLD });

    await sweep();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("a parse failure is never enqueued", async () => {
    seed({ processingStatus: "completed", parsingError: "corrupt pdf" });

    await sweep();

    // A recorded parse failure is terminal, not unfinished: parse errors are
    // deterministic, which is why the pipeline never rethrows them. Recovering
    // one would re-download the file to fail in exactly the same way — silently
    // turning a non-retryable failure into a retryable one.
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  // THE CHURN-LOOP GUARD, and the highest-value negative in this suite.
  test("a completed attachment whose MIME type has no parser is never enqueued", async () => {
    seed({
      processingStatus: "completed",
      mimeType: PNG,
      filename: "banner.png",
      storagePath: "/storage/attachments/abc.png",
      parsedAt: null,
      parsingError: null,
    });

    await sweep();

    // Durably indistinguishable from the crash orphan, but `isSettled` already
    // considers it finished. Enqueueing it would produce a job the worker
    // no-ops, which completes, which frees the deterministic id, which makes
    // the row eligible again next sweep — unbounded churn that grows with the
    // corpus. The registry is what tells the two apart.
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("a failed attachment is never enqueued", async () => {
    seed({ processingStatus: "failed", processingError: "gmail 500" });

    await sweep();

    // A failed row always has a job, and `removeOnFail: false` retains its hash
    // permanently — so `add` is a silent no-op forever. Selecting these would
    // be a loop that looks like work and accomplishes nothing.
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("an attachment newer than the cutoff is never enqueued", async () => {
    seed({ createdAt: RECENT });

    await sweep();

    // The producer may still be mid-flight, or the worker simply has not
    // reached it. Reconciling here would chase work already in hand.
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("the cutoff decides, not the wall clock", async () => {
    const older = seed({ createdAt: OLD });
    seed({ createdAt: RECENT });

    await sweep();

    expect(enqueuedIds()).toEqual([older.id]);
  });

  test("a mixed table yields exactly the stranded rows", async () => {
    const pending = seed();
    const processing = seed({ processingStatus: "processing" });
    const unparsed = seed({ processingStatus: "completed" });

    seed({ processingStatus: "completed", parsedAt: OLD });
    seed({ processingStatus: "completed", parsingError: "corrupt pdf" });
    seed({ processingStatus: "completed", mimeType: PNG });
    seed({ processingStatus: "failed" });
    seed({ createdAt: RECENT });

    const result = await sweep();

    expect(enqueuedIds()).toEqual(
      [pending.id, processing.id, unparsed.id].sort(),
    );
    expect(result.enqueued).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * Idempotence and bounds.
 * ------------------------------------------------------------------ */

describe("repeated sweeps stay bounded", () => {
  test("a second pass presents the same job identity", async () => {
    const orphan = seed();

    await sweep();
    await sweep();

    // Reconciliation runs repeatedly while a row stays unfinished — the worker,
    // not the reconciler, clears that state. Both passes must therefore address
    // the same attachment, so the deterministic id collapses them into one job
    // instead of accumulating duplicates every cycle.
    expect(mockEnqueue.mock.calls.map(([id]) => id)).toEqual([
      orphan.id,
      orphan.id,
    ]);
  });

  test("the batch size bounds one sweep", async () => {
    seed();
    seed();
    seed();

    const result = await reconcileOrphanedAttachments({
      olderThan: CUTOFF,
      batchSize: 2,
    });

    // The bound is enforced in the query, not by slicing afterwards: an
    // unbounded read of a large standing backlog is the cost this exists to
    // avoid.
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 }),
    );
    expect(result.enqueued).toBe(2);
  });

  test("the remainder stays eligible for the next sweep", async () => {
    seed({ createdAt: OLDER });
    seed({ createdAt: OLD });

    await reconcileOrphanedAttachments({ olderThan: CUTOFF, batchSize: 1 });

    // Nothing was marked done — the reconciler writes no lifecycle column — so
    // the row it did not reach is still there, and oldest-first ordering means
    // sweeps make progress rather than re-scanning the same head.
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "asc" } }),
    );
    expect(mockAttachments).toHaveLength(2);
  });

  test("the sweep reads with the cutoff it was given", async () => {
    seed();

    await sweep();

    expect(mockFindMany.mock.calls[0][0].where).toMatchObject({
      createdAt: { lt: CUTOFF },
    });
  });
});

/* ------------------------------------------------------------------ *
 * Failure. Every path must fail closed.
 * ------------------------------------------------------------------ */

describe("failures never produce a duplicate-work storm", () => {
  test("an enqueue rejection leaves the row untouched and is not counted", async () => {
    const orphan = seed();
    mockEnqueue.mockRejectedValueOnce(new Error("Redis unreachable"));

    const result = await sweep();

    expect(result.enqueued).toBe(0);

    // The row keeps every lifecycle column it had. Marking it processed here
    // would erase the only evidence that the work is still owed.
    expect(mockAttachments[0]).toMatchObject({
      id: orphan.id,
      processingStatus: "pending",
      parsedAt: null,
      parsingError: null,
    });
  });

  test("one enqueue failure does not abort the batch", async () => {
    seed();
    const second = seed();
    const third = seed();

    mockEnqueue.mockRejectedValueOnce(new Error("Redis unreachable"));

    const result = await sweep();

    // A Redis blip on one row must not strand every row behind it.
    expect(enqueuedIds()).toEqual([1, second.id, third.id].sort());
    expect(result.enqueued).toBe(2);
  });

  test("a repository failure produces zero enqueues", async () => {
    seed();

    const { prisma } = jest.requireMock("../../../lib/prisma") as {
      prisma: { attachment: { findMany: jest.Mock } };
    };

    prisma.attachment.findMany.mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(sweep()).rejects.toThrow("database unavailable");

    // Fails CLOSED, and by construction: the row list is the only input, so an
    // unavailable database can never become "enqueue everything". The
    // scheduler's outer boundary is what keeps the interval alive.
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("nothing sensitive reaches the logs", async () => {
    const SECRET_FILENAME = "Confidential-Shortlist-2026.pdf";
    const gaxiosLike = Object.assign(new Error("invalid_grant"), {
      config: { headers: { Authorization: "Bearer 1//0gSuperSecretToken" } },
    });

    seed({ filename: SECRET_FILENAME });
    mockEnqueue.mockRejectedValueOnce(gaxiosLike);

    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await sweep();

    expect(errorSpy).toHaveBeenCalledTimes(1);

    // IDENTITY first: the error object itself must never reach the logger. An
    // error is a bag, and checking only for absent secrets would depend on this
    // test having guessed what the next library hangs off one.
    for (const argument of errorSpy.mock.calls[0]) {
      expect(argument).not.toBe(gaxiosLike);
    }

    const serialized = JSON.stringify(errorSpy.mock.calls);

    expect(serialized).not.toContain(SECRET_FILENAME);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("SuperSecretToken");

    // The attachment id and the message DO survive — enough to act on.
    expect(serialized).toContain("invalid_grant");
    expect(serialized).toContain("1");

    errorSpy.mockRestore();
  });
});

/* ------------------------------------------------------------------ *
 * The reconciler is a discovery mechanism and nothing more.
 * ------------------------------------------------------------------ */

describe("the reconciler never writes lifecycle state", () => {
  test("no attachment column is mutated by a sweep", async () => {
    seed();
    seed({ processingStatus: "processing" });
    seed({ processingStatus: "completed" });

    const before = mockAttachments.map((row) => ({ ...row }));

    await sweep();

    // `processingStatus`, `parsedAt` and `parsingError` belong to the worker. A
    // second writer would make that lifecycle ambiguous, and the whole recovery
    // model depends on the row still saying the work is owed.
    expect(mockAttachments).toEqual(before);
  });

  test("the repository is read through findMany alone", async () => {
    seed();

    const { prisma } = jest.requireMock("../../../lib/prisma") as {
      prisma: { attachment: Record<string, unknown> };
    };

    await sweep();

    // The mock exposes no update verb at all, so any write would have thrown.
    // Stated explicitly so the guarantee survives someone adding one later.
    expect(Object.keys(prisma.attachment)).toEqual(["findMany"]);
  });
});
