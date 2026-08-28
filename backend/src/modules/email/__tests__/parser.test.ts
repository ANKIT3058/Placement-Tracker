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
// "at <company>" must not capture prose.
//
// Both of these reached production. `at https://track…` produced Event 76,
// `https|OA|2026-08-27`, at confidence 1.0 and status `scheduled` — the company
// scorer gives any non-placeholder string a perfect mark, so nothing downstream
// questioned it. `at least …` produced `least|OA|…`, which then MATCHED a real
// observation during the first AI-enabled run and absorbed its date, time and
// venue, so this class is not inert junk.
//
// The fix is in the pattern, not in a global noise list: these words are only
// misleading directly after "at".
// ---------------------------------------------------------------------------

describe("the 'at <company>' pattern rejects prose and links", () => {
  test("a URL after 'at' does not become the company", () => {
    const text =
      "OA on 27th Aug. For any queries please refer to the portal at https://track.example.com/abc";

    expect(extractCompany(text)).not.toBe("https");
    expect(extractCompany(text)).toBe(UNRESOLVED_COMPANY);
  });

  test.each([["http"], ["https"], ["www"]])(
    "'at %s…' does not become the company",
    (scheme) => {
      const url = scheme === "www" ? "www.example.com/x" : `${scheme}://example.com/x`;

      expect(extractCompany(`Register at ${url}`)).not.toBe(scheme);
    },
  );

  test("'at least' does not become the company", () => {
    const text = "Please join at least 15 minutes before the OA on 20th Aug";

    expect(extractCompany(text)).not.toBe("least");
    expect(extractCompany(text)).toBe(UNRESOLVED_COMPANY);
  });

  test.each([["most"], ["all"], ["once"], ["any"]])(
    "'at %s' does not become the company",
    (word) => {
      expect(extractCompany(`Submit at ${word} of the listed slots`)).not.toBe(word);
    },
  );

  // The other half of the contract: the pattern still does its job.
  test("a legitimate 'at <company>' is still extracted", () => {
    expect(extractCompany("Interview at Acme on 20th Aug")).toBe("acme");
  });

  test("a name that merely begins with a rejected word is still extracted", () => {
    // `all` is rejected only as a whole word — `\b` is what makes "allstate"
    // survive. Without it this fix would silently delete real companies.
    expect(extractCompany("Interview at Allstate on 20th Aug")).toBe("allstate");
    expect(extractCompany("Interview at Mostly Labs on 20th Aug")).toBe("mostly labs");
  });

  // A rejected match must not abort the scan — the pattern is unanchored, so a
  // real company later in the same sentence is still found.
  test("a real company after a rejected one is still found", () => {
    expect(extractCompany("Arrive at least 10 minutes early at Acme")).toBe("acme");
  });

  // -------------------------------------------------------------------------
  // The third member of the same family, and the one the previous fix missed.
  //
  // `at stipulated time on 20th aug` produced Event 55, `stipulated|Interview|
  // 2026-08-20`, at confidence 1.0. Nothing about "stipulated" is special — the
  // trailing-clause split removed "time" and handed back the adjective that was
  // modifying it. Any adjective in that position would have done the same, which
  // is why the fix is the CONTEXT ("a bare event noun means this phrase is
  // adverbial") and not the word.
  // -------------------------------------------------------------------------

  test("'at stipulated time' does not become the company", () => {
    const text = "Interview at stipulated time on 20th Aug";

    expect(extractCompany(text)).not.toBe("stipulated");
    expect(extractCompany(text)).toBe(UNRESOLVED_COMPANY);
  });

  test.each([
    ["at a later date", "Results will be shared at a later date"],
    ["at the venue", "Please report at the venue on 20th Aug"],
    ["at our office", "Interview at our office on 20th Aug"],
    ["at this location", "Assessment at this location on 20th Aug"],
  ])("prose of the same shape — %s", (_label, text) => {
    expect(extractCompany(text)).toBe(UNRESOLVED_COMPANY);
  });

  // The other side of the colon rule, and the reason the fix cannot simply
  // reject those four words. `cleanEmail` flattens a body's own lines onto one,
  // so a labelled field lands directly after the company name. Here the head IS
  // the company and must survive.
  test.each([
    ["Date", "Interview at Infosys Date: 28th July 2026"],
    ["Time", "Interview at Infosys Time: 9:00 AM"],
    ["Venue", "Interview at Infosys Venue: Seminar Hall"],
    ["Note", "Interview at Infosys Note: bring your ID card"],
  ])("a labelled %s: field after the name still leaves the name", (_l, text) => {
    expect(extractCompany(text)).toBe("infosys");
  });

  // The fix must not amount to switching "at" extraction off.
  test("a realistic single-word company is still extracted", () => {
    expect(extractCompany("Assessment at Acme on 28th August")).toBe("acme");
  });

  test("a realistic multi-word company is still extracted", () => {
    expect(extractCompany("Assessment at Hindustan Unilever on 28th August")).toBe(
      "hindustan unilever",
    );
  });

  // Through `extractData`, the function the pipeline actually calls, so the
  // result is the one that would have reached an `eventKey`.
  test.each([
    ["at stipulated time", "Interview at stipulated time on 20th Aug 2026"],
    ["at least", "Join at least 15 minutes before the OA on 20th Aug 2026"],
    ["at https", "OA on 20th Aug 2026. Register at https://track.example.com/a"],
  ])("extractData resolves no company for %s", (_label, body) => {
    expect(extractData(body).company).toBe(UNRESOLVED_COMPANY);
  });

  test("extractData still resolves a real company after 'at'", () => {
    expect(extractData("Assessment at Acme on 28th August 2026").company).toBe(
      "acme",
    );
  });

  test("isValidCompany rejects a scheme fragment arriving from anywhere", () => {
    // Defence in depth: the pattern can no longer produce these, but the
    // predicate refuses them whatever route they take.
    for (const fragment of ["https", "HTTP", "www"]) {
      expect(isResolvedCompany(fragment)).toBe(false);
    }
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
