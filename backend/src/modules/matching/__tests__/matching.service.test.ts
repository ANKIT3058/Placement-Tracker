import { matchEventV2 } from "../matching.service";
import * as repo from "../../event/event.repository";

jest.mock("../../event/event.repository", () => ({
  findNearbyEvents: jest.fn(),
  findByEventKey: jest.fn(),
  findByCompanyAndStage: jest.fn(),
}));

describe("Matching Logic", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should pick highest confidence match", async () => {
    const events = [
      { id: 1, date: "2026-08-20", stage: "OA", confidence: 0.9 },
      { id: 2, date: "2026-08-21", stage: "OA", confidence: 0.4 },
    ];

    (repo.findNearbyEvents as jest.Mock).mockResolvedValue(events);

    const incoming = {
      company: "amazon",
      stage: "OA",
      date: "2026-08-20",
      confidence: 0.5,
    };

    const result = await matchEventV2(incoming);

    expect(result?.event?.id).toBe(1);
    expect(result?.explanation).toContain("Exact date match");
  });
});
