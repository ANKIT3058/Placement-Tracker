// F-3e RED (part 1 of 2) — the producer side of email-processing recovery.
//
// Every email reaches the worker through the same two-step shape:
//
//     createEmail()            → Postgres COMMIT
//     enqueueEmailProcessing() → Redis
//
// Postgres and Redis cannot share a transaction, so the window between them is
// unavoidable. What is NOT acceptable is what the window currently leaves
// behind: the row commits with `processingStatus: "pending"`, the enqueue
// rejects, and no job is ever created. `getEmailByGmailMessageId` then
// short-circuits every future sync of that message, and the Gmail watermark has
// already advanced past it — so the email is stored and never processed, with
// nothing recording that anything went wrong.
//
// TWO PRODUCERS, not one. Gmail sync (`syncSingleMessage`) and the manual
// `POST /email` route both persist-then-enqueue, and a fix that covered only
// the Gmail path would leave manual emails permanently unrecoverable — they
// carry `gmailMessageId: null`, so Gmail replay cannot reach them even in
// principle.
//
// THE CONTRACT THIS FILE PINS:
//
//   1. A failed enqueue leaves the row persisted and `pending` — recoverable
//      state, deliberately not rolled back.
//   2. Every email job carries `jobId: email-${emailId}`.
//
// (2) is not an implementation detail. It is what makes reconciliation safe:
// BullMQ refuses a second `add` while a job with that id exists, so a
// reconciliation pass that races the normal producer — or that runs during the
// crash window after `queue.add` succeeded — cannot create a duplicate job.
// Without it, every false positive becomes a real second job.

const mockAdd = jest.fn(async () => ({ id: "1" }));

jest.mock("../../../infrastructure/queue/queues", () => ({
  emailQueue: { add: mockAdd },
  attachmentQueue: { add: jest.fn(async () => ({ id: "1" })) },
}));

type Row = Record<string, unknown>;

const mockEmails: Row[] = [];

jest.mock("../../../lib/prisma", () => ({
  prisma: {
    email: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row: Row = {
          id: mockEmails.length + 1,
          // The schema default. Modelled here because the orphan state IS this
          // value surviving a failed enqueue.
          processingStatus: "pending",
          failureReason: null,
          createdAt: new Date(),
          ...data,
        };

        mockEmails.push(row);

        return row;
      }),
      findUnique: jest.fn(
        async ({ where }: { where: { gmailMessageId?: string } }) =>
          mockEmails.find(
            (row) =>
              where.gmailMessageId !== undefined &&
              row.gmailMessageId === where.gmailMessageId,
          ) ?? null,
      ),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
    },
  },
}));

jest.mock("../../gmail/gmail.service", () => ({
  ...jest.requireActual("../../gmail/gmail.service"),
  getMessageDetails: jest.fn(async () => ({
    id: "gmail-msg-1",
    snippet: "snippet",
    payload: { headers: [], body: {} },
  })),
}));

// AC-5.9: POST /email is authenticated. This suite is about the enqueue
// boundary, not authentication, so the middleware supplies a caller.
jest.mock("../../auth/auth.middleware", () => ({
  requireAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.user = { id: 7, publicId: "u", googleSub: "s", email: "u@x", name: null, imageUrl: null };
    next();
  },
}));

import request from "supertest";

import app from "../../../app";
import { enqueueEmailProcessing } from "../email.producer";
import { syncSingleMessage } from "../../gmail/gmail.sync.service";
import { browserWithToken, CSRF_HEADER } from "../../../__tests__/helpers/csrf";

const optionsOf = (call: unknown[]) => call[2] as Record<string, unknown>;

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();

  mockEmails.length = 0;
  mockAdd.mockImplementation(async () => ({ id: "1" }));

  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

/* ------------------------------------------------------------------ *
 * The job identity that makes recovery safe.
 * ------------------------------------------------------------------ */

describe("an email processing job is identified by its email", () => {
  test("the job carries a deterministic id derived from the email", async () => {
    await enqueueEmailProcessing({ emailId: 42, userId: 7 });

    expect(mockAdd).toHaveBeenCalledTimes(1);

    // The reliability contract, not a naming preference. BullMQ refuses a
    // second `add` while a job with this id exists (verified against the
    // installed 5.81.3: `addStandardJob` returns early when the job hash is
    // present), which is what lets reconciliation run without risking a
    // duplicate job for an email that already has one.
    expect(optionsOf(mockAdd.mock.calls[0] as unknown[])).toMatchObject({
      jobId: "email-42",
    });
  });

  test("two enqueues of the same email present the same id", async () => {
    // The crash window: `queue.add` succeeded but nothing recorded it, so a
    // later reconciliation pass enqueues the same email again. Both calls must
    // present the identical id, because that identity is the only thing
    // standing between this window and a duplicate job.
    await enqueueEmailProcessing({ emailId: 42, userId: 7 });
    await enqueueEmailProcessing({ emailId: 42, userId: 7 });

    const [first, second] = mockAdd.mock.calls as unknown[][];

    expect(optionsOf(first)).toMatchObject({ jobId: "email-42" });
    expect(optionsOf(second)).toMatchObject({ jobId: "email-42" });
    expect(optionsOf(first).jobId).toBe(optionsOf(second).jobId);
  });

  test("different emails are never conflated", async () => {
    await enqueueEmailProcessing({ emailId: 42, userId: 7 });
    await enqueueEmailProcessing({ emailId: 43, userId: 7 });

    const ids = (mockAdd.mock.calls as unknown[][]).map(
      (call) => optionsOf(call).jobId,
    );

    expect(ids).toEqual(["email-42", "email-43"]);
  });
});

/* ------------------------------------------------------------------ *
 * Producer A — Gmail sync.
 * ------------------------------------------------------------------ */

describe("a failed enqueue during Gmail sync leaves recoverable state", () => {
  test("the email stays persisted and pending", async () => {
    mockAdd.mockRejectedValue(new Error("Redis unavailable"));

    const account = {
      id: 1,
      email: "mailbox@college.edu",
      refreshToken: "REFRESH",
      historyId: null,
      userId: 7,
    };

    await expect(
      syncSingleMessage(account as never, "gmail-msg-1"),
    ).rejects.toThrow("Redis unavailable");

    // Deliberately NOT a rollback assertion. The approved architecture accepts
    // "committed but unqueued" as recoverable state — the row is the evidence
    // reconciliation works from, and discarding it would turn a recoverable
    // failure into real data loss.
    expect(mockEmails).toHaveLength(1);
    expect(mockEmails[0]).toMatchObject({
      gmailMessageId: "gmail-msg-1",
      userId: 7,
      processingStatus: "pending",
    });
  });
});

/* ------------------------------------------------------------------ *
 * Producer B — the manual route. No Gmail replay exists for these at all.
 * ------------------------------------------------------------------ */

describe("a failed enqueue during manual ingestion leaves recoverable state", () => {
  const post = async () => {
    const { agent, token } = await browserWithToken(app);

    return agent.post("/email").set(CSRF_HEADER, token).send({
      subject: "Amazon OA",
      body: "Amazon OA on 20th Aug",
      sender: "tpo@college.edu",
    });
  };

  test("the email stays persisted and pending", async () => {
    mockAdd.mockRejectedValue(new Error("Redis unavailable"));

    await post();

    // `gmailMessageId` is null here, so no Gmail sync will ever re-present this
    // message. Reconciliation is the ONLY possible recovery path for a manually
    // ingested email.
    expect(mockEmails).toHaveLength(1);
    expect(mockEmails[0]).toMatchObject({
      userId: 7,
      processingStatus: "pending",
    });
    expect(mockEmails[0]?.gmailMessageId).toBeUndefined();
  });

  test("the caller is told the request failed", async () => {
    mockAdd.mockRejectedValue(new Error("Redis unavailable"));

    const response = await post();

    // Asserted separately from the persistence invariant: the caller learning
    // of the failure and the row remaining recoverable are two different
    // properties, and a fix must not trade one for the other.
    expect(response.status).toBe(500);
  });
});
