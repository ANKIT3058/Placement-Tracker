// PR-4 RED — the automated Event persistence boundary.
//
// The automated pipeline already derives the authoritative owner from the
// persisted Email and threads it, as an `OwnershipContext`, through matching
// and into `updateEventService`. What it does not do is apply that owner to the
// Event write itself: the mutation resolves its row by `WHERE { id }` alone
// (`event.service.ts:123`), so the tenant predicate contributes nothing to the
// statement that actually changes the row.
//
// The invariant this suite establishes:
//
//     Event.userId === owner.userId  →  mutation applies
//     Event.userId !== owner.userId  →  mutation cannot occur
//
// enforced by the Event write, on its own terms.
//
// WHY THE WRONG-OWNER CASE NEEDS TWO LAYERS.
//
// In production a wrong-owner call is already refused — but not by the Event
// write. The transaction records history first, and
// `EventUpdate_eventId_userId_fkey (eventId, userId) → Event(id, userId)`
// (migration 20260802030000, not DEFERRABLE) has no row to point at when the
// owner disagrees, so the insert raises a foreign-key violation and the whole
// transaction rolls back before the Event update runs. That protection is real,
// and it is why this gap is defense-in-depth rather than a live vulnerability.
//
// It is also borrowed. It lives on a different table, and it holds only while
// every automated Event write is accompanied by a history row in the same
// transaction — true today by accident of control flow, stated nowhere, and
// lost by the first automated write that does not record history.
//
// So the suite asserts both properties separately: that the transaction as a
// whole refuses (with the constraint in place), and that the Event write
// defends itself (with the constraint lifted). The second is the one PR-4 is
// about, and isolating it is the only way to observe it — in the same way a
// seatbelt is tested with the airbag disabled.

import type { OwnershipContext } from "../../auth/tenant-context";

const USER_A = 1;
const USER_B = 2;

const EVENT_A = 10;
const EVENT_B = 20;

const OWNER: OwnershipContext = { userId: USER_A };
const INTRUDER: OwnershipContext = { userId: USER_B };

// In-memory Prisma double, backed by real tables.
//
// Asserting on call arguments cannot answer this suite's question: an unscoped
// `update WHERE { id }` and a scoped `update WHERE { id, userId }` are both
// "called with the right id", and only applying the predicate for real shows
// which rows each one reaches. The tables make "Event A did not change" an
// observation.
jest.mock("../../../lib/prisma", () => {
  type Row = Record<string, unknown>;

  const events: Row[] = [];
  const eventUpdates: Row[] = [];

  // Models `EventUpdate_eventId_userId_fkey`. Switched off only by the block
  // that isolates the Event write — see the header note.
  const state = { enforceHistoryFk: true };

  // Accepts both shapes so the suite compiles against today's unscoped selector
  // and the composite selector the fix will use. `Event` already carries
  // `@@unique([id, userId])`, so `id_userId` is a valid Prisma selector today —
  // no schema change is involved in either shape.
  const selector = (where: Record<string, any> = {}): Record<string, unknown> =>
    where.id_userId
      ? { id: where.id_userId.id, userId: where.id_userId.userId }
      : where;

  const matches = (row: Row, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  return {
    prisma: {
      // Test-only handles.
      __events: events,
      __eventUpdates: eventUpdates,
      __state: state,

      event: {
        findFirst: jest.fn(
          async ({ where }: any) =>
            events.find((r) => matches(r, selector(where))) ?? null,
        ),
        findMany: jest.fn(async ({ where }: any) =>
          events.filter((r) => matches(r, selector(where))),
        ),
        create: jest.fn(),
        // Mirrors Prisma: a non-matching `update` raises P2025.
        update: jest.fn(async ({ where, data }: any) => {
          const row = events.find((r) => matches(r, selector(where)));

          if (!row) {
            const error: any = new Error(
              "An operation failed because it depends on one or more records that were required but not found.",
            );
            error.code = "P2025";
            throw error;
          }

          Object.assign(row, data);
          return row;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const matched = events.filter((r) => matches(r, selector(where)));
          matched.forEach((row) => Object.assign(row, data));
          return { count: matched.length };
        }),
      },

      eventUpdate: {
        create: jest.fn(async ({ data }: any) => {
          if (state.enforceHistoryFk) {
            const parent = events.find(
              (e) => e.id === data.eventId && e.userId === data.userId,
            );

            if (!parent) {
              const error: any = new Error(
                "Foreign key constraint violated on the constraint: `EventUpdate_eventId_userId_fkey`",
              );
              error.code = "P2003";
              throw error;
            }
          }

          const row = { id: eventUpdates.length + 1, ...data };
          eventUpdates.push(row);
          return row;
        }),
        findMany: jest.fn(async ({ where }: any) =>
          eventUpdates.filter((r) => matches(r, where)),
        ),
      },

      // Interactive transaction. The callback receives the same client, so the
      // service's `tx.event.update` / `tx.eventUpdate.create` resolve against
      // these tables.
      //
      // Rollback is NOT simulated: nothing here undoes writes already applied
      // when a later statement throws. That is deliberate and it only makes the
      // suite stricter — a partial write survives and is visible to the
      // assertions, where a real rollback would hide it. Every assertion below
      // therefore holds a fortiori in production.
      $transaction: jest.fn(async (callback: (tx: any) => unknown) =>
        callback((jest.requireMock("../../../lib/prisma") as any).prisma),
      ),
    },
  };
});

import { updateEventService } from "../event.service";
import { prisma } from "../../../lib/prisma";

type Row = Record<string, unknown>;

const events = (prisma as any).__events as Row[];
const eventUpdates = (prisma as any).__eventUpdates as Row[];
const state = (prisma as any).__state as { enforceHistoryFk: boolean };

const EVENT_DATE = new Date("2026-09-01T00:00:00.000Z");

const eventRow = (overrides: Row = {}): Row => ({
  id: EVENT_A,
  userId: USER_A,
  company: "amazon",
  stage: "OA",
  date: EVENT_DATE,
  time: "10:00",
  venue: null,
  eventKey: "amazon|OA|2026-09-01",
  confidence: 0.4,
  status: "scheduled",
  reviewReason: null,
  isTimeEstimated: false,
  ...overrides,
});

// An observation that changes exactly one field (time) and is confident enough
// to be applied — the ordinary automated update, with no reschedule.
const observation = (overrides: Record<string, unknown> = {}) => ({
  company: "amazon",
  stage: "OA",
  date: "2026-09-01",
  time: "15:00",
  confidence: 0.9,
  ...overrides,
});

const seed = () => {
  events.length = 0;
  eventUpdates.length = 0;

  events.push(
    eventRow(),
    // The intruder's own Event, so a cross-tenant attempt has a real neighbour
    // rather than an empty table.
    eventRow({
      id: EVENT_B,
      userId: USER_B,
      company: "google",
      eventKey: "google|OA|2026-09-01",
    }),
  );
};

const event = (id: number): Row => events.find((r) => r.id === id)!;
const snapshot = (id: number): Row => ({ ...event(id) });

// A refused scoped write may reject (P2025 from `update`, P2003 from the
// history FK) or resolve with `count: 0` (`updateMany`, the shape
// `email.repository` uses). The GREEN phase picks one; this suite deliberately
// does not force that choice — it asserts what must hold either way, which is
// that the row is untouched. Same helper as the PR-2 attachment suite.
const attempt = async (fn: () => Promise<unknown>) => {
  try {
    return { rejected: false as const, value: await fn() };
  } catch (error) {
    return { rejected: true as const, error };
  }
};

// The selector of the most recent Event write, normalised across both shapes.
const lastEventWriteSelector = (): Record<string, unknown> | undefined => {
  const calls = [
    ...(prisma.event.update as jest.Mock).mock.calls,
    ...(prisma.event.updateMany as jest.Mock).mock.calls,
  ];
  const where = calls.pop()?.[0]?.where;

  if (!where) {
    return undefined;
  }

  return where.id_userId
    ? { id: where.id_userId.id, userId: where.id_userId.userId }
    : where;
};

beforeEach(() => {
  jest.clearAllMocks();
  state.enforceHistoryFk = true;
  seed();
});

// ---------------------------------------------------------------------------
// TEST 1 — the legitimate automated update is unaffected.
// ---------------------------------------------------------------------------

describe("the owner's automated update applies", () => {
  test("writes the observed change onto the Event", async () => {
    await updateEventService(OWNER, EVENT_A, snapshot(EVENT_A), observation() as any);

    expect(event(EVENT_A)).toMatchObject({
      time: "15:00",
      confidence: 0.9,
    });
  });

  test("records one history row per change, owned by the same tenant", async () => {
    await updateEventService(OWNER, EVENT_A, snapshot(EVENT_A), observation() as any);

    expect(eventUpdates).toHaveLength(1);
    expect(eventUpdates[0]).toMatchObject({
      eventId: EVENT_A,
      userId: USER_A,
      field: "time",
      oldValue: "10:00",
      newValue: "15:00",
    });
  });

  test("leaves the Event's identity columns alone", async () => {
    await updateEventService(OWNER, EVENT_A, snapshot(EVENT_A), observation() as any);

    expect(event(EVENT_A)).toMatchObject({
      id: EVENT_A,
      userId: USER_A,
      eventKey: "amazon|OA|2026-09-01",
    });
  });

  test("does not touch the other tenant's Event", async () => {
    const before = snapshot(EVENT_B);

    await updateEventService(OWNER, EVENT_A, snapshot(EVENT_A), observation() as any);

    expect(event(EVENT_B)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// TESTS 2 + 3 — the transaction as a whole refuses a wrong owner.
//
// These hold today, via the history foreign key rather than via the Event
// write. They are kept as regression guards: whatever PR-4 changes, and however
// the transaction is later reordered, these must not stop holding.
// ---------------------------------------------------------------------------

describe("a wrong owner cannot mutate another tenant's Event", () => {
  test("leaves the target Event byte-identical", async () => {
    const before = snapshot(EVENT_A);

    await attempt(() =>
      updateEventService(INTRUDER, EVENT_A, snapshot(EVENT_A), observation() as any),
    );

    expect(event(EVENT_A)).toEqual(before);
  });

  test("refuses rather than succeeding silently", async () => {
    const result = await attempt(() =>
      updateEventService(INTRUDER, EVENT_A, snapshot(EVENT_A), observation() as any),
    );

    // A resolved value must not be a disguised success.
    if (!result.rejected && result.value && typeof result.value === "object") {
      expect(result.value).toMatchObject({ count: 0 });
    }
  });

  test("writes no history row for the target Event", async () => {
    await attempt(() =>
      updateEventService(INTRUDER, EVENT_A, snapshot(EVENT_A), observation() as any),
    );

    // History is the domain's memory. A refused write must leave none behind —
    // and must certainly not attribute one to the intruder.
    expect(eventUpdates).toHaveLength(0);
  });

  test("does not touch the intruder's own Event either", async () => {
    const before = snapshot(EVENT_B);

    await attempt(() =>
      updateEventService(INTRUDER, EVENT_A, snapshot(EVENT_A), observation() as any),
    );

    expect(event(EVENT_B)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// THE PR-4 GAP — the Event write, isolated.
//
// The history constraint is lifted here so the Event write is observed on its
// own terms. This is not a claim about production: in production the FK fires
// first. It is the question PR-4 exists to answer — if the Event write ever
// runs without that cover, does it defend itself?
//
// The cover disappears for any automated write that does not record history: a
// status flip, a backfill, a re-scoring job. None exists today. The predicate
// has to be there before the first one, not after.
// ---------------------------------------------------------------------------

describe("the Event write enforces ownership without help from the history constraint", () => {
  beforeEach(() => {
    state.enforceHistoryFk = false;
  });

  test("a wrong owner still cannot change the Event", async () => {
    const before = snapshot(EVENT_A);

    await attempt(() =>
      updateEventService(INTRUDER, EVENT_A, snapshot(EVENT_A), observation() as any),
    );

    expect(event(EVENT_A)).toEqual(before);
  });

  test("a wrong owner still cannot move the Event's confidence", async () => {
    await attempt(() =>
      updateEventService(INTRUDER, EVENT_A, snapshot(EVENT_A), observation() as any),
    );

    expect(event(EVENT_A).confidence).toBe(0.4);
  });

  test("the owner's own update still applies", async () => {
    await updateEventService(OWNER, EVENT_A, snapshot(EVENT_A), observation() as any);

    expect(event(EVENT_A).time).toBe("15:00");
  });
});

// ---------------------------------------------------------------------------
// The predicate itself. One layer of the above, not a substitute for it: this
// is what makes the boundary hold for callers that do not yet exist.
// ---------------------------------------------------------------------------

describe("the Event write carries the tenant predicate", () => {
  test("scopes the mutation by id AND userId", async () => {
    await updateEventService(OWNER, EVENT_A, snapshot(EVENT_A), observation() as any);

    expect(lastEventWriteSelector()).toEqual(
      expect.objectContaining({ id: EVENT_A, userId: USER_A }),
    );
  });

  // The predicate must carry the owner the CALLER supplied, not a value the
  // service reached for elsewhere. Running the same update for three owners is
  // what distinguishes "reads owner.userId" from "happens to equal 1".
  test.each([1, 42, 1234])(
    "the predicate tracks the caller's owner (userId %i)",
    async (userId) => {
      events.length = 0;
      events.push(eventRow({ userId }));

      await updateEventService(
        { userId } satisfies OwnershipContext,
        EVENT_A,
        snapshot(EVENT_A),
        observation() as any,
      );

      expect(lastEventWriteSelector()).toEqual(
        expect.objectContaining({ id: EVENT_A, userId }),
      );
    },
  );
});
