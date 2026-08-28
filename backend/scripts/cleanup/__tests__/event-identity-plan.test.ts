// The one-off Event identity cleanup, exercised entirely from fixtures.
//
// NOTHING HERE TOUCHES A DATABASE. `event-identity-plan.ts` imports no Prisma
// client and no driver — only `canonicalCompany` and `generateEventKey`, both
// pure — so the logic that decides which production rows are deleted and
// rewritten is testable with no connection in existence and no DATABASE_URL
// read. That is the point of the split: this decision has no undo.
//
// The baseline fixture reproduces the shape the plan was approved against: 77
// Events owned by one user, the seven inventoried targets with their real
// field values, the two canonical collision pairs, Event 54's ten history rows,
// and 263 extractions. Each test then breaks ONE thing and asserts the plan
// refuses, because "production changed since the inventory" is the condition
// under which every approved decision stops being valid.

import {
  buildPlan,
  verifyPostConditions,
  canonicalCollisionGroups,
  keyForRow,
  isCanonical,
  DELETE_IDS,
  DO_NOT_TOUCH_IDS,
  EVENT_54,
  EVENT_54_EXPECTED_UPDATE_COUNT,
  EXPECTED_FINAL_EVENT_COUNT,
  HUL_SURVIVOR,
  HUL_DUPLICATE,
  ZANSKAR_SURVIVOR,
  ZANSKAR_DUPLICATE,
  type EventRow,
  type EventUpdateRow,
} from "../event-identity-plan";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER = 1;

const ev = (
  id: number,
  company: string,
  stage: string,
  date: string,
  over: Partial<EventRow> = {},
): EventRow => ({
  id,
  userId: USER,
  company,
  stage,
  date: new Date(`${date}T00:00:00.000Z`),
  time: null,
  venue: null,
  eventKey: `${company}|${stage}|${date}`,
  confidence: 0.97,
  status: "scheduled",
  reviewReason: null,
  isTimeEstimated: false,
  ...over,
});

const upd = (id: number, field: string, from: string, to: string): EventUpdateRow => ({
  id,
  eventId: EVENT_54,
  userId: USER,
  field,
  oldValue: from,
  newValue: to,
  updatedAt: new Date("2026-08-24T05:56:35.000Z"),
});

/** Event 54's real ten-row history, abbreviated to the same shape. */
const event54Updates = (): EventUpdateRow[] => [
  upd(18, "time", "10:45", "11:00"),
  upd(19, "time", "11:00", "05:30"),
  upd(20, "date", "2026-08-14", "2026-08-17"),
  upd(21, "time", "05:30", "18:30"),
  upd(22, "date", "2026-08-17", "2026-08-24"),
  upd(23, "time", "18:30", "15:30"),
  upd(24, "venue", "online", "seminar hall"),
  upd(27, "date", "2026-08-24", "2026-08-26"),
  upd(28, "time", "15:30", "09:45"),
  upd(29, "venue", "seminar hall", "online"),
];

const baselineEvents = (): EventRow[] => {
  const events: EventRow[] = [
    // The seven inventoried targets, with their real values.
    ev(54, "least", "OA", "2026-08-26", { time: "09:45", venue: "online", status: "rescheduled" }),
    ev(55, "stipulated", "Interview", "2026-08-20", { time: "09:30", venue: "zoom", confidence: 1 }),
    ev(68, "Hindustan Unilever Ltd.", "Registration", "2026-08-26", { time: "23:45", venue: "campus", confidence: 1 }),
    ev(71, "Hindustan Unilever Ltd", "Registration", "2026-08-26", { time: "23:45", venue: "tpo", confidence: 1 }),
    ev(72, "zanskar", "Registration", "2026-08-27", { time: "18:30", venue: "campus" }),
    ev(76, "https", "OA", "2026-08-27", { time: "16:45", venue: "HackerRank", confidence: 1 }),
    ev(77, "Zanskar", "Registration", "2026-08-27", { time: "23:59", venue: "tpo", confidence: 0.93 }),

    // Two ordinary canonicalisation targets: one case-only, one period-only.
    ev(5, "American Express", "OA", "2023-10-01", { confidence: 0.74 }),
    ev(18, "Bajaj Auto Ltd.", "Interview", "2023-10-20", { confidence: 1 }),

    // The three excluded by decision. 37 is non-canonical and stays that way.
    ev(37, "TPO", "OA", "2023-10-20", { confidence: 1 }),
    ev(17, "naukri.com", "Registration", "2023-08-02"),
    ev(23, "ti", "Registration", "2026-07-27"),
  ];

  // Padding to the inventoried total. Canonical, unique, and uninvolved.
  for (let i = events.length; i < 77; i += 1) {
    events.push(ev(1000 + i, `padco ${i}`, "OA", "2026-01-01"));
  }

  return events;
};

const baselineInput = () => ({
  events: baselineEvents(),
  event54Updates: event54Updates(),
  dependentUpdateCounts: new Map<number, number>([
    [EVENT_54, EVENT_54_EXPECTED_UPDATE_COUNT],
  ]),
  extractionCount: 263,
});

const failed = (plan: ReturnType<typeof buildPlan>): string[] =>
  plan.preconditions.filter((check) => !check.ok).map((check) => check.name);

/** Applies a plan to a fixture, so post-conditions can be checked end to end. */
const applyPlan = (
  events: EventRow[],
  plan: ReturnType<typeof buildPlan>,
): EventRow[] => {
  const deleted = new Set(plan.deletions.map((entry) => entry.eventId));
  const canonicalise = new Map(
    plan.canonicalisations.map((entry) => [entry.eventId, entry]),
  );

  return events
    .filter((event) => !deleted.has(event.id))
    .map((event) => {
      const next = { ...event };

      if (plan.merge && plan.merge.eventId === event.id) {
        next.venue = plan.merge.newValue;
      }

      const planned = canonicalise.get(event.id);
      if (planned) {
        next.company = planned.toCompany;
        next.eventKey = planned.toKey;
      }

      return next;
    });
};

// ---------------------------------------------------------------------------

describe("the baseline fixture reproduces the approved state", () => {
  test("every precondition passes", () => {
    const plan = buildPlan(baselineInput());

    expect(failed(plan)).toEqual([]);
    expect(plan.ok).toBe(true);
  });

  test("the two collision groups are the inventoried ones", () => {
    const groups = canonicalCollisionGroups(baselineEvents());

    expect(groups.map((group) => group.ids)).toEqual([
      [HUL_SURVIVOR, HUL_DUPLICATE],
      [ZANSKAR_SURVIVOR, ZANSKAR_DUPLICATE],
    ]);
  });
});

describe("canonicalisation planning", () => {
  test("plans exactly the survivors that are non-canonical and not excluded", () => {
    const plan = buildPlan(baselineInput());

    expect(plan.canonicalisations.map((entry) => entry.eventId)).toEqual([
      5,
      18,
      HUL_SURVIVOR,
    ]);
  });

  test("rewrites company and eventKey together, using the production helpers", () => {
    const plan = buildPlan(baselineInput());
    const amex = plan.canonicalisations.find((entry) => entry.eventId === 5)!;

    expect(amex.fromCompany).toBe("American Express");
    expect(amex.toCompany).toBe("american express");
    expect(amex.fromKey).toBe("American Express|OA|2023-10-01");
    expect(amex.toKey).toBe("american express|OA|2023-10-01");
  });

  test("strips a trailing period without touching interior punctuation", () => {
    const events = baselineEvents();
    // Re-purpose a padding row, so the inventoried total of 77 is preserved.
    const row = events.find((event) => event.id === 1012)!;
    row.company = "infrasphere projects pvt. ltd.";
    row.eventKey = keyForRow(row);

    const plan = buildPlan({ ...baselineInput(), events });
    const entry = plan.canonicalisations.find((e) => e.eventId === 1012);

    expect(entry?.toCompany).toBe("infrasphere projects pvt. ltd");
  });

  test("leaves already-canonical Events alone", () => {
    const plan = buildPlan(baselineInput());
    const ids = plan.canonicalisations.map((entry) => entry.eventId);

    expect(ids).not.toContain(17);
    expect(ids).not.toContain(23);
    expect(ids).not.toContain(ZANSKAR_SURVIVOR);
  });

  // Event 37 is the reason the post-condition is "the excluded set" rather than
  // "empty": it is non-canonical AND deliberately untouched.
  test("Event 37 is non-canonical yet excluded, and is reported as such", () => {
    const plan = buildPlan(baselineInput());

    expect(isCanonical(baselineEvents().find((e) => e.id === 37)!)).toBe(false);
    expect(plan.canonicalisations.map((entry) => entry.eventId)).not.toContain(37);
    expect(plan.summary.remainingNonCanonicalIds).toEqual([37]);
  });

  test("no operation of any kind names a do-not-touch Event", () => {
    const plan = buildPlan(baselineInput());
    const touched = new Set([
      ...plan.canonicalisations.map((entry) => entry.eventId),
      ...plan.deletions.map((entry) => entry.eventId),
      plan.merge?.eventId,
    ]);

    for (const id of DO_NOT_TOUCH_IDS) expect(touched.has(id)).toBe(false);
  });
});

describe("collision detection", () => {
  test("aborts when a canonicalisation would claim another Event's current key", () => {
    const events = baselineEvents();
    // A second American Express row that ALREADY holds the canonical key the
    // Event 5 update would claim. This is the 77-vs-72 shape, generalised.
    const clash = events.find((event) => event.id === 1013)!;
    clash.company = "american express";
    clash.stage = "OA";
    clash.date = new Date("2023-10-01T00:00:00.000Z");
    clash.eventKey = keyForRow(clash);

    const plan = buildPlan({ ...baselineInput(), events });

    expect(plan.ok).toBe(false);
    expect(failed(plan)).toContain("canonicalisation-collision-free");
  });

  test("aborts when two canonicalisations would converge on one key", () => {
    const events = baselineEvents();
    const twin = events.find((event) => event.id === 1013)!;
    twin.company = "AMERICAN EXPRESS";
    twin.stage = "OA";
    twin.date = new Date("2023-10-01T00:00:00.000Z");
    twin.eventKey = keyForRow(twin);

    const plan = buildPlan({ ...baselineInput(), events });

    expect(plan.ok).toBe(false);
    expect(failed(plan)).toEqual(
      expect.arrayContaining([
        "canonical-collision-groups",
        "canonicalisation-collision-free",
        "final-keys-unique",
      ]),
    );
  });

  test("aborts when the collision groups are not the two that were approved", () => {
    const events = baselineEvents();
    // Resolve the Zanskar pair by hand, so only one approved group remains.
    events.find((event) => event.id === ZANSKAR_DUPLICATE)!.date = new Date(
      "2026-09-30T00:00:00.000Z",
    );
    events.find((event) => event.id === ZANSKAR_DUPLICATE)!.eventKey =
      "Zanskar|Registration|2026-09-30";

    const plan = buildPlan({ ...baselineInput(), events });

    expect(plan.ok).toBe(false);
    expect(failed(plan)).toContain("canonical-collision-groups");
  });
});

describe("the Hindustan Unilever merge", () => {
  test("plans the venue change and nothing else", () => {
    const plan = buildPlan(baselineInput());

    expect(plan.merge).toEqual({
      eventId: HUL_SURVIVOR,
      userId: USER,
      field: "venue",
      oldValue: "campus",
      newValue: "tpo",
    });
  });

  test("Event 68 survives and Event 71 is deleted", () => {
    const plan = buildPlan(baselineInput());
    const deleted = plan.deletions.map((entry) => entry.eventId);

    expect(deleted).toContain(HUL_DUPLICATE);
    expect(deleted).not.toContain(HUL_SURVIVOR);
  });

  test("aborts if either row no longer holds the venue the merge was approved against", () => {
    const events = baselineEvents();
    events.find((event) => event.id === HUL_SURVIVOR)!.venue = "tpo";

    const plan = buildPlan({ ...baselineInput(), events });

    expect(plan.ok).toBe(false);
    expect(failed(plan)).toEqual(
      expect.arrayContaining(["hul-merge-inputs", "event-68-matches-inventory"]),
    );
    expect(plan.merge).toBeNull();
  });
});

describe("the Zanskar duplicate", () => {
  test("Event 77 is deleted and Event 72 is modified in no way", () => {
    const plan = buildPlan(baselineInput());

    expect(plan.deletions.map((entry) => entry.eventId)).toContain(ZANSKAR_DUPLICATE);
    expect(plan.canonicalisations.map((entry) => entry.eventId)).not.toContain(
      ZANSKAR_SURVIVOR,
    );
    expect(plan.merge?.eventId).not.toBe(ZANSKAR_SURVIVOR);
  });

  test("nothing from Event 77 is copied onto Event 72", () => {
    const plan = buildPlan(baselineInput());
    const after = applyPlan(baselineEvents(), plan);
    const survivor = after.find((event) => event.id === ZANSKAR_SURVIVOR)!;

    expect(survivor.time).toBe("18:30");
    expect(survivor.venue).toBe("campus");
  });
});

describe("junk Event deletions", () => {
  test.each([
    ["Event 55 (stipulated)", 55],
    ["Event 76 (https)", 76],
    ["Event 54 (least)", EVENT_54],
  ])("%s is planned for deletion", (_label, id) => {
    const plan = buildPlan(baselineInput());

    expect(plan.deletions.map((entry) => entry.eventId)).toContain(id);
  });

  test("the deletion set is exactly the approved five, in the approved order", () => {
    const plan = buildPlan(baselineInput());

    expect(plan.deletions.map((entry) => entry.eventId)).toEqual([...DELETE_IDS]);
  });

  test.each([[HUL_DUPLICATE], [ZANSKAR_DUPLICATE], [55], [76]])(
    "aborts when Event %s has gained an EventUpdate dependent",
    (id) => {
      const counts = new Map<number, number>([
        [EVENT_54, EVENT_54_EXPECTED_UPDATE_COUNT],
        [id, 1],
      ]);

      const plan = buildPlan({ ...baselineInput(), dependentUpdateCounts: counts });

      expect(plan.ok).toBe(false);
      expect(failed(plan)).toEqual(
        expect.arrayContaining(["deletions-resolvable", `event-${id}-matches-inventory`]),
      );
    },
  );

  test("aborts when a deletion target has disappeared", () => {
    const events = baselineEvents().filter((event) => event.id !== 76);
    events.push(ev(3001, "somebody else", "OA", "2026-03-03"));

    const plan = buildPlan({ ...baselineInput(), events });

    expect(plan.ok).toBe(false);
    expect(failed(plan)).toEqual(
      expect.arrayContaining(["event-76-exists", "deletions-resolvable"]),
    );
  });
});

describe("Event 54's history must be exported before it can be deleted", () => {
  test("the plan carries all ten rows, with the fields the artifact needs", () => {
    const plan = buildPlan(baselineInput());

    expect(plan.event54Export).toHaveLength(EVENT_54_EXPECTED_UPDATE_COUNT);
    for (const row of plan.event54Export) {
      expect(row.eventId).toBe(EVENT_54);
      expect(typeof row.userId).toBe("number");
      expect(row.field.length).toBeGreaterThan(0);
      expect(typeof row.oldValue).toBe("string");
      expect(typeof row.newValue).toBe("string");
      expect(row.updatedAt).toBeInstanceOf(Date);
    }
  });

  test("aborts when Event 54 has an unexpected number of EventUpdate rows", () => {
    const plan = buildPlan({
      ...baselineInput(),
      event54Updates: event54Updates().slice(0, 9),
      dependentUpdateCounts: new Map([[EVENT_54, 9]]),
    });

    expect(plan.ok).toBe(false);
    expect(failed(plan)).toEqual(
      expect.arrayContaining([
        "event-54-history-exportable",
        "event-54-matches-inventory",
      ]),
    );
  });

  test("aborts when an exported row is incomplete", () => {
    const rows = event54Updates();
    rows[0] = { ...rows[0]!, field: "" };

    const plan = buildPlan({ ...baselineInput(), event54Updates: rows });

    expect(plan.ok).toBe(false);
    expect(failed(plan)).toContain("event-54-history-exportable");
  });
});

describe("table-level preconditions", () => {
  test("aborts when the Event count is not the inventoried one", () => {
    const events = baselineEvents().slice(0, 76);
    const plan = buildPlan({ ...baselineInput(), events });

    expect(plan.ok).toBe(false);
    expect(failed(plan)).toContain("event-count");
  });

  test("aborts when a stored eventKey does not reproduce from its own fields", () => {
    const events = baselineEvents();
    events.find((event) => event.id === 5)!.eventKey = "something else entirely";

    const plan = buildPlan({ ...baselineInput(), events });

    expect(plan.ok).toBe(false);
    expect(failed(plan)).toContain("eventKey-integrity");
  });

  test("aborts when the extraction count has moved", () => {
    const plan = buildPlan({ ...baselineInput(), extractionCount: 264 });

    expect(plan.ok).toBe(false);
    expect(failed(plan)).toContain("extraction-count");
  });

  test("aborts when a duplicate pair no longer shares an owner", () => {
    const events = baselineEvents();
    events.find((event) => event.id === HUL_DUPLICATE)!.userId = 2;

    const plan = buildPlan({ ...baselineInput(), events });

    expect(plan.ok).toBe(false);
    expect(failed(plan)).toContain("duplicate-pairs-share-an-owner");
  });
});

describe("final invariants", () => {
  const cleaned = () => {
    const events = baselineEvents();
    const plan = buildPlan(baselineInput());

    return { plan, after: applyPlan(events, plan) };
  };

  test("the summary predicts 77 → 72, not 73 — Event 54 is a deletion too", () => {
    const { plan } = cleaned();

    expect(plan.summary.initialEventCount).toBe(77);
    expect(plan.summary.deleteCount).toBe(5);
    expect(plan.summary.finalEventCount).toBe(EXPECTED_FINAL_EVENT_COUNT);
    expect(EXPECTED_FINAL_EVENT_COUNT).toBe(72);
  });

  test("every post-condition holds on the cleaned state", () => {
    const { after } = cleaned();

    const checks = verifyPostConditions({
      events: after,
      event54UpdateCount: 0,
      hulMergeUpdateCount: 1,
      extractionCount: 263,
    });

    expect(checks.filter((check) => !check.ok)).toEqual([]);
  });

  test("Event 68 ends up canonical, merged, and correctly keyed", () => {
    const { after } = cleaned();
    const survivor = after.find((event) => event.id === HUL_SURVIVOR)!;

    expect(survivor.company).toBe("hindustan unilever ltd");
    expect(survivor.stage).toBe("Registration");
    expect(survivor.venue).toBe("tpo");
    expect(survivor.eventKey).toBe("hindustan unilever ltd|Registration|2026-08-26");
    expect(survivor.eventKey).toBe(keyForRow(survivor));
  });

  test("no canonical identity collisions remain", () => {
    const { after } = cleaned();

    expect(canonicalCollisionGroups(after)).toEqual([]);
  });

  test("the only non-canonical row left is the one excluded by decision", () => {
    const { after } = cleaned();

    expect(after.filter((event) => !isCanonical(event)).map((event) => event.id)).toEqual(
      [37],
    );
  });

  test("a post-condition failure is reported rather than swallowed", () => {
    const { after } = cleaned();
    // The shape of a cascade that did not happen.
    const checks = verifyPostConditions({
      events: after,
      event54UpdateCount: 10,
      hulMergeUpdateCount: 1,
      extractionCount: 263,
    });

    expect(checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      "event-54-history-cascaded",
    ]);
  });

  test("an EmailExtraction row count change fails the post-conditions", () => {
    const { after } = cleaned();

    const checks = verifyPostConditions({
      events: after,
      event54UpdateCount: 0,
      hulMergeUpdateCount: 1,
      extractionCount: 262,
    });

    expect(checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      "extractions-untouched",
    ]);
  });

  test("a rewritten Event 37 fails the post-conditions", () => {
    const { after } = cleaned();
    const tampered = after.map((event) =>
      event.id === 37
        ? { ...event, company: "tpo", eventKey: "tpo|OA|2023-10-20" }
        : event,
    );

    const checks = verifyPostConditions({
      events: tampered,
      event54UpdateCount: 0,
      hulMergeUpdateCount: 1,
      extractionCount: 263,
    });

    expect(checks.filter((check) => !check.ok).map((check) => check.name)).toContain(
      "event-37-untouched",
    );
  });
});
