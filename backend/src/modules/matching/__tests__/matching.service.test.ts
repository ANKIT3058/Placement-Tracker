import { matchEventV2 } from "../matching.service";
import * as repo from "../../event/event.repository";

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
