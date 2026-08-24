// createEvent is a check-then-insert against `@@unique([userId, eventKey])`
// (AC-5.11). The lookup and the insert are two separate statements, so a
// concurrent execution — a stalled BullMQ job replaying alongside the
// original attempt, or a second email producing the same identity key — can
// pass the lookup and still lose the race on the insert. The database is the
// concurrency authority: a P2002 on THIS constraint means the other
// execution's row is the correct answer, so it is re-read and returned
// rather than failing the caller. A P2002 on any other constraint is a
// different conflict entirely and must still surface.
//
// Modelled with a fake store rather than a real database for the same reason
// extraction.idempotency.test.ts gives: there is no local Postgres in this
// repository, and `backend/.env` points at production. The fake enforces the
// `(userId, eventKey)` uniqueness itself, so a wrong-key implementation fails
// this suite for the right reason.

type Row = {
  id: number;
  userId: number;
  company: string;
  stage: string;
  date: Date;
  time: string | null;
  venue: string | null;
  eventKey: string;
  confidence: number;
  status: string;
  reviewReason: string | null;
};

const rows: Row[] = [];

const findByKey = (userId: number, eventKey: string) =>
  rows.find((row) => row.userId === userId && row.eventKey === eventKey);

// Shaped like the error Prisma raises on a unique-constraint violation
// (`code` + `meta.target`), matching the convention already used by
// extraction.idempotency.test.ts for the same kind of error. The repository
// checks this shape structurally rather than via `instanceof`, so a plain
// object is a faithful stand-in for a real Prisma error here.
const eventKeyConflict = () => {
  const error = new Error(
    "Unique constraint failed on the fields: (`userId`,`eventKey`)",
  ) as Error & { code: string; meta: { target: string[] } };

  error.code = "P2002";
  error.meta = { target: ["userId", "eventKey"] };

  return error;
};

const unrelatedConflict = () => {
  const error = new Error(
    "Unique constraint failed on the fields: (`gmailMessageId`)",
  ) as Error & { code: string; meta: { target: string[] } };

  error.code = "P2002";
  error.meta = { target: ["gmailMessageId"] };

  return error;
};

const findUniqueMock = jest.fn(
  async ({
    where: { userId_eventKey },
  }: {
    where: { userId_eventKey: { userId: number; eventKey: string } };
  }) => findByKey(userId_eventKey.userId, userId_eventKey.eventKey) ?? null,
);

const createMock = jest.fn(
  async ({ data }: { data: Record<string, unknown> }) => {
    const userId = data.userId as number;
    const eventKey = data.eventKey as string;

    if (findByKey(userId, eventKey)) {
      throw eventKeyConflict();
    }

    const row: Row = {
      id: rows.length + 1,
      userId,
      company: data.company as string,
      stage: data.stage as string,
      date: data.date as Date,
      time: (data.time as string) ?? null,
      venue: (data.venue as string) ?? null,
      eventKey,
      confidence: data.confidence as number,
      status: data.status as string,
      reviewReason: (data.reviewReason as string) ?? null,
    };

    rows.push(row);
    return row;
  },
);

jest.mock("../../../lib/prisma", () => ({
  prisma: {
    event: {
      findUnique: (...args: unknown[]) =>
        (findUniqueMock as unknown as (...a: unknown[]) => unknown)(...args),
      create: (...args: unknown[]) =>
        (createMock as unknown as (...a: unknown[]) => unknown)(...args),
    },
  },
}));

import { createEvent } from "../event.repository";

const USER_A = { userId: 1 };
const USER_B = { userId: 2 };

const INPUT = {
  company: "amazon",
  stage: "OA",
  date: "2026-09-01",
  time: "10:00",
  venue: "zoom",
  confidence: 0.9,
};

const EVENT_KEY = "amazon|OA|2026-09-01";

describe("createEvent", () => {
  beforeEach(() => {
    rows.length = 0;
    jest.clearAllMocks();
  });

  // A. Existing event.
  test("returns the existing Event and never calls create", async () => {
    const existing: Row = {
      id: 99,
      userId: USER_A.userId,
      company: "amazon",
      stage: "OA",
      date: new Date("2026-09-01"),
      time: "10:00",
      venue: "zoom",
      eventKey: EVENT_KEY,
      confidence: 0.9,
      status: "scheduled",
      reviewReason: null,
    };
    rows.push(existing);

    const result = await createEvent(USER_A, INPUT, EVENT_KEY);

    expect(result).toBe(existing);
    expect(createMock).not.toHaveBeenCalled();
  });

  // B. Normal creation.
  test("creates and returns a new Event when none exists", async () => {
    const result = await createEvent(USER_A, INPUT, EVENT_KEY);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      userId: USER_A.userId,
      eventKey: EVENT_KEY,
      company: "amazon",
      stage: "OA",
    });
    expect(rows).toHaveLength(1);
  });

  // C. Concurrent/conflict simulation.
  test("recovers the other execution's row when the insert loses the race", async () => {
    // Simulates a second execution's row landing in the window between this
    // call's lookup and its insert: the lookup found nothing, but by the
    // time `create` runs, the row already exists.
    const racedRow: Row = {
      id: 5,
      userId: USER_A.userId,
      company: "amazon",
      stage: "OA",
      date: new Date("2026-09-01"),
      time: "10:00",
      venue: "zoom",
      eventKey: EVENT_KEY,
      confidence: 0.9,
      status: "scheduled",
      reviewReason: null,
    };

    createMock.mockImplementationOnce(async () => {
      rows.push(racedRow);
      throw eventKeyConflict();
    });

    const result = await createEvent(USER_A, INPUT, EVENT_KEY);

    expect(result).toEqual(racedRow);
    expect(createMock).toHaveBeenCalledTimes(1);
    // Re-read happened: findUnique was called for the initial lookup and
    // again for the post-conflict recovery.
    expect(findUniqueMock).toHaveBeenCalledTimes(2);
  });

  // D. Unrelated P2002.
  test("rethrows a P2002 on an unrelated constraint instead of retrying", async () => {
    createMock.mockImplementationOnce(async () => {
      throw unrelatedConflict();
    });

    await expect(createEvent(USER_A, INPUT, EVENT_KEY)).rejects.toMatchObject(
      { code: "P2002" },
    );

    expect(rows).toHaveLength(0);
    // No recovery re-read: the second findUnique here would only be the
    // race-recovery call, which must not happen for a different constraint.
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
  });

  // E. Cross-user regression.
  test("allows two different users to hold the same eventKey", async () => {
    const resultA = await createEvent(USER_A, INPUT, EVENT_KEY);
    const resultB = await createEvent(USER_B, INPUT, EVENT_KEY);

    expect(resultA.userId).toBe(USER_A.userId);
    expect(resultB.userId).toBe(USER_B.userId);
    expect(resultA.id).not.toBe(resultB.id);
    expect(rows).toHaveLength(2);
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});
