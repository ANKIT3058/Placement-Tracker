import { validateAIDate } from "../extraction.utils";
import { extractExactDate, findDateEvidence } from "../../email/email.parser";

// ---------------------------------------------------------------------------
// AI Date Evidence Correctness.
//
// The AI can turn incomplete temporal information ("in 2027", "August 2027")
// into a fully-formed but fabricated "YYYY-MM-DD" candidate. A full calendar
// date may only be accepted when the source contains enough evidence to
// support its day and month — a standalone year or month/year is temporal
// information, but it is not an exact event date.
// ---------------------------------------------------------------------------

describe("validateAIDate", () => {
  test("accepts an explicit full date the AI echoes back", () => {
    const source = "The placement drive is scheduled for 16th August 2027.";
    expect(validateAIDate("2027-08-16", source)).toBe("2027-08-16");
  });

  test("accepts a legitimate January 1st date — not a blanket '-01-01' rejection", () => {
    const source = "The interview is scheduled for 1st January 2027.";
    expect(validateAIDate("2027-01-01", source)).toBe("2027-01-01");
  });

  test("accepts a day+month mention with no explicit year, using the current-year default", () => {
    // Mirrors extractExactDate's own "no year given -> current year" behaviour,
    // so the validator doesn't reject dates the deterministic extractor itself
    // would have produced.
    const currentYear = new Date().getUTCFullYear();
    const source = "The interview is scheduled for 16th August.";
    expect(validateAIDate(`${currentYear}-08-16`, source)).toBe(
      `${currentYear}-08-16`,
    );
  });

  test("rejects a standalone year turned into January 1st", () => {
    const source = "The placement drive will take place in 2027.";
    expect(validateAIDate("2027-01-01", source)).toBeNull();
  });

  test("rejects a month+year turned into the 1st of the month", () => {
    const source = "The placement drive will take place in August 2027.";
    expect(validateAIDate("2027-08-01", source)).toBeNull();
  });

  test("rejects an AI candidate with no supporting evidence in the source", () => {
    const source = "The interview is scheduled for 16th August 2027.";
    // The email says the 16th; the AI hallucinated the 17th.
    expect(validateAIDate("2027-08-17", source)).toBeNull();
  });

  describe("multiple dates in one email", () => {
    const source =
      "Application closes on 10 August 2027. Interview will be on 16 August 2027.";

    test("accepts the second date when the AI selects it", () => {
      expect(validateAIDate("2027-08-16", source)).toBe("2027-08-16");
    });

    test("accepts the first date when the AI selects it", () => {
      expect(validateAIDate("2027-08-10", source)).toBe("2027-08-10");
    });

    test("rejects a candidate that matches neither date, even though the month/year appear in the source", () => {
      expect(validateAIDate("2027-08-11", source)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // A quoted/forwarded thread carries real, well-formed dates belonging to
  // OTHER emails. `cleanEmail` already exists to strip that history out of
  // deterministic extraction (see parser.test.ts); the AI evidence validator
  // must be checked against the same current-message-only text, or a date
  // that appears nowhere in the message actually sent could authorize an AI
  // candidate anyway.
  // -------------------------------------------------------------------------
  describe("quoted/forwarded history is not evidence", () => {
    test("rejects a date that appears only inside a quoted reply chain", () => {
      const source = [
        "The interview details will be shared soon.",
        "",
        "On Tue, Jul 29, 2025 at 2:30 PM placements 2k27 <placements2k27@gmail.com>",
        "wrote:",
        "",
        "> Interview scheduled for 29 July 2025.",
      ].join("\n");

      expect(validateAIDate("2025-07-29", source)).toBeNull();
    });

    test("accepts a date in the current message even when the quoted thread mentions a different one", () => {
      const source = [
        "Interview scheduled for 29 July 2025.",
        "",
        "On Mon, Jan 5, 2024 at 11:00 AM someone <a@b.com> wrote:",
        "> Interview scheduled for 10 August 2025.",
      ].join("\n");

      expect(validateAIDate("2025-07-29", source)).toBe("2025-07-29");
    });
  });

  describe("missing AI output", () => {
    const source = "The interview is scheduled for 16th August 2027.";

    test("null candidate", () => {
      expect(validateAIDate(null, source)).toBeNull();
    });

    test("undefined candidate", () => {
      expect(validateAIDate(undefined, source)).toBeNull();
    });

    test("empty string candidate", () => {
      expect(validateAIDate("", source)).toBeNull();
    });

    test("malformed candidate is never trusted as a date", () => {
      expect(validateAIDate("not-a-date", source)).toBeNull();
      expect(validateAIDate("2027-13-01", source)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: existing current-year resolution for the deterministic
// extractor must be unchanged by the findDateEvidence refactor.
// ---------------------------------------------------------------------------

describe("extractExactDate current-year behavior is preserved", () => {
  test("day+month with no year resolves to the current UTC year", () => {
    const currentYear = new Date().getUTCFullYear();
    const result = extractExactDate("Interview on 16th August");
    expect(result?.toISOString().split("T")[0]).toBe(`${currentYear}-08-16`);
  });

  test("day+month+year keeps the explicit year", () => {
    const result = extractExactDate("Interview on 16th August 2025");
    expect(result?.toISOString().split("T")[0]).toBe("2025-08-16");
  });
});

describe("findDateEvidence", () => {
  test("finds every day+month mention, not just the first", () => {
    const source =
      "Application closes on 10 August 2027. Interview will be on 16 August 2027.";
    expect(findDateEvidence(source)).toEqual([
      { day: 10, month: 7, year: 2027 },
      { day: 16, month: 7, year: 2027 },
    ]);
  });

  test("finds nothing for a standalone year", () => {
    expect(findDateEvidence("The drive will take place in 2027.")).toEqual([]);
  });

  test("finds nothing for month+year alone", () => {
    expect(
      findDateEvidence("The drive will take place in August 2027."),
    ).toEqual([]);
  });
});
