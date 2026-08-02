import { matchEventV2 as matchEventV2Scoped } from "../matching.service";
import { UNOWNED } from "../../auth/tenant-context";
import * as repo from "../../event/event.repository";
import * as matchingUtils from "../matching.utils";
import { LOOSE_MATCH_WINDOW_DAYS } from "../../../shared/constants/config";

jest.mock("../../event/event.repository", () => ({
  findNearbyEvents: jest.fn(),
  findByEventKey: jest.fn(),
  findByCompanyAndStage: jest.fn(),
}));

// AC-2 / ADR-006. `scoreEventMatch` is WRAPPED, not replaced: the real scoring
// runs exactly as before, but its call history becomes observable. The identity
// gate's contract is that a contradicted candidate is never scored at all, and
// that is only provable by asserting on what the scorer was never asked to
// evaluate — an assertion about the outcome alone cannot distinguish "vetoed"
// from "scored and happened to lose".
jest.mock("../matching.utils", () => {
  const actual = jest.requireActual("../matching.utils");
  return {
    ...actual,
    scoreEventMatch: jest.fn(actual.scoreEventMatch),
  };
});

const mockFindByEventKey = repo.findByEventKey as jest.Mock;
const mockFindNearbyEvents = repo.findNearbyEvents as jest.Mock;
const mockFindByCompanyAndStage = repo.findByCompanyAndStage as jest.Mock;
const mockScoreEventMatch = matchingUtils.scoreEventMatch as jest.Mock;

// The set of candidate ids `scoreEventMatch` was actually invoked with.
const scoredCandidateIds = (): number[] =>
  mockScoreEventMatch.mock.calls.map((call: any[]) => call[0].event.id);

// AC-5.7. Recognition is now bounded by owner. Every assertion in this file
// predates ownership and describes records that have none, so the suite runs in
// the null tenant — which is exactly the tenant every pre-existing record
// belongs to, and therefore exactly the behaviour these tests were written
// against.
//
// Wrapped here rather than editing the call sites individually: this file is the
// ADR-006 and AC-1 regression suite, and rewriting forty assertions to thread a
// parameter would be a diff large enough for a real behavioural change to hide
// inside. The assertions stay byte-identical.
const matchEventV2 = (data: any) => matchEventV2Scoped(UNOWNED, data);

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
  // Pre-AC-2 this passed only because the candidate was placed 2 days apart, so
  // the date term alone could not clear the threshold — at Δ=0 or Δ=1 the same
  // shape produced a merge (D-1). Post-AC-2 the distance is irrelevant: the
  // round contradicts, so the candidate is vetoed before it is ever scored. The
  // distance is left as-is to keep this a genuine regression test of the old
  // arithmetic path; the Δ=0 case is covered exhaustively further down.
  it("returns no match when a nearby event is the same company but a different stage", async () => {
    const nearby = {
      id: 4,
      company: "amazon",
      stage: "Interview", // different stage from incoming "OA"
      date: "2026-08-22",
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
  // AC-5.7: `findByCompanyAndStage` now takes the owner first. The fake ignores
  // it — every record in `store` is unowned, matching the tenant this suite runs
  // in — but it must accept it, or the query object lands in the wrong position.
  (_owner: any, { company, stage, date, windowDays }: any) => {
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

    expect(mockFindByCompanyAndStage).toHaveBeenCalledWith(UNOWNED, {
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

// ---------------------------------------------------------------------------
// AC-2 / ADR-006: Identity Precedes Similarity.
//
// Tier 2 previously decided identity WITH the similarity score: the date term
// alone (0.5 × 1.0) equalled the acceptance threshold, so an exact date match
// cleared the bar with zero contribution from the round — an identity
// attribute. Two different rounds on one day merged (D-1).
//
// Identity is now classified categorically BEFORE any scoring:
//   AGREES      -> eligible
//   UNKNOWN     -> eligible  (silence is not denial; not a contradiction)
//   CONTRADICTS -> vetoed, and never scored
//
// Only tier 2 changes. Tier 1 and tier 3 are asserted unchanged below.
// ---------------------------------------------------------------------------

describe("matchEventV2 - identity gate precedes similarity (AC-2 / ADR-006)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindByEventKey.mockResolvedValue(null); // force the tier-2 path
    mockFindNearbyEvents.mockResolvedValue([]);
    mockFindByCompanyAndStage.mockResolvedValue([]);
  });

  // --- 1. Same company, same round, same day -> MATCH ----------------------

  it("matches when company, round and day all agree", async () => {
    const candidate = existingEvent(OBSERVED_ON); // stage "OA", Δ=0
    mockFindNearbyEvents.mockResolvedValue([candidate]);

    const result = await matchEventV2(incoming());

    expect(result).toMatchObject({
      event: expect.objectContaining({ id: 1 }),
      matchType: "soft",
    });
    expect(result?.explanation).toContain("Exact date match");
    expect(result?.explanation).toContain("Stage matched");
    // Identity agreed, so the candidate was eligible and WAS scored.
    expect(scoredCandidateIds()).toEqual([1]);
  });

  // --- 2. Same company, different round, same day -> vetoed pre-similarity --

  it("rejects a contradicting round BEFORE similarity is evaluated", async () => {
    // Δ=0 and both sides highly confident: under the old scoring this reached
    // 0.5 + 0.2×0.9 = 0.68 and merged.
    const candidate = existingEvent(OBSERVED_ON, {
      id: 7,
      stage: "Interview",
      confidence: 0.9,
    });
    mockFindNearbyEvents.mockResolvedValue([candidate]);

    const result = await matchEventV2(incoming({ confidence: 0.9 }));

    expect(result).toBeNull();
    // The load-bearing assertion: the veto happened before scoring, not after.
    expect(mockScoreEventMatch).not.toHaveBeenCalled();
  });

  // --- 3. Same company, unknown round, same day -> UNKNOWN, retained -------

  it("retains a candidate when the incoming round is unknown", async () => {
    const candidate = existingEvent(OBSERVED_ON, { stage: "OA" });
    mockFindNearbyEvents.mockResolvedValue([candidate]);

    const result = await matchEventV2(incoming({ stage: "unknown" }));

    // UNKNOWN is not a contradiction: the candidate stays eligible and
    // similarity decides.
    expect(scoredCandidateIds()).toEqual([1]);
    expect(result).toMatchObject({
      event: expect.objectContaining({ id: 1 }),
      matchType: "soft",
    });
  });

  // --- 4. Round extraction failure -> UNKNOWN -> still eligible ------------

  it.each([
    ["the sentinel string", "unknown"],
    ["a null round", null],
    ["an empty round", ""],
    ["a whitespace round", "   "],
  ])("treats %s as UNKNOWN and keeps the candidate eligible", async (_label, stage) => {
    const candidate = existingEvent(OBSERVED_ON, { stage: "OA" });
    mockFindNearbyEvents.mockResolvedValue([candidate]);

    const result = await matchEventV2(incoming({ stage } as any));

    expect(scoredCandidateIds()).toEqual([1]);
    expect(result).toMatchObject({ matchType: "soft" });
  });

  it("treats an unresolved round on the STORED event as UNKNOWN, not agreement", async () => {
    // A stored event whose round was never extracted must not be treated as
    // agreeing with an incoming "unknown" — that would assert identity from
    // mutual ignorance.
    expect(matchingUtils.classifyRoundIdentity("unknown", "unknown")).toBe(
      "UNKNOWN",
    );

    const candidate = existingEvent(OBSERVED_ON, { stage: "unknown" });
    mockFindNearbyEvents.mockResolvedValue([candidate]);

    const result = await matchEventV2(incoming({ stage: "OA" }));

    // Still eligible — UNKNOWN never vetoes — so similarity ranks it.
    expect(scoredCandidateIds()).toEqual([1]);
    expect(result).toMatchObject({ matchType: "soft" });
  });

  // --- 5. Two nearby candidates: correct round wins ------------------------

  it("selects the correct round even when the wrong round scores higher", async () => {
    // Recognition Decision Matrix row D4. Pre-AC-2:
    //   wrong round, Δ=0, c=0.8 -> 0.50 + 0.16 = 0.66  <- won
    //   right round, Δ=2, c=0.3 -> 0.55 + 0.06 = 0.61
    // The wrong-round event out-competed the correct one purely by being more
    // confident. It is now vetoed and never scored.
    const wrongRound = existingEvent(OBSERVED_ON, {
      id: 2,
      stage: "Interview",
      confidence: 0.9,
    });
    const rightRound = existingEvent("2026-09-22", {
      id: 3,
      stage: "OA",
      confidence: 0.3,
    });
    mockFindNearbyEvents.mockResolvedValue([wrongRound, rightRound]);

    const result = await matchEventV2(incoming({ confidence: 0.8 }));

    expect(result?.event?.id).toBe(3);
    expect(scoredCandidateIds()).toEqual([3]);
  });

  // --- 8. Regression: D-1 is unreachable ----------------------------------

  const DELTA_DATES: [number, string][] = [
    [0, "2026-09-20"],
    [1, "2026-09-21"],
    [2, "2026-09-22"],
    [3, "2026-09-23"],
  ];
  const CONFIDENCES = [0, 0.25, 0.5, 0.75, 1.0];

  describe("D-1 regression sweep: a contradicting round can never match", () => {
    for (const [delta, date] of DELTA_DATES) {
      for (const confidence of CONFIDENCES) {
        it(`Δ=${delta}, c=${confidence} -> no match, never scored`, async () => {
          mockFindNearbyEvents.mockResolvedValue([
            existingEvent(date, { id: 9, stage: "Interview", confidence }),
          ]);

          const result = await matchEventV2(
            incoming({ stage: "OA", confidence }),
          );

          expect(result).toBeNull();
          expect(mockScoreEventMatch).not.toHaveBeenCalled();
        });
      }
    }
  });

  // --- Named edge cases from the AC-2 brief --------------------------------

  it("edge case: stored Google OA + incoming Google UNKNOWN, same day -> eligible", async () => {
    const stored = {
      id: 11,
      company: "google",
      stage: "OA",
      date: "2026-09-10",
      confidence: 0.9,
    };
    mockFindNearbyEvents.mockResolvedValue([stored]);

    const result = await matchEventV2({
      company: "google",
      stage: "unknown",
      date: "2026-09-10",
      confidence: 0.8,
    });

    expect(matchingUtils.classifyRoundIdentity("OA", "unknown")).toBe("UNKNOWN");
    expect(mockScoreEventMatch).toHaveBeenCalled(); // similarity WAS evaluated
    expect(result).toMatchObject({ event: stored, matchType: "soft" });
  });

  it("edge case: stored Google OA + incoming Google Interview, same day -> vetoed", async () => {
    const stored = {
      id: 12,
      company: "google",
      stage: "OA",
      date: "2026-09-10",
      confidence: 0.9,
    };
    mockFindNearbyEvents.mockResolvedValue([stored]);

    const result = await matchEventV2({
      company: "google",
      stage: "Interview",
      date: "2026-09-10",
      confidence: 0.8,
    });

    expect(matchingUtils.classifyRoundIdentity("OA", "Interview")).toBe(
      "CONTRADICTS",
    );
    expect(result).toBeNull();
    expect(mockScoreEventMatch).not.toHaveBeenCalled();
  });

  // --- Mixed sets: the veto is per-candidate, not per-batch -----------------

  it("vetoes only the contradicting candidate and scores the rest", async () => {
    const contradicting = existingEvent(OBSERVED_ON, {
      id: 21,
      stage: "PPT",
      confidence: 0.9,
    });
    const agreeing = existingEvent("2026-09-21", { id: 22, stage: "OA" });
    const unknownRound = existingEvent("2026-09-19", {
      id: 23,
      stage: "unknown",
    });
    mockFindNearbyEvents.mockResolvedValue([
      contradicting,
      agreeing,
      unknownRound,
    ]);

    const result = await matchEventV2(incoming());

    expect(scoredCandidateIds()).toEqual([22, 23]); // 21 never scored
    expect(result?.event?.id).toBe(22); // agreeing round outranks unknown
  });
});

// ---------------------------------------------------------------------------
// 6 & 7: tiers 1 and 3 are explicitly out of AC-2's scope.
// ---------------------------------------------------------------------------

describe("matchEventV2 - tier 1 and tier 3 unaffected by AC-2", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindByEventKey.mockResolvedValue(null);
    mockFindNearbyEvents.mockResolvedValue([]);
    mockFindByCompanyAndStage.mockResolvedValue([]);
  });

  it("tier 1: an exact key hit is still accepted unconditionally, with no identity gate", async () => {
    const existing = existingEvent(OBSERVED_ON);
    mockFindByEventKey.mockResolvedValue(existing);

    const result = await matchEventV2(incoming());

    expect(result).toMatchObject({
      event: existing,
      matchType: "exact",
      confidence: 1.0,
    });
    expect(mockFindNearbyEvents).not.toHaveBeenCalled();
    expect(mockFindByCompanyAndStage).not.toHaveBeenCalled();
    expect(mockScoreEventMatch).not.toHaveBeenCalled();
  });

  it("tier 1: an unresolved round still produces a key and is still looked up", async () => {
    // AC-2 does not change key construction. Documented as unchanged so a later
    // change to it is a deliberate decision rather than a side effect.
    const existing = { ...existingEvent(OBSERVED_ON), stage: "unknown" };
    mockFindByEventKey.mockResolvedValue(existing);

    const result = await matchEventV2(incoming({ stage: "unknown" }));

    expect(mockFindByEventKey).toHaveBeenCalledWith(UNOWNED, "amazon|unknown|2026-09-20");
    expect(result).toMatchObject({ matchType: "exact", confidence: 1.0 });
  });

  it("tier 3: a sole in-window candidate still matches at fixed confidence 0.6", async () => {
    mockFindByCompanyAndStage.mockResolvedValue([existingEvent("2026-09-30")]);

    const result = await matchEventV2(incoming());

    expect(result).toMatchObject({ matchType: "loose", confidence: 0.6 });
    // Tier 3 has no identity gate: it filters on round in the repository query.
    expect(mockScoreEventMatch).not.toHaveBeenCalled();
  });

  it("tier 3: the AC-1 window and uniqueness rule are unchanged", async () => {
    mockFindByCompanyAndStage.mockResolvedValue([
      existingEvent("2026-09-25", { id: 1 }),
      existingEvent("2026-10-05", { id: 2 }),
    ]);

    expect(await matchEventV2(incoming())).toBeNull();
    expect(mockFindByCompanyAndStage).toHaveBeenCalledWith(UNOWNED, {
      company: "amazon",
      stage: "OA",
      date: OBSERVED_ON,
      windowDays: LOOSE_MATCH_WINDOW_DAYS,
    });
  });
});

// ---------------------------------------------------------------------------
// AC-5.7 / RFC-001 §7.4. Tenant bounds the candidate universe.
//
// These assert propagation, not isolation: that the owner reaches every
// candidate query, at every tier, unchanged. Whether the database then honours
// it is a property of the query, verified against a real schema by the
// tenant-isolation suite in a later AC.
//
// The engine's decisions are deliberately not re-tested here. Nothing about
// admission or ranking changed, and duplicating those assertions under a
// non-null owner would imply otherwise.
// ---------------------------------------------------------------------------

describe("matchEventV2 - tenant scoping (AC-5.7 / RFC-001 §7.4)", () => {
  const OWNER = { userId: 42 };

  const observation = {
    company: "amazon",
    stage: "OA",
    date: "2026-09-20",
    confidence: 0.8,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindByEventKey.mockResolvedValue(null);
    mockFindNearbyEvents.mockResolvedValue([]);
    mockFindByCompanyAndStage.mockResolvedValue([]);
  });

  it("scopes the tier 1 identity-key lookup to the owner", async () => {
    await matchEventV2Scoped(OWNER, observation);

    expect(mockFindByEventKey).toHaveBeenCalledWith(
      OWNER,
      "amazon|OA|2026-09-20",
    );
  });

  it("scopes the tier 2 candidate query to the owner", async () => {
    await matchEventV2Scoped(OWNER, observation);

    expect(mockFindNearbyEvents).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({ company: "amazon" }),
    );
  });

  it("scopes the tier 3 uniqueness query to the owner", async () => {
    await matchEventV2Scoped(OWNER, observation);

    // Tier 3 infers identity from `looseMatches.length === 1`. That count is
    // only an identity signal if it is counted within one tenant, so this is
    // the query where scoping carries the most weight.
    expect(mockFindByCompanyAndStage).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        company: "amazon",
        stage: "OA",
        windowDays: LOOSE_MATCH_WINDOW_DAYS,
      }),
    );
  });

  it("never falls back to an unscoped query when the owner is null", async () => {
    await matchEventV2Scoped(UNOWNED, observation);

    for (const mock of [
      mockFindByEventKey,
      mockFindNearbyEvents,
      mockFindByCompanyAndStage,
    ]) {
      expect(mock).toHaveBeenCalled();
      // An unowned observation is scoped to the null tenant — it is not a
      // licence to query across every tenant.
      expect(mock.mock.calls[0][0]).toEqual(UNOWNED);
    }
  });
});
