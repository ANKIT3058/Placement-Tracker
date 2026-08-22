// PR-3 RED — the manual Event PATCH contract.
//
// `PATCH /event/:id` is the human-review correction endpoint: the reviewer
// fixes a mis-extracted company or round and confirms the Event. Its two
// editable fields are the two the review UI exposes (`ReviewCard.tsx`), and
// everything else about the row is the server's to decide — ownership,
// identity, provenance timestamps, and the confirmation semantics themselves.
//
// Today the service spreads `req.body` straight into the Prisma update payload
// (`event.service.ts:249`), so every real Event column is client-writable. The
// contract these tests establish is an explicit allowlist:
//
//     { company?: string; stage?: string }   — at least one present
//
// with any forbidden or unknown property rejecting the WHOLE request (400).
// Silently stripping the bad keys would be a weaker contract: it applies the
// caller's allowed fields while quietly discarding the part of the request that
// was refused, so a client that believes it moved an Event across tenants gets
// a 200 and no correction.
//
// The suite runs at the HTTP layer because the status codes ARE the contract,
// and it asserts persisted state rather than call arguments, because "the row
// did not move" is the actual claim — an assertion on what Prisma was called
// with cannot distinguish a refused write from an applied one.

const USER_A = 1;
const USER_B = 2;

const EVENT_A = 10;
const EVENT_B = 20;

// Which user the stubbed `requireAuth` presents. Read per-request, so tests can
// switch tenants between calls.
let mockCurrentUserId: number;

// In-memory Prisma double, backed by real tables.
//
// Bare `jest.fn()`s cannot answer the question this suite asks. "The allowlist
// dropped userId" and "userId was written and happened to equal the old value"
// are indistinguishable by call arguments. Applying the writes for real makes
// "Event A still belongs to User A" an observation instead of an assumption.
jest.mock("../../../lib/prisma", () => {
  type Row = Record<string, unknown>;

  const events: Row[] = [];
  const eventUpdates: Row[] = [];

  // The columns Prisma would accept for an Event write. Anything else raises a
  // PrismaClientValidationError in the real client — verified against the
  // generated client — which is why an unknown key currently produces a 500
  // rather than passing silently through.
  const EVENT_COLUMNS = new Set([
    "id",
    "userId",
    "company",
    "stage",
    "date",
    "time",
    "venue",
    "eventKey",
    "confidence",
    "status",
    "reviewReason",
    "isTimeEstimated",
    "createdAt",
    "updatedAt",
  ]);

  const matches = (row: Row, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  const assertKnownColumns = (data: Record<string, unknown>) => {
    for (const key of Object.keys(data)) {
      if (!EVENT_COLUMNS.has(key)) {
        const error: any = new Error(
          "Invalid `prisma.event.update()` invocation: Unknown argument `" +
            key +
            "`.",
        );
        error.name = "PrismaClientValidationError";
        throw error;
      }
    }
  };

  return {
    prisma: {
      // Test-only handles on the backing tables.
      __events: events,
      __eventUpdates: eventUpdates,
      event: {
        findFirst: jest.fn(
          async ({ where }: any) => events.find((r) => matches(r, where)) ?? null,
        ),
        findMany: jest.fn(async ({ where }: any) =>
          events.filter((r) => matches(r, where)),
        ),
        update: jest.fn(async ({ where, data }: any) => {
          const row = events.find((r) => matches(r, where));

          if (!row) {
            const error: any = new Error(
              "An operation failed because it depends on one or more records that were required but not found.",
            );
            error.code = "P2025";
            throw error;
          }

          assertKnownColumns(data);

          const before = { ...row };
          Object.assign(row, data);

          // FK `EventUpdate_eventId_userId_fkey` — (eventId, userId) references
          // Event(id, userId) ON UPDATE CASCADE, added by migration
          // 20260802030000_require_ownership. Modelled here because it is the
          // mechanism that carries an Event's history along when its owner
          // changes: without it, a test asserting "the history stayed with
          // User A" would pass for the wrong reason.
          if (row.id !== before.id || row.userId !== before.userId) {
            eventUpdates
              .filter(
                (u) => u.eventId === before.id && u.userId === before.userId,
              )
              .forEach((u) => {
                u.eventId = row.id;
                u.userId = row.userId;
              });
          }

          return row;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const matched = events.filter((r) => matches(r, where));
          matched.forEach((row) => Object.assign(row, data));
          return { count: matched.length };
        }),
        create: jest.fn(),
      },
      eventUpdate: {
        create: jest.fn(async ({ data }: any) => {
          eventUpdates.push({ id: eventUpdates.length + 1, ...data });
          return data;
        }),
        findMany: jest.fn(async ({ where }: any) =>
          eventUpdates.filter((r) => matches(r, where)),
        ),
      },
      $transaction: jest.fn(),
    },
  };
});

// Keeps `import app` from constructing the real BullMQ queue (and its ioredis
// connection), matching the existing API suite.
jest.mock("../../../infrastructure/queue/queues", () => ({
  emailQueue: { add: jest.fn() },
}));

// This suite is about the update contract, not about authentication. The real
// middleware's admit/refuse behaviour is exercised where it lives; here a stub
// supplies the caller so the tenant can be switched between requests.
jest.mock("../../auth/auth.middleware", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: mockCurrentUserId,
      publicId: "user-" + mockCurrentUserId,
      googleSub: "sub-" + mockCurrentUserId,
      email: "user" + mockCurrentUserId + "@example.com",
      name: null,
      imageUrl: null,
    };
    next();
  },
}));

import app from "../../../app";
import { browserWithToken, CSRF_HEADER } from "../../../__tests__/helpers/csrf";
import { prisma } from "../../../lib/prisma";

type Row = Record<string, unknown>;

const events = (prisma as any).__events as Row[];
const eventUpdates = (prisma as any).__eventUpdates as Row[];

const CREATED_AT = new Date("2026-08-01T00:00:00.000Z");
const UPDATED_AT = new Date("2026-08-10T00:00:00.000Z");

const eventRow = (overrides: Row = {}): Row => ({
  id: EVENT_A,
  userId: USER_A,
  company: "Old Company",
  stage: "OA",
  date: new Date("2026-09-01T00:00:00.000Z"),
  time: "10:00",
  venue: null,
  eventKey: "old company|OA|2026-09-01",
  confidence: 0.4,
  status: "review",
  reviewReason: "Low confidence: missing venue",
  isTimeEstimated: false,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  ...overrides,
});

const seed = () => {
  events.length = 0;
  eventUpdates.length = 0;

  events.push(
    eventRow(),
    // A second tenant's Event, so cross-tenant cases have a real neighbour
    // rather than an empty table.
    eventRow({
      id: EVENT_B,
      userId: USER_B,
      company: "Other Company",
      eventKey: "other company|OA|2026-09-01",
    }),
  );

  // Event A has history, owned by the same User. This is what the cascade would
  // carry across tenants if an ownership write were ever allowed through.
  eventUpdates.push({
    id: 1,
    userId: USER_A,
    eventId: EVENT_A,
    field: "time",
    oldValue: "null",
    newValue: "10:00",
  });
};

const event = (id: number): Row => events.find((r) => r.id === id)!;
const history = (): Row[] => eventUpdates;

/* PR-8B. `PATCH /event/:id` is behind `requireCsrf` now, so a bare
   `request(app)` — no cookie jar, no `X-CSRF-Token` — is refused with 403
   before the controller runs, and every assertion below would be measuring a
   refusal instead of the allowlist contract.

   Each call therefore builds a legitimate browser: an ordinary read to be
   issued `placement.csrf`, then that token echoed back. The middleware is real
   and is not bypassed; only the request is made the way a browser makes it. */
const patch = async (id: number, body: unknown) => {
  const { agent, token } = await browserWithToken(app);

  return agent
    .patch("/event/" + id)
    .set(CSRF_HEADER, token)
    .send(body as object);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentUserId = USER_A;
  seed();
});

// ---------------------------------------------------------------------------
// The endpoint keeps doing its job.
// ---------------------------------------------------------------------------

describe("the reviewer can correct the two editable fields", () => {
  test("accepts a company correction", async () => {
    const res = await patch(EVENT_A, { company: "New Company" });

    expect(res.status).toBe(200);
    expect(event(EVENT_A).company).toBe("New Company");
  });

  test("accepts a stage correction", async () => {
    const res = await patch(EVENT_A, { stage: "Interview" });

    expect(res.status).toBe(200);
    expect(event(EVENT_A).stage).toBe("Interview");
  });

  test("a partial update leaves the other editable field alone", async () => {
    const res = await patch(EVENT_A, { company: "Google" });

    expect(res.status).toBe(200);
    expect(event(EVENT_A)).toMatchObject({
      company: "Google",
      stage: "OA",
    });
  });

  test("confirmation semantics still belong to the server", async () => {
    // The reviewer's answer raises trust to certainty and clears the doubt —
    // values the server sets, not values the client sends.
    await patch(EVENT_A, { company: "Google" });

    expect(event(EVENT_A)).toMatchObject({
      confidence: 1.0,
      status: "confirmed",
      reviewReason: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Ownership. Unchanged behaviour, asserted so the allowlist cannot regress it.
// ---------------------------------------------------------------------------

describe("an Event belonging to another tenant is not found", () => {
  test("answers 404 rather than 403", async () => {
    mockCurrentUserId = USER_B;

    const res = await patch(EVENT_A, { company: "Google" });

    // 404 for both "no such Event" and "not yours" (RFC-001 §9.4): a 403 would
    // confirm the existence of a record the caller may not see, and ids are
    // sequential.
    expect(res.status).toBe(404);
  });

  test("does not mutate the other tenant's Event", async () => {
    mockCurrentUserId = USER_B;

    await patch(EVENT_A, { company: "Google" });

    expect(event(EVENT_A).company).toBe("Old Company");
    expect(event(EVENT_A).userId).toBe(USER_A);
  });
});

// ---------------------------------------------------------------------------
// THE PRIMARY SECURITY REGRESSION.
//
// The caller legitimately owns this Event, so the ownership check passes. What
// must refuse the request is the field contract, not the tenant predicate.
// ---------------------------------------------------------------------------

describe("userId cannot be assigned through the request body", () => {
  test("rejects the request", async () => {
    const res = await patch(EVENT_A, { userId: USER_B });

    expect(res.status).toBe(400);
  });

  test("leaves the Event with its owner", async () => {
    await patch(EVENT_A, { userId: USER_B });

    expect(event(EVENT_A).userId).toBe(USER_A);
  });

  test("leaves the Event's history with its owner", async () => {
    await patch(EVENT_A, { userId: USER_B });

    // The composite FK cascades (eventId, userId) onto EventUpdate, so an
    // ownership write does not merely move the Event — it migrates every
    // history row with it. Both must stay put.
    expect(history()).toHaveLength(1);
    expect(history()[0]).toMatchObject({
      eventId: EVENT_A,
      userId: USER_A,
    });
  });

  test("the Event remains visible to its owner and invisible to the other tenant", async () => {
    await patch(EVENT_A, { userId: USER_B });

    // Dashboard visibility is `findMany WHERE { userId }`, so this is the
    // property the attack actually targets.
    const forOwner = await (prisma as any).event.findMany({
      where: { userId: USER_A },
    });
    const forIntruder = await (prisma as any).event.findMany({
      where: { userId: USER_B },
    });

    expect(forOwner.map((r: Row) => r.id)).toContain(EVENT_A);
    expect(forIntruder.map((r: Row) => r.id)).not.toContain(EVENT_A);
  });

  test("issues no write at all", async () => {
    await patch(EVENT_A, { userId: USER_B });

    expect(prisma.event.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Atomicity: a request is accepted whole or refused whole.
// ---------------------------------------------------------------------------

describe("a request mixing an allowed field with a forbidden one is refused entirely", () => {
  test("rejects the request", async () => {
    const res = await patch(EVENT_A, { company: "Google", userId: USER_B });

    expect(res.status).toBe(400);
  });

  test("does not apply the allowed field", async () => {
    await patch(EVENT_A, { company: "Google", userId: USER_B });

    // Applying `company` while dropping `userId` would answer a request the
    // caller did not make, and would report success for one they did.
    expect(event(EVENT_A).company).toBe("Old Company");
  });

  test("does not apply the forbidden field", async () => {
    await patch(EVENT_A, { company: "Google", userId: USER_B });

    expect(event(EVENT_A).userId).toBe(USER_A);
  });
});

// ---------------------------------------------------------------------------
// Identity is derived, never supplied.
// ---------------------------------------------------------------------------

describe("identity fields cannot be assigned through the request body", () => {
  test("rejects an id", async () => {
    const res = await patch(EVENT_A, { id: EVENT_B });

    expect(res.status).toBe(400);
  });

  test("leaves the row's id alone", async () => {
    await patch(EVENT_A, { id: EVENT_B });

    expect(event(EVENT_A).id).toBe(EVENT_A);
    expect(events.map((r) => r.id).sort()).toEqual([EVENT_A, EVENT_B]);
  });

  test("rejects an eventKey", async () => {
    const res = await patch(EVENT_A, { eventKey: "forged|key|2026-01-01" });

    expect(res.status).toBe(400);
  });

  test("leaves the eventKey alone", async () => {
    await patch(EVENT_A, { eventKey: "forged|key|2026-01-01" });

    // The recognition key is derived from company|stage|date. A client-supplied
    // key detaches identity from content and steers future matching.
    expect(event(EVENT_A).eventKey).toBe("old company|OA|2026-09-01");
  });
});

// ---------------------------------------------------------------------------
// Server-owned columns.
// ---------------------------------------------------------------------------

describe("server-controlled fields cannot be assigned through the request body", () => {
  test.each([
    ["confidence", { confidence: 0.1 }],
    ["createdAt", { createdAt: "2000-01-01T00:00:00.000Z" }],
    ["updatedAt", { updatedAt: "2000-01-01T00:00:00.000Z" }],
    ["status", { status: "scheduled" }],
    ["isTimeEstimated", { isTimeEstimated: true }],
  ])("rejects %s", async (_field, body) => {
    const res = await patch(EVENT_A, body);

    expect(res.status).toBe(400);
    expect(prisma.event.update).not.toHaveBeenCalled();
  });

  test("leaves the provenance timestamps as the server wrote them", async () => {
    await patch(EVENT_A, {
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
    });

    expect(event(EVENT_A).createdAt).toEqual(CREATED_AT);
    expect(event(EVENT_A).updatedAt).toEqual(UPDATED_AT);
  });
});

// ---------------------------------------------------------------------------
// Shape of the request itself.
// ---------------------------------------------------------------------------

describe("the request shape is validated", () => {
  test("rejects an unknown property rather than stripping it", async () => {
    const res = await patch(EVENT_A, { compnay: "Google" });

    // A typo is a request the server cannot honour. Answering 200 while
    // silently discarding it reports a correction that never happened.
    expect(res.status).toBe(400);
    expect(event(EVENT_A).company).toBe("Old Company");
  });

  test("rejects an empty body", async () => {
    const res = await patch(EVENT_A, {});

    // Nothing to correct. Today this still writes the confirmation fields, so
    // an empty PATCH silently confirms an Event the reviewer never edited.
    expect(res.status).toBe(400);
    expect(prisma.event.update).not.toHaveBeenCalled();
  });
});
