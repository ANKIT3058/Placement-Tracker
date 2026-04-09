import { extractVenue } from "../email.parser";

describe("extractVenue", () => {
  test("valid venue", () => {
    const result = extractVenue("OA on HackerRank");
    expect(result).toEqual({ value: "hackerrank", isExplicit: true });
  });

  test("invalid venue (PFA)", () => {
    const result = extractVenue("venue: PFA seating plan");
    expect(result).toEqual({ value: null, isExplicit: true });
  });

  test("no venue mention", () => {
    const result = extractVenue("Amazon OA on 20th Aug");
    expect(result).toEqual({ value: null, isExplicit: false });
  });
});
