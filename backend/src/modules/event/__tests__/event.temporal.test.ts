// PR-5 RED — upcoming / expired classification.
//
// The dashboard needs to separate Events that have already happened from those
// still to come. The Event model carries exactly one occurrence field — `date`
// — plus an optional, sometimes-INFERRED clock time (`time`, `isTimeEstimated`).
// There is no start/end range, no deadline, and no second timestamp.
//
// THE INVARIANT — two rules, selected by whether the Event carries a reliable
// clock time.
//
//   TIMED (time present AND isTimeEstimated === false)
//     occurrence = date + time, read in Asia/Kolkata
//     now <  occurrence  → UPCOMING
//     now >= occurrence  → EXPIRED        (the instant itself is expired)
//
//   DATE-ONLY (time absent, OR the time is an estimate)
//     compare calendar days in Asia/Kolkata
//     event day >= today → UPCOMING       (upcoming for the whole IST day)
//     event day <  today → EXPIRED
//
// Both rules are IST, not UTC. `toUTCDate` stores a calendar day as UTC midnight
// and `toISTKey` reads it back in Asia/Kolkata; the frontend's Event type states
// outright that `date` "carries no clock time" and that anything read out of its
// hours is an artefact of the viewer's timezone. The naive `event.date < new
// Date()` expires a date-only event at 05:30 IST on its own morning, which the
// boundary tests below are written to catch.
//
// WHY AN ESTIMATED TIME FALLS TO THE DATE-ONLY RULE.
//
// The refined invariant applies the clock only to a "reliable/explicit" time,
// and the repository defines precisely which times are neither:
// `detectEstimatedTime` (extraction.utils.ts:80) sets the flag when the source
// text matched /around|approx|morning|afternoon|evening/, and the frontend type
// documents it as "the extractor inferred the time rather than reading it (e.g.
// 'morning' -> '10:00')". So an estimated time is a vague phrase rendered as a
// clock value — "morning" became 10:00, and 10:01 is not evidence the event is
// over. Expiring on it would hide a real event on the strength of a guess, so an
// estimated time is treated as no time at all.
//
// Temporal state is DERIVED. Nothing here asserts, or permits, a persisted
// `isExpired`/`isUpcoming` column — one test checks explicitly that the stored
// row is unchanged by classification.
//
// Scope: this suite answers "is this Event in the past or the future?" and
// nothing else. No registration number, no shortlist, no eligibility, no
// relevance. See the report for why the registration-number regression guard is
// deliberately absent.

import { toUTCDate } from "../../../shared/utils/date";

const USER_A = 1;
const USER_B = 2;

// In-memory Prisma double. The suite asserts on what the read path RETURNS, so
// a table-backed fake keeps the query honest (tenant predicate, status filter)
// while leaving classification as the only thing under test.
jest.mock("../../../lib/prisma", () => {
  type Row = Record<string, unknown>;

  const events: Row[] = [];
  const eventUpdates: Row[] = [];

  // Accepts today's `{ id }` and PR-4's composite `{ id_userId }` selector.
  const selector = (where: Record<string, any> = {}): Record<string, unknown> =>
    where.id_userId
      ? { id: where.id_userId.id, userId: where.id_userId.userId }
      : where;

  const matches = (row: Row, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  return {
    prisma: {
      __events: events,
      __eventUpdates: eventUpdates,
      event: {
        // Insertion order is preserved and `orderBy` is ignored on purpose:
        // this suite pins classification, not ordering. The dashboard's sort
        // policy is an open question (see report), and asserting one here would
        // quietly invent it.
        findMany: jest.fn(async ({ where }: any) =>
          events.filter((r) => matches(r, selector(where))).map((r) => ({ ...r })),
        ),
        findFirst: jest.fn(
          async ({ where }: any) =>
            events.find((r) => matches(r, selector(where))) ?? null,
        ),
        create: jest.fn(),
        update: jest.fn(async ({ where, data }: any) => {
          const row = events.find((r) => matches(r, selector(where)));
          if (!row) {
            const error: any = new Error("Record to update not found.");
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
          const row = { id: eventUpdates.length + 1, ...data };
          eventUpdates.push(row);
          return row;
        }),
      },
      $transaction: jest.fn(async (callback: (tx: any) => unknown) =>
        callback((jest.requireMock("../../../lib/prisma") as any).prisma),
      ),
    },
  };
});

import { getEventsService, updateEventService } from "../event.service";
import { prisma } from "../../../lib/prisma";
import type { OwnershipContext } from "../../auth/tenant-context";

type Row = Record<string, unknown>;

const events = (prisma as any).__events as Row[];

const OWNER: OwnershipContext = { userId: USER_A };

// The classified shape does not exist yet — that is what this RED phase
// establishes. Reads go through a loose alias so the suite compiles against
// today's raw-row return type AND tomorrow's classified one; without it these
// would fail to COMPILE, which would prove nothing about classification.
type Classified = Record<string, unknown> & { temporalStatus?: string };

const listEvents = async (
  owner: OwnershipContext = OWNER,
  args: { status?: string } = {},
): Promise<Classified[]> =>
  (await getEventsService(owner, args)) as unknown as Classified[];

const temporalOf = async (id: number): Promise<string | undefined> => {
  const found = (await listEvents()).find((e) => e.id === id);
  return found?.temporalStatus;
};

// ---------------------------------------------------------------------------
// Fixtures.
//
// `date` is built with the production helper, so the stored instant is exactly
// what the ingestion path would have written for that calendar day.
// ---------------------------------------------------------------------------

let nextId = 1;

const seedEvent = (day: string, overrides: Row = {}): number => {
  const id = nextId++;
  events.push({
    id,
    userId: USER_A,
    company: "amazon",
    stage: "OA",
    date: toUTCDate(day),
    time: null,
    venue: null,
    eventKey: `amazon|OA|${day}`,
    confidence: 0.9,
    status: "scheduled",
    reviewReason: null,
    isTimeEstimated: false,
    ...overrides,
  });
  return id;
};

// No clock convention exists in this repository — nothing mocks Date anywhere —
// so this is the smallest mechanism Jest offers. Real timers are restored after
// every test.
const atInstant = (iso: string) => {
  jest.setSystemTime(new Date(iso));
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  events.length = 0;
  nextId = 1;
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// A + B, and refinement cases 4-6. A date-only Event is classified by its
// calendar day. `seedEvent` leaves `time` null unless a test sets it, so every
// Event in this block is date-only.
// ---------------------------------------------------------------------------

describe("a date-only Event is classified by its calendar day", () => {
  test("dated tomorrow, it is upcoming", async () => {
    atInstant("2026-09-01T09:00:00.000Z"); // 14:30 IST, 1 Sep
    const id = seedEvent("2026-09-02", { time: null });

    expect(await temporalOf(id)).toBe("upcoming");
  });

  test("dated yesterday, it is expired", async () => {
    atInstant("2026-09-01T09:00:00.000Z"); // 14:30 IST, 1 Sep
    const id = seedEvent("2026-08-31", { time: null });

    expect(await temporalOf(id)).toBe("expired");
  });

  test("dated today, it stays upcoming for the whole IST day", async () => {
    atInstant("2026-09-01T09:00:00.000Z"); // 14:30 IST, 1 Sep
    const id = seedEvent("2026-09-01", { time: null });

    expect(await temporalOf(id)).toBe("upcoming");
  });

  test("every Event receives a classification", async () => {
    atInstant("2026-09-01T09:00:00.000Z");
    seedEvent("2026-09-02");
    seedEvent("2026-08-31");

    const listed = await listEvents();

    // No Event may come back unclassified: the dashboard has to put each one in
    // exactly one of two sections.
    for (const event of listed) {
      expect(["upcoming", "expired"]).toContain(event.temporalStatus);
    }
  });
});

// ---------------------------------------------------------------------------
// C. The boundary — and the timezone it encodes.
//
// `date` is stored as UTC midnight of an IST calendar day, so the day an Event
// belongs to runs from 18:30Z the previous evening to 18:30Z that evening. Both
// edges are pinned to the millisecond.
// ---------------------------------------------------------------------------

describe("for a date-only Event the boundary falls at IST midnight, not UTC midnight", () => {
  test("still upcoming at 23:59:59.999 IST on its own day", async () => {
    atInstant("2026-09-01T18:29:59.999Z");
    const id = seedEvent("2026-09-01");

    expect(await temporalOf(id)).toBe("upcoming");
  });

  test("expired at 00:00:00.000 IST the next day", async () => {
    atInstant("2026-09-01T18:30:00.000Z");
    const id = seedEvent("2026-09-01");

    // The transition instant itself: the Event's day is over, so it is expired.
    expect(await temporalOf(id)).toBe("expired");
  });

  // The most likely wrong implementation is `event.date < new Date()`, which
  // compares the stored UTC-midnight instant against the current instant. That
  // expires an Event at 05:30 IST on the morning it happens — this is the test
  // that catches it.
  test("an Event earlier the same IST day is NOT expired", async () => {
    atInstant("2026-09-01T00:30:00.000Z"); // 06:00 IST, 1 Sep
    const id = seedEvent("2026-09-01");

    expect(await temporalOf(id)).toBe("upcoming");
  });

  // The mirror case: after 18:30Z the UTC calendar date still reads 1 Sep, but
  // in IST it is already 2 Sep. A UTC-day comparison would call this upcoming.
  test("an Event is expired once IST has rolled over, even while UTC has not", async () => {
    atInstant("2026-09-01T19:00:00.000Z"); // 00:30 IST, 2 Sep — UTC date still 1 Sep
    const id = seedEvent("2026-09-01");

    expect(await temporalOf(id)).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// Clock time does not participate.
// ---------------------------------------------------------------------------

// Refinement cases 1-3. A reliable time makes the Event expire at its
// scheduled moment rather than at the end of its day.
//
// The fixture day is 25 Aug and the scheduled time 09:30 IST, so the occurrence
// instant is 2026-08-25T04:00:00.000Z.
describe("a timed Event expires at its scheduled time", () => {
  const DAY = "2026-08-25";
  const TIME = "09:30";

  test("earlier today, it is expired", async () => {
    atInstant("2026-08-25T04:30:00.000Z"); // 10:00 IST — 30 minutes after
    const id = seedEvent(DAY, { time: TIME, isTimeEstimated: false });

    expect(await temporalOf(id)).toBe("expired");
  });

  test("later today, it is upcoming", async () => {
    atInstant("2026-08-25T03:30:00.000Z"); // 09:00 IST — 30 minutes before
    const id = seedEvent(DAY, { time: TIME, isTimeEstimated: false });

    expect(await temporalOf(id)).toBe("upcoming");
  });

  test("at the scheduled instant exactly, it is expired", async () => {
    atInstant("2026-08-25T04:00:00.000Z"); // 09:30 IST — the occurrence itself
    const id = seedEvent(DAY, { time: TIME, isTimeEstimated: false });

    // `now >= occurrence` expires. The event has begun; it is no longer
    // something the student needs to be reminded is coming.
    expect(await temporalOf(id)).toBe("expired");
  });

  test("one millisecond before the scheduled instant, it is upcoming", async () => {
    atInstant("2026-08-25T03:59:59.999Z");
    const id = seedEvent(DAY, { time: TIME, isTimeEstimated: false });

    expect(await temporalOf(id)).toBe("upcoming");
  });

  // The time is read in IST, not UTC. A UTC reading would place the occurrence
  // at 09:30Z and call this upcoming.
  test("the scheduled time is interpreted in IST", async () => {
    atInstant("2026-08-25T05:00:00.000Z"); // 10:30 IST — past 09:30 IST, before 09:30Z
    const id = seedEvent(DAY, { time: TIME, isTimeEstimated: false });

    expect(await temporalOf(id)).toBe("expired");
  });

  // Guards against an implementation that compares only the time of day and
  // forgets the date.
  test("a timed Event on a past day is expired even at a late clock time", async () => {
    atInstant("2026-08-25T04:30:00.000Z"); // 10:00 IST, 25 Aug
    const id = seedEvent("2026-08-24", { time: "23:59", isTimeEstimated: false });

    expect(await temporalOf(id)).toBe("expired");
  });

  test("a timed Event on a future day is upcoming even at an early clock time", async () => {
    atInstant("2026-08-25T04:30:00.000Z"); // 10:00 IST, 25 Aug
    const id = seedEvent("2026-08-26", { time: "00:01", isTimeEstimated: false });

    expect(await temporalOf(id)).toBe("upcoming");
  });
});

// An estimated time is not a reliable time — see the header note. These Events
// follow the date-only rule.
describe("an estimated time does not expire an Event", () => {
  test("a same-day estimated time that has passed leaves it upcoming", async () => {
    atInstant("2026-08-25T04:30:00.000Z"); // 10:00 IST
    const id = seedEvent("2026-08-25", { time: "09:30", isTimeEstimated: true });

    // "morning" became 09:30. 10:00 is not evidence the event is over.
    expect(await temporalOf(id)).toBe("upcoming");
  });

  test("an estimated time still expires with its day", async () => {
    atInstant("2026-08-25T04:30:00.000Z"); // 10:00 IST, 25 Aug
    const id = seedEvent("2026-08-24", { time: "09:30", isTimeEstimated: true });

    expect(await temporalOf(id)).toBe("expired");
  });

  test("an estimated time is upcoming all day, right up to IST midnight", async () => {
    atInstant("2026-08-25T18:29:59.999Z"); // 23:59:59.999 IST, 25 Aug
    const id = seedEvent("2026-08-25", { time: "09:30", isTimeEstimated: true });

    expect(await temporalOf(id)).toBe("upcoming");
  });
});

describe("an Event with no time at all is classified by its day", () => {
  test("past and future date-only Events classify correctly", async () => {
    atInstant("2026-09-01T09:00:00.000Z");
    const past = seedEvent("2026-08-31", { time: null });
    const future = seedEvent("2026-09-02", { time: null });

    expect(await temporalOf(past)).toBe("expired");
    expect(await temporalOf(future)).toBe("upcoming");
  });

  test("a date-only Event is upcoming right up to IST midnight", async () => {
    atInstant("2026-09-01T18:29:59.999Z"); // 23:59:59.999 IST
    const id = seedEvent("2026-09-01", { time: null });

    expect(await temporalOf(id)).toBe("upcoming");
  });
});

// ---------------------------------------------------------------------------
// E. A realistic mixture.
// ---------------------------------------------------------------------------

describe("a mixed list is classified per Event", () => {
  test("places each Event in the right category", async () => {
    atInstant("2026-09-01T09:00:00.000Z");
    const a = seedEvent("2026-09-05", { company: "google" });
    const b = seedEvent("2026-08-20", { company: "microsoft" });
    const c = seedEvent("2026-09-02", { company: "amazon" });

    expect(await temporalOf(a)).toBe("upcoming");
    expect(await temporalOf(b)).toBe("expired");
    expect(await temporalOf(c)).toBe("upcoming");
  });

  test("classification is per Event, not per response", async () => {
    atInstant("2026-09-01T09:00:00.000Z");
    seedEvent("2026-09-05");
    seedEvent("2026-08-20");

    const listed = await listEvents();
    const categories = listed.map((e) => e.temporalStatus);

    expect(categories).toContain("upcoming");
    expect(categories).toContain("expired");
  });

  // Both rules in one response: the two same-day Events differ only in whether
  // their time is reliable, and they must land in different categories.
  test("timed and date-only Events on the same day classify by their own rule", async () => {
    atInstant("2026-09-01T09:00:00.000Z"); // 14:30 IST, 1 Sep

    const timedPast = seedEvent("2026-09-01", {
      time: "09:00",
      isTimeEstimated: false,
    });
    const timedLater = seedEvent("2026-09-01", {
      time: "18:00",
      isTimeEstimated: false,
    });
    const dateOnly = seedEvent("2026-09-01", { time: null });
    const estimated = seedEvent("2026-09-01", {
      time: "09:00",
      isTimeEstimated: true,
    });

    expect(await temporalOf(timedPast)).toBe("expired");
    expect(await temporalOf(timedLater)).toBe("upcoming");
    expect(await temporalOf(dateOnly)).toBe("upcoming");
    expect(await temporalOf(estimated)).toBe("upcoming");
  });
});

// ---------------------------------------------------------------------------
// D. Derived, never stored.
// ---------------------------------------------------------------------------

describe("temporal state is derived from the date, not cached on the row", () => {
  test("moving an Event's date into the past reclassifies it", async () => {
    atInstant("2026-09-01T09:00:00.000Z");
    const id = seedEvent("2026-09-10");

    expect(await temporalOf(id)).toBe("upcoming");

    // The automated reschedule path — the only route by which an Event's date
    // changes (PR-3's allowlist excludes `date` from the manual path).
    const existing = { ...events.find((e) => e.id === id)! };
    await updateEventService(OWNER, id, existing, {
      company: "amazon",
      stage: "OA",
      date: "2026-08-25",
      confidence: 0.95,
    } as any);

    expect(await temporalOf(id)).toBe("expired");
  });

  test("the same Event reclassifies as the clock crosses its day", async () => {
    const id = seedEvent("2026-09-01");

    atInstant("2026-09-01T12:00:00.000Z"); // 17:30 IST, its own day
    expect(await temporalOf(id)).toBe("upcoming");

    atInstant("2026-09-02T12:00:00.000Z"); // next IST day
    expect(await temporalOf(id)).toBe("expired");

    // Nothing was written to make that happen.
    expect((prisma.event.update as jest.Mock)).not.toHaveBeenCalled();
    expect((prisma.event.updateMany as jest.Mock)).not.toHaveBeenCalled();
  });

  test("classification adds no persisted temporal column", async () => {
    atInstant("2026-09-01T09:00:00.000Z");
    const id = seedEvent("2026-08-31");

    await listEvents();

    // The stored row must be untouched: no isExpired, no isUpcoming, no
    // temporalStatus written back. The category is a view, not state.
    const stored = events.find((e) => e.id === id)!;
    expect(stored).not.toHaveProperty("temporalStatus");
    expect(stored).not.toHaveProperty("isExpired");
    expect(stored).not.toHaveProperty("isUpcoming");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle status and temporal category are orthogonal.
// ---------------------------------------------------------------------------

describe("temporal classification does not touch lifecycle status", () => {
  test.each([
    ["scheduled", "2026-09-05", "upcoming"],
    ["scheduled", "2026-08-20", "expired"],
    ["confirmed", "2026-09-05", "upcoming"],
    ["confirmed", "2026-08-20", "expired"],
    ["review", "2026-09-05", "upcoming"],
    ["review", "2026-08-20", "expired"],
    ["rescheduled", "2026-08-20", "expired"],
  ])(
    "a %s Event dated %s is %s",
    async (status, day, expected) => {
      atInstant("2026-09-01T09:00:00.000Z");
      const id = seedEvent(day, { status });

      expect(await temporalOf(id)).toBe(expected);
    },
  );

  test("the lifecycle status is left exactly as it was", async () => {
    atInstant("2026-09-01T09:00:00.000Z");
    const id = seedEvent("2026-08-20", { status: "review" });

    const listed = await listEvents();
    const returned = listed.find((e) => e.id === id)!;

    expect(returned.status).toBe("review");
    expect(events.find((e) => e.id === id)!.status).toBe("review");
  });

  test("the existing status filter still works and still classifies", async () => {
    atInstant("2026-09-01T09:00:00.000Z");
    seedEvent("2026-08-20", { status: "review" });
    seedEvent("2026-09-05", { status: "scheduled" });

    const listed = await listEvents(OWNER, { status: "review" });

    expect(listed).toHaveLength(1);
    expect(listed[0]!.temporalStatus).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// Empty and single-category results.
// ---------------------------------------------------------------------------

describe("empty and one-sided results are ordinary", () => {
  test("no Events yields an empty list", async () => {
    atInstant("2026-09-01T09:00:00.000Z");

    await expect(listEvents()).resolves.toEqual([]);
  });

  test("all-upcoming yields no expired entries", async () => {
    atInstant("2026-09-01T09:00:00.000Z");
    seedEvent("2026-09-05");
    seedEvent("2026-09-06");

    const listed = await listEvents();

    expect(listed).toHaveLength(2);
    expect(listed.every((e) => e.temporalStatus === "upcoming")).toBe(true);
  });

  test("all-expired yields no upcoming entries", async () => {
    atInstant("2026-09-01T09:00:00.000Z");
    seedEvent("2026-08-05");
    seedEvent("2026-08-06");

    const listed = await listEvents();

    expect(listed).toHaveLength(2);
    expect(listed.every((e) => e.temporalStatus === "expired")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tenancy is unchanged. Classification must not widen the read.
// ---------------------------------------------------------------------------

describe("classification does not alter tenant scoping", () => {
  test("another tenant's Events are neither returned nor classified", async () => {
    atInstant("2026-09-01T09:00:00.000Z");
    seedEvent("2026-09-05");
    seedEvent("2026-09-06", { userId: USER_B });

    const listed = await listEvents();

    expect(listed).toHaveLength(1);
    expect(listed[0]!.userId).toBe(USER_A);
  });
});
