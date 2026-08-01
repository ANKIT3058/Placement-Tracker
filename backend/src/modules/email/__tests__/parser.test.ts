import {
  extractVenue,
  extractCompany,
  extractData,
  isResolvedCompany,
  UNRESOLVED_COMPANY,
} from "../email.parser";

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

// ---------------------------------------------------------------------------
// AC-4 / D-10: "unknown" is a record of extraction failure, not a company.
//
// Extraction is deliberately UNCHANGED — it still emits the placeholder exactly
// as before. What changed is that the viability gate now recognises it as a
// missing company instead of a truthy value. These tests pin both halves: the
// extractor's output, and the predicate that classifies it.
// ---------------------------------------------------------------------------

describe("company extraction output is unchanged (AC-4)", () => {
  test("still emits the placeholder when no company is present", () => {
    expect(extractCompany("OA on 20th Aug at 10 AM")).toBe(UNRESOLVED_COMPANY);
    expect(UNRESOLVED_COMPANY).toBe("unknown");
  });

  test("still extracts a real company", () => {
    expect(extractCompany("Amazon is visiting on 20th Aug")).toBe("amazon");
    expect(extractCompany("Test by Amazon")).toBe("amazon");
  });

  test("still leaves the 'by <company>' trailing-word quirk in place", () => {
    // Pre-existing and deliberately unchanged by AC-4: the "by <company>"
    // pattern does not strip trailing clause words the way the "at <company>"
    // pattern does, so a following "on" is captured into the name. Pinned here
    // so the quirk is visible and so AC-4 cannot be blamed for it later.
    expect(extractCompany("Test by Amazon on 20th Aug")).toBe("amazon on");
  });

  test("extractData still reports an unresolved company as the placeholder", () => {
    const result = extractData("Interview on 20th Aug at 10 AM");
    expect(result.company).toBe(UNRESOLVED_COMPANY);
  });

  test("extractData still reports a resolved company", () => {
    const result = extractData("Google is visiting on 20th Aug at 10 AM");
    expect(result.company).toBe("google");
  });
});

describe("isResolvedCompany (AC-4)", () => {
  test.each([
    ["unknown", false],
    ["UNKNOWN", false],
    ["  unknown  ", false],
    ["", false],
    ["   ", false],
    [null, false],
    [undefined, false],
    ["amazon", true],
    ["Amazon India", true],
    ["unknown systems", true], // a real name that merely contains the word
  ])("isResolvedCompany(%p) === %s", (input, expected) => {
    expect(isResolvedCompany(input)).toBe(expected);
  });
});
