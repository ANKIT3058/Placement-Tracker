import { matchEventV2 } from "../matching.service";
import * as repo from "../../event/event.repository";
import { LOOSE_MATCH_WINDOW_DAYS } from "../../../shared/constants/config";

jest.mock("../../event/event.repository", () => ({
  findNearbyEvents: jest.fn(),
  findByEventKey: jest.fn(),
  findByCompanyAndStage: jest.fn(),
}));

const mockFindByEventKey = repo.findByEventKey as jest.Mock;
const mockFindNearbyEvents = repo.findNearbyEvents as jest.Mock;
const mockFindByCompanyAndStage = repo.findByCompanyAndStage as jest.Mock;

describe("matchEventV2", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: nothing found anywhere unless a test overrides it.
    mockFindByEventKey.mockResolvedValue(null);
    mockFindNearbyEvents.mockResolvedValue([]);
    mockFindByCompanyAndStage.mockResolvedValue([]);
  });

  // 1. Exact match: same company, same stage, same date.
  it("returns an exact match when an event with the same key exists", async () => {
    const existing = {
      id: 1,
      company: "amazon",
      stage: "OA",
      date: "2026-08-20",
      confidence: 0.9,
    };
    mockFindByEventKey.mockResolvedValue(existing);

    const result = await matchEventV2({
      company: "amazon",
      stage: "OA",
      date: "2026-08-20",
      confidence: 0.8,
    });

    expect(result).toMatchObject({
      event: existing,
      matchType: "exact",
      confidence: 1.0,
    });
    // Exact path short-circuits before the soft/loose lookups.
    expect(mockFindNearbyEvents).not.toHaveBeenCalled();
    expect(mockFindByCompanyAndStage).not.toHaveBeenCalled();
  });

  // 2. Soft match: same company, same stage, date difference of 1 day.
  it("returns a soft match when a nearby event is 1 day apart with the same stage", async () => {
    const nearby = {
      id: 2,
      company: "amazon",
      stage: "OA",
      date: "2026-08-21", // +1 day from incoming
      confidence: 0.9,
    };
    mockFindNearbyEvents.mockResolvedValue([nearby]);

    const result = await matchEventV2({
      company: "amazon",
      stage: "OA",
      date: "2026-08-20",
      confidence: 0.8,
    });

    expect(result).toMatchObject({
      event: nearby,
      matchType: "soft",
    });
    expect(result?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result?.explanation).toContain("Near date match (±1 day)");
    expect(result?.explanation).toContain("Stage matched");
  });

  // 3. Soft match: same company, same stage, date difference of 3 days.
  it("returns a soft match when a nearby event is 3 days apart with the same stage", async () => {
    const nearby = {
      id: 3,
      company: "amazon",
      stage: "OA",
      date: "2026-08-23", // +3 days from incoming
      confidence: 0.9,
    };
    mockFindNearbyEvents.mockResolvedValue([nearby]);

    const result = await matchEventV2({
      company: "amazon",
      stage: "OA",
      date: "2026-08-20",
      confidence: 0.8,
    });

    expect(result).toMatchObject({
      event: nearby,
      matchType: "soft",
    });
    expect(result?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result?.explanation).toContain("Near date match (±3 days)");
    expect(result?.explanation).toContain("Stage matched");
  });

  // 4. No match: same company, different stage.
  it("returns no match when a nearby event is the same company but a different stage", async () => {
    const nearby = {
      id: 4,
      company: "amazon",
      stage: "Interview", // different stage from incoming "OA"
      date: "2026-08-22", // 2 days apart, so date alone can't clear the 0.5 threshold
      confidence: 0,
    };
    mockFindNearbyEvents.mockResolvedValue([nearby]);
    // No event exists with the incoming stage, so the loose path finds nothing.
    mockFindByCompanyAndStage.mockResolvedValue([]);

    const result = await matchEventV2({
      company: "amazon",
      stage: "OA",
      date: "2026-08-20",
      confidence: 0,
    });

    expect(result).toBeNull();
  });

  // 5. No match: different company.
  it("returns no match when the company is different", async () => {
    // Different company => no exact key, no nearby events, no loose candidates.
    mockFindNearbyEvents.mockResolvedValue([]);
    mockFindByCompanyAndStage.mockResolvedValue([]);

    const result = await matchEventV2({
      company: "google",
      stage: "OA",
      date: "2026-08-20",
      confidence: 0.8,
    });

    expect(result).toBeNull();
  });

  it("picks the highest-confidence candidate among multiple soft matches", async () => {
    const events = [
      { id: 1, company: "amazon", date: "2026-08-20", stage: "OA", confidence: 0.9 },
      { id: 2, company: "amazon", date: "2026-08-21", stage: "OA", confidence: 0.4 },
    ];
    mockFindNearbyEvents.mockResolvedValue(events);

    const result = await matchEventV2({
      company: "amazon",
      stage: "OA",
      date: "2026-08-20",
      confidence: 0.5,
    });

    expect(result?.event?.id).toBe(1);
    expect(result?.explanation).toContain("Exact date match");
  });
});

// ---------------------------------------------------------------------------
// AC-1 / D-2: the loose (weakest) tier infers identity from uniqueness alone.
// Uniqueness is only evidence inside a plausible date range, so the tier is
// bounded by LOOSE_MATCH_WINDOW_DAYS. Candidates outside it must produce NO
// match, so the decision layer creates a new event instead of rewriting an
// existing one's date and marking it rescheduled.
// ---------------------------------------------------------------------------

// The loose-tier date filter lives in the repository (SQL), which is mocked
// here. Hard-coding the filtered result would test nothing, so this fake
// reproduces the repository's predicate from the arguments the service passes:
// a test then verifies BOTH that the service requests the right window AND that
// the resulting candidate set drives the right decision.
const looseCandidateFake =
  (store: any[]) =>
  ({ company, stage, date, windowDays }: any) => {
    const anchor = new Date(date).getTime();

    return Promise.resolve(
      store.filter((event) => {
        if (event.company !== company || event.stage !== stage) return false;

        const diffDays =
          Math.abs(new Date(event.date).getTime() - anchor) / 86_400_000;

        return diffDays <= windowDays; // gte/lte in SQL — inclusive
      }),
    );
  };

// Every observation in this block is anchored to the same date so window
// arithmetic is readable: -30d = 2026-08-21, +30d = 2026-10-20.
const OBSERVED_ON = "2026-09-20";

const incoming = (overrides: Record<string, unknown> = {}) => ({
  company: "amazon",
  stage: "OA",
  date: OBSERVED_ON,
  confidence: 0.8,
  ...overrides,
});

const existingEvent = (date: string, overrides: Record<string, unknown> = {}) => ({
  id: 1,
  company: "amazon",
  stage: "OA",
  date,
  confidence: 0.9,
  ...overrides,
});

describe("matchEventV2 - loose tier temporal bound (AC-1 / D-2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindByEventKey.mockResolvedValue(null);
    // Nothing within the soft window: every case here falls through to tier 3.
    mockFindNearbyEvents.mockResolvedValue([]);
    mockFindByCompanyAndStage.mockImplementation(looseCandidateFake([]));
  });

  // --- The regression this change exists to prevent ------------------------

  it("does not match a sole candidate from an earlier cycle (March vs September)", async () => {
    mockFindByCompanyAndStage.mockImplementation(
      looseCandidateFake([existingEvent("2026-03-14")]), // ~190 days earlier
    );

    const result = await matchEventV2(incoming());

    // Previously matched as "loose" and was applied as a reschedule, rewriting
    // the March event's date and regenerating its eventKey.
    expect(result).toBeNull();
  });

  it("does not match a sole candidate from a later cycle", async () => {
    mockFindByCompanyAndStage.mockImplementation(
      looseCandidateFake([existingEvent("2027-03-14")]),
    );

    expect(await matchEventV2(incoming())).toBeNull();
  });

  // --- Window boundary (inclusive, mirroring the repository's gte/lte) ------

  it("matches a sole candidate exactly 30 days earlier", async () => {
    mockFindByCompanyAndStage.mockImplementation(
      looseCandidateFake([existingEvent("2026-08-21")]),
    );

    const result = await matchEventV2(incoming());

    expect(result).toMatchObject({ matchType: "loose", confidence: 0.6 });
  });

  it("matches a sole candidate exactly 30 days later", async () => {
    mockFindByCompanyAndStage.mockImplementation(
      looseCandidateFake([existingEvent("2026-10-20")]),
    );

    const result = await matchEventV2(incoming());

    expect(result).toMatchObject({ matchType: "loose", confidence: 0.6 });
  });

  it("does not match a sole candidate 31 days earlier", async () => {
    mockFindByCompanyAndStage.mockImplementation(
      looseCandidateFake([existingEvent("2026-08-20")]),
    );

    expect(await matchEventV2(incoming())).toBeNull();
  });

  it("does not match a sole candidate 31 days later", async () => {
    mockFindByCompanyAndStage.mockImplementation(
      looseCandidateFake([existingEvent("2026-10-21")]),
    );

    expect(await matchEventV2(incoming())).toBeNull();
  });

  // --- The tier's purpose is preserved --------------------------------------

  it("still matches a sole candidate inside the window but outside the soft window", async () => {
    // 10 days apart: too far for tier 2 (±3), well inside tier 3's bound. This
    // is the reschedule-catching case the loose tier exists for.
    mockFindByCompanyAndStage.mockImplementation(
      looseCandidateFake([existingEvent("2026-09-30")]),
    );

    const result = await matchEventV2(incoming());

    expect(result).toMatchObject({
      event: expect.objectContaining({ id: 1 }),
      matchType: "loose",
      confidence: 0.6,
    });
  });

  // --- Uniqueness rule unchanged --------------------------------------------

  it("does not match when two candidates fall inside the window", async () => {
    mockFindByCompanyAndStage.mockImplementation(
      looseCandidateFake([
        existingEvent("2026-09-25", { id: 1 }),
        existingEvent("2026-10-05", { id: 2 }),
      ]),
    );

    expect(await matchEventV2(incoming())).toBeNull();
  });

  it("does not match a different round for the same company", async () => {
    mockFindByCompanyAndStage.mockImplementation(
      looseCandidateFake([existingEvent("2026-09-25", { stage: "Interview" })]),
    );

    expect(await matchEventV2(incoming())).toBeNull();
  });

  // --- Intended behaviour change (see PR: narrowing removes spurious ambiguity)

  it("matches when only one of several all-time candidates falls inside the window", async () => {
    // Before AC-1 the far candidate made the set ambiguous (length 2), so no
    // match was returned and a duplicate September event was created. The far
    // candidate was never a plausible match, so excluding it is a correction.
    mockFindByCompanyAndStage.mockImplementation(
      looseCandidateFake([
        existingEvent("2026-03-14", { id: 1 }),
        existingEvent("2026-09-25", { id: 2 }),
      ]),
    );

    const result = await matchEventV2(incoming());

    expect(result).toMatchObject({
      event: expect.objectContaining({ id: 2 }),
      matchType: "loose",
    });
  });

  // --- The service must request the bound (the only unit-level guarantee, as
  // --- the predicate itself executes in SQL) ---------------------------------

  it("requests the configured window from the repository", async () => {
    await matchEventV2(incoming());

    expect(mockFindByCompanyAndStage).toHaveBeenCalledWith({
      company: "amazon",
      stage: "OA",
      date: OBSERVED_ON,
      windowDays: LOOSE_MATCH_WINDOW_DAYS,
    });
  });
});

describe("matchEventV2 - tier 1 and tier 2 unaffected by AC-1", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindByEventKey.mockResolvedValue(null);
    mockFindNearbyEvents.mockResolvedValue([]);
    mockFindByCompanyAndStage.mockImplementation(looseCandidateFake([]));
  });

  it("tier 1 still short-circuits before the soft and loose tiers", async () => {
    mockFindByEventKey.mockResolvedValue(existingEvent(OBSERVED_ON));

    const result = await matchEventV2(incoming());

    expect(result).toMatchObject({ matchType: "exact", confidence: 1.0 });
    expect(mockFindNearbyEvents).not.toHaveBeenCalled();
    expect(mockFindByCompanyAndStage).not.toHaveBeenCalled();
  });

  it("tier 2 still matches a candidate 1 day earlier and never reaches the loose tier", async () => {
    mockFindNearbyEvents.mockResolvedValue([existingEvent("2026-09-19")]);

    const result = await matchEventV2(incoming());

    expect(result).toMatchObject({ matchType: "soft" });
    expect(mockFindByCompanyAndStage).not.toHaveBeenCalled();
  });

  it("tier 2 still matches a candidate 3 days earlier and never reaches the loose tier", async () => {
    mockFindNearbyEvents.mockResolvedValue([existingEvent("2026-09-17")]);

    const result = await matchEventV2(incoming());

    expect(result).toMatchObject({ matchType: "soft" });
    expect(mockFindByCompanyAndStage).not.toHaveBeenCalled();
  });
});
