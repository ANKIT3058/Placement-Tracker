import {
  cleanEmail,
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

// ---------------------------------------------------------------------------
// Quoted-chain removal.
//
// A reply carries the thread it answers, and that thread holds real dates
// belonging to other events. Both extractors read the whole body, so a quoted
// header's date is indistinguishable from the current one — which is how a
// Bajaj Auto reply produced an Interview on 2025-07-29, a date present only in
// its quoted attribution line.
//
// These tests pin the boundary in both directions: history is dropped, and the
// message actually sent is kept intact.
// ---------------------------------------------------------------------------

describe("cleanEmail drops quoted history", () => {
  test("Gmail reply chain — the wrapped attribution line and everything after", () => {
    // Reproduces the real Bajaj body: the line breaks immediately before
    // "wrote:", which is why the boundary pattern has to span newlines.
    const body = [
      "Dear All,",
      "",
      "Interview for Bajaj Auto Ltd. is on 28th July 2026 at 9:00 AM.",
      "",
      "Regards,",
      "Team TPO.",
      "",
      "On Tue, Jul 29, 2025 at 2:30 PM placements 2k27 <placements2k27@gmail.com>",
      "wrote:",
      "",
      "> Dear All,",
      "> Selected for the 2-month summer internship role.",
    ].join("\n");

    const result = cleanEmail(body);

    expect(result).toContain("28th July 2026");
    expect(result).not.toContain("Jul 29, 2025");
    expect(result).not.toContain("wrote:");
    expect(result).not.toContain(">");
  });

  test("Gmail reply chain — attribution on a single line", () => {
    const body = [
      "OA is on 20th Aug 2026.",
      "On Mon, Jan 5, 2024 at 11:00 AM someone <a@b.com> wrote:",
      "> old thread",
    ].join("\n");

    const result = cleanEmail(body);

    expect(result).toBe("OA is on 20th Aug 2026.");
  });

  test("forwarded email — Gmail separator", () => {
    const body = [
      "FYI — please register.",
      "",
      "---------- Forwarded message ---------",
      "From: TPO <tpo@example.com>",
      "Date: Tue, 29 Jul 2025 at 14:30",
      "Subject: Bajaj Auto Ltd.",
      "",
      "Interview on 29th July 2025.",
    ].join("\n");

    const result = cleanEmail(body);

    expect(result).toBe("FYI — please register.");
    expect(result).not.toContain("29th July 2025");
  });

  test("forwarded email — Outlook original-message separator", () => {
    const body = [
      "Sharing below.",
      "",
      "-----Original Message-----",
      "Interview on 29th July 2025.",
    ].join("\n");

    expect(cleanEmail(body)).toBe("Sharing below.");
  });

  test("forwarded email — Outlook From:/Sent: header block", () => {
    const body = [
      "Please note the update.",
      "",
      "From: TPO <tpo@example.com>",
      "Sent: Tuesday, July 29, 2025 2:30 PM",
      "Subject: Bajaj Auto Ltd.",
      "",
      "Interview on 29th July 2025.",
    ].join("\n");

    const result = cleanEmail(body);

    expect(result).toBe("Please note the update.");
    expect(result).not.toContain("29th July 2025");
  });

  test("signature delimiter ends the message", () => {
    const body = [
      "PPT on 5th Aug 2026 at 10:00 AM.",
      "-- ",
      "You received this message because you are subscribed to Google Groups.",
    ].join("\n");

    const result = cleanEmail(body);

    expect(result).toBe("PPT on 5th Aug 2026 at 10:00 AM.");
    expect(result).not.toContain("Google Groups");
  });
});

describe("cleanEmail preserves current content", () => {
  test("normal placement email is untouched apart from whitespace", () => {
    const body = [
      "Dear All,",
      "",
      "This is to inform you that the Interview for Bajaj Auto Ltd. is scheduled.",
      "Date: 28th July 2026",
      "Time: 9:00 AM onwards",
      "Venue: Seminar Hall",
    ].join("\n");

    expect(cleanEmail(body)).toBe(
      "Dear All, This is to inform you that the Interview for Bajaj Auto Ltd. " +
        "is scheduled. Date: 28th July 2026 Time: 9:00 AM onwards Venue: Seminar Hall",
    );
  });

  test("whitespace normalisation is unchanged", () => {
    expect(cleanEmail("  a\n\n  b \t c  ")).toBe("a b c");
    expect(cleanEmail("")).toBe("");
    expect(cleanEmail(null as unknown as string)).toBe("");
  });

  test("prose that merely mentions the boundary words is not cut", () => {
    const body =
      "On campus interviews start soon. From the TPO desk: register by 5th Aug 2026.";

    expect(cleanEmail(body)).toBe(body);
  });

  // A bare forward has no covering note, so cutting at the boundary would leave
  // nothing and lose an event the pipeline extracts correctly today. Falling
  // back to the full body keeps the old behaviour as the floor.
  test("a body that is only quoted history falls back to the full text", () => {
    const body = [
      "---------- Forwarded message ---------",
      "From: TPO <tpo@example.com>",
      "",
      "Interview on 28th July 2026 at 9:00 AM.",
    ].join("\n");

    expect(cleanEmail(body)).toContain("28th July 2026");
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
