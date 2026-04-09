import { computeConfidence } from "../confidence.utils";

describe("computeConfidence", () => {
  it("should give high confidence for complete data", () => {
    const result = computeConfidence({
      company: "Amazon",
      date: new Date(),
      time: "10:00 AM",
      stage: "OA",
      venueMeta: { value: "Zoom", isExplicit: true },
    });

    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("should reduce confidence for vague date", () => {
    const result = computeConfidence({
      company: "Amazon",
      date: new Date(),
      time: "10:00 AM",
      stage: "OA",
      venueMeta: { value: "Zoom", isExplicit: true },
      rawText: "next week",
    });

    expect(result.breakdown.date).toBeLessThan(1);
  });

  it("should penalize missing fields", () => {
    const result = computeConfidence({
      company: null,
      date: null,
      time: null,
      stage: null,
    });

    expect(result.confidence).toBeLessThan(0.3);
  });
});
