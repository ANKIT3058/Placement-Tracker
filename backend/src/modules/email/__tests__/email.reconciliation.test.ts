// F-3e RED (part 2 of 2) — recovering an email that was persisted but never queued.
//
// `createEmail` commits to Postgres, then `enqueueEmailProcessing` writes to
// Redis. The two cannot share a transaction, so when the enqueue fails the row
// is left `pending` with no job behind it. Nothing today looks for that state:
// `getPendingEmails` exists in the repository and is called from nowhere, the
// Gmail dedupe short-circuits every replay of the message, and the sync
// watermark has already moved past it. Manual emails are worse still — they
// carry `gmailMessageId: null`, so Gmail replay could not reach them even if
// the watermark had not moved.
//
// THE CONTRACT THIS FILE SPECIFIES:
//
//     persisted + pending + no live job + old enough
//         ↓
//     reconcilePendingEmails({ olderThan })
//         ↓
//     enqueueEmailProcessing({ emailId, userId })   ← the row's OWN owner
//         ↓
//     jobId email-${emailId}  ⇒ BullMQ dedupes a racing duplicate
//
// The cutoff is injected rather than read from a clock, so no test waits on
// real time and no arbitrary production duration is baked into the suite.
//
// WHAT IS NOT SPECIFIED HERE. Exactly-once processing is not the target and is
// not achievable across Postgres and Redis. The guarantee is eventual
// processing with at-least-once delivery: the deterministic job id suppresses
// duplicate JOBS, and the one non-idempotent side effect that survives a double
// run — a second `EmailExtraction` row — is inert, since nothing reads that
// table. Making extraction idempotent is a separate concern and deliberately
// not required by these tests.
//
// The module under specification does not exist yet, so each test loads it
// lazily: the failure then names the missing capability per test rather than
// collapsing the whole file at import.

type Row = Record<string, unknown>;

const mockEmails: Row[] = [];

jest.mock("../../../lib/prisma", () => ({
  prisma: {
    email: {
      findMany: jest.fn(async (args?: { where?: Record<string, unknown> }) => {
        const where = args?.where ?? {};

        return mockEmails.filter((row) =>
          Object.entries(where).every(([column, predicate]) => {
            // Prisma range filters arrive as objects; only `lt` is needed here.
            if (
              predicate !== null &&
              typeof predicate === "object" &&
              "lt" in (predicate as Record<string, unknown>)
            ) {
              const bound = (predicate as { lt: Date }).lt;
              return (row[column] as Date) < bound;
            }

            return (row[column] ?? null) === (predicate ?? null);
          }),
        );
      }),
      findUnique: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Row }) => data),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  },
}));

type EnqueueArgs = { emailId: number; userId?: number | null };

// Typed so the recorded call arguments can be asserted directly.
const mockEnqueue = jest.fn(async (_data: EnqueueArgs) => undefined);

jest.mock("../email.producer", () => ({
  enqueueEmailProcessing: mockEnqueue,
}));

// Gmail is unavailable for the whole suite. Reconciliation must work from the
// database alone — the original failure can happen after the sync watermark has
// advanced, so anything that reached for Gmail would be unable to recover.
jest.mock("../../gmail/gmail.service", () => ({
  getMessageDetails: jest.fn(async () => {
    throw new Error("Gmail must not be contacted during reconciliation");
  }),
  getRecentMessages: jest.fn(async () => {
    throw new Error("Gmail must not be contacted during reconciliation");
  }),
  getLatestHistoryId: jest.fn(async () => {
    throw new Error("Gmail must not be contacted during reconciliation");
  }),
  getHistoryChanges: jest.fn(async () => {
    throw new Error("Gmail must not be contacted during reconciliation");
  }),
}));

type Reconciler = {
  reconcilePendingEmails: (options: {
    olderThan: Date;
  }) => Promise<{ enqueued: number }>;
};

/* Loaded per test so an absent module fails each test with a message naming
   what is missing, rather than aborting the file before any test runs. */
const loadReconciler = (): Reconciler =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../email.reconciler") as Reconciler;

const NOW = new Date("2026-08-23T12:00:00.000Z");
const CUTOFF = new Date("2026-08-23T11:55:00.000Z");
const OLD = new Date("2026-08-23T11:00:00.000Z");
const RECENT = new Date("2026-08-23T11:59:00.000Z");

const seed = (overrides: Row = {}): Row => {
  const row: Row = {
    id: mockEmails.length + 1,
    userId: 7,
    gmailMessageId: `gmail-${mockEmails.length + 1}`,
    processingStatus: "pending",
    createdAt: OLD,
    ...overrides,
  };

  mockEmails.push(row);

  return row;
};

const enqueuedArgs = (): EnqueueArgs[] =>
  mockEnqueue.mock.calls.map(([data]) => data);

const enqueuedIds = () => enqueuedArgs().map((arg) => arg.emailId).sort();

beforeEach(() => {
  jest.clearAllMocks();
  mockEmails.length = 0;
});

/* ------------------------------------------------------------------ *
 * Discovery. The orphan must be found and queued.
 * ------------------------------------------------------------------ */

describe("an orphaned email is recovered", () => {
  test("a stale pending email is enqueued exactly once", async () => {
    const orphan = seed();

    const { reconcilePendingEmails } = loadReconciler();

    const result = await reconcilePendingEmails({ olderThan: CUTOFF });

    expect(enqueuedIds()).toEqual([orphan.id]);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(result.enqueued).toBe(1);
  });

  test("every orphan is recovered, not just the first", async () => {
    const first = seed();
    const second = seed();

    const { reconcilePendingEmails } = loadReconciler();

    await reconcilePendingEmails({ olderThan: CUTOFF });

    // An implementation that stopped after one row would leave a backlog that
    // never drains — a Redis outage orphans every email synced during it, not
    // one.
    expect(enqueuedIds()).toEqual([first.id, second.id].sort());
  });

  test("a second pass presents the same job identity", async () => {
    const orphan = seed();

    const { reconcilePendingEmails } = loadReconciler();

    await reconcilePendingEmails({ olderThan: CUTOFF });
    await reconcilePendingEmails({ olderThan: CUTOFF });

    // Reconciliation is expected to run repeatedly while the row stays pending
    // — the worker, not the reconciler, clears the status. Both passes must
    // therefore address the same email, so the deterministic job id collapses
    // them into one job instead of accumulating duplicates every cycle.
    expect(enqueuedArgs().map((arg) => arg.emailId)).toEqual([
      orphan.id,
      orphan.id,
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * The staleness boundary.
 * ------------------------------------------------------------------ */

describe("a freshly created email is left alone", () => {
  test("a pending email newer than the cutoff is not enqueued", async () => {
    seed({ createdAt: RECENT });

    const { reconcilePendingEmails } = loadReconciler();

    const result = await reconcilePendingEmails({ olderThan: CUTOFF });

    // The normal producer is still mid-flight here: the row committed moments
    // ago and its enqueue may not have run yet. Reconciling it would race the
    // producer for no benefit.
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(result.enqueued).toBe(0);
  });

  test("the cutoff decides, not the wall clock", async () => {
    const older = seed({ createdAt: OLD });
    seed({ createdAt: RECENT });

    const { reconcilePendingEmails } = loadReconciler();

    await reconcilePendingEmails({ olderThan: CUTOFF });

    // The cutoff is a parameter, so the window is a deployment decision rather
    // than a constant baked into the code — and no test has to wait for one.
    expect(enqueuedIds()).toEqual([older.id]);
    expect(NOW > CUTOFF).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Rows that already reached the worker must be left untouched.
 * ------------------------------------------------------------------ */

describe("only unqueued work is reconciled", () => {
  test("a failed email is never re-enqueued", async () => {
    seed({ processingStatus: "failed", failureReason: "extraction failed" });

    const { reconcilePendingEmails } = loadReconciler();

    await reconcilePendingEmails({ olderThan: CUTOFF });

    // The worker sets `failed` before BullMQ exhausts its attempts, so a failed
    // row always has a job — and with `removeOnFail: false` that job's id is
    // retained, meaning a re-enqueue would be silently swallowed anyway.
    // Selecting these rows would produce a reconciliation loop that appears to
    // work and accomplishes nothing.
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("completed and in-flight emails are ignored", async () => {
    const orphan = seed();
    seed({ processingStatus: "completed" });
    seed({ processingStatus: "processing" });
    seed({ processingStatus: "ignored" });

    const { reconcilePendingEmails } = loadReconciler();

    await reconcilePendingEmails({ olderThan: CUTOFF });

    // `processing` matters most: the worker has the job in hand. Re-enqueueing
    // it would be a duplicate attempt at work already underway.
    expect(enqueuedIds()).toEqual([orphan.id]);
  });
});

/* ------------------------------------------------------------------ *
 * Ownership travels with the row, never with a fabricated context.
 * ------------------------------------------------------------------ */

describe("each email is recovered as its own owner", () => {
  test("emails from different users keep their own ownership", async () => {
    const mine = seed({ userId: 7 });
    const theirs = seed({ userId: 9 });

    const { reconcilePendingEmails } = loadReconciler();

    await reconcilePendingEmails({ olderThan: CUTOFF });

    // Reconciliation is background work with no caller to derive a tenant from,
    // exactly like the Gmail scheduler. The answer is the same one the codebase
    // already uses: read globally, then carry each row's own owner forward. A
    // fabricated or shared owner would attribute one user's email to another.
    expect(enqueuedArgs()).toEqual(
      expect.arrayContaining([
        { emailId: mine.id, userId: 7 },
        { emailId: theirs.id, userId: 9 },
      ]),
    );
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ *
 * The case Gmail can never reach.
 * ------------------------------------------------------------------ */

describe("a manually ingested email is recoverable", () => {
  test("an email with no Gmail message id is enqueued", async () => {
    const manual = seed({ gmailMessageId: null });

    const { reconcilePendingEmails } = loadReconciler();

    await reconcilePendingEmails({ olderThan: CUTOFF });

    // THE PROOF THAT THIS IS NOT A GMAIL FIX. A manual email has no Gmail
    // message behind it, so no sync will ever re-present it. If reconciliation
    // filtered on `gmailMessageId`, this row would be stranded forever.
    expect(enqueuedIds()).toEqual([manual.id]);
  });

  test("recovery works while Gmail is entirely unavailable", async () => {
    const orphan = seed();

    const { reconcilePendingEmails } = loadReconciler();

    // Every Gmail helper in this suite throws if called. Reaching for Gmail
    // here would be doubly wrong: the watermark has already advanced past the
    // message, and the outage that caused the orphan may still be ongoing.
    await expect(
      reconcilePendingEmails({ olderThan: CUTOFF }),
    ).resolves.toMatchObject({ enqueued: 1 });

    expect(enqueuedIds()).toEqual([orphan.id]);
  });
});
