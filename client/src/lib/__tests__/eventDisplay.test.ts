/* Company display formatting.
 *
 * WHY THIS SUITE EXISTS NOW. The backend cleanup canonicalised every
 * company to lower case, so the database no longer carries any casing
 * for the UI to pass through — `titleCase` became the only thing
 * deciding how a company reads on a card. The rule it replaced
 * capitalised after every word boundary, which a dot creates, so
 * `naukri.com` was drawn as `Naukri.Com` and `ti` as `Ti`.
 *
 * The cases below are the real shapes in the production table, not
 * invented ones: multi-word names, a legal suffix written `pvt. ltd`, a
 * job board stored as a domain, and two initialisms. */

import { describe, expect, it } from "vitest";
import { stageLabel, statusLabel, titleCase } from "../eventDisplay";

describe("titleCase", () => {
  it.each([
    ["american express", "American Express"],
    ["hindustan unilever ltd", "Hindustan Unilever Ltd"],
    ["texas instruments", "Texas Instruments"],
    ["morphle labs", "Morphle Labs"],
  ])("title-cases the multi-word name %j", (input, expected) => {
    expect(titleCase(input)).toBe(expected);
  });

  it("capitalises a single ordinary word", () => {
    expect(titleCase("infosys")).toBe("Infosys");
    expect(titleCase("zanskar")).toBe("Zanskar");
  });

  /* Rule 1: a dot with characters on both sides means the token is
     written the way it is on purpose. */
  describe("leaves dotted tokens exactly as stored", () => {
    it.each([["naukri.com"], ["d.e.shaw"], ["example.co.in"]])(
      "%j is unchanged",
      (input) => {
        expect(titleCase(input)).toBe(input);
      },
    );

    it("does not let a dotted token change the rest of the name", () => {
      expect(titleCase("acme naukri.com")).toBe("Acme naukri.com");
    });
  });

  /* Rule 2, and the boundary that keeps it honest. */
  describe("uppercases a short single-token name as an initialism", () => {
    it.each([
      ["ti", "TI"],
      ["tpo", "TPO"],
      ["hr", "HR"],
    ])("%j → %j", (input, expected) => {
      expect(titleCase(input)).toBe(expected);
    });

    it("stops at three letters, so four-letter words stay words", () => {
      expect(titleCase("cowi")).toBe("Cowi");
      expect(titleCase("titan")).toBe("Titan");
    });

    /* Restricted to single-token values on purpose: applied per token it
       would shout the joining words of a real name. */
    it("never uppercases a short word inside a longer name", () => {
      expect(titleCase("bank of america")).toBe("Bank Of America");
      expect(titleCase("arm india")).toBe("Arm India");
    });

    it("does not apply to a token that is not all lower case", () => {
      expect(titleCase("TPO")).toBe("TPO");
      expect(titleCase("Ti")).toBe("Ti");
    });
  });

  /* Rule 3, and the abbreviation that must NOT be read as a domain: the
     dot is trailing, not internal. */
  describe("legal suffixes", () => {
    it("keeps a trailing-dot abbreviation title-cased", () => {
      expect(titleCase("zeratron technologies pvt. ltd")).toBe(
        "Zeratron Technologies Pvt. Ltd",
      );
      expect(titleCase("infrasphere projects pvt. ltd")).toBe(
        "Infrasphere Projects Pvt. Ltd",
      );
    });

    it("handles a parenthesised suffix the way it always did", () => {
      expect(titleCase("kirloskar oil engines ltd (koel)")).toBe(
        "Kirloskar Oil Engines Ltd (Koel)",
      );
    });
  });

  /* The fixtures every component test uses are already capitalised, so
     this is the property that keeps this change from rewriting them. */
  describe("is stable on values that are already presentable", () => {
    it.each([["Google"], ["Amazon India"], ["Acme"], ["Warner Bros Discovery"]])(
      "%j is unchanged",
      (input) => {
        expect(titleCase(input)).toBe(input);
      },
    );
  });

  describe("degenerate input", () => {
    it("returns an empty string unchanged", () => {
      expect(titleCase("")).toBe("");
    });

    it("does not collapse the spacing it was given", () => {
      expect(titleCase("acme  corp")).toBe("Acme  Corp");
    });

    it("leaves a leading digit alone and capitalises the first letter", () => {
      expect(titleCase("3m")).toBe("3M");
    });
  });
});

/* Status wording.
 *
 * The backend's lifecycle vocabulary is storage, not sentences. These
 * pin the two properties that matter: the four values it actually
 * writes read as English, and a value it has never written yet is still
 * rendered as SOMETHING — the failure this replaces was a CSS
 * `text-transform`, which could not translate `review` and left the DOM
 * text lower case for anyone reading the accessibility tree. */

describe("statusLabel", () => {
  describe("the statuses this backend writes", () => {
    it.each([
      ["scheduled", "Scheduled"],
      ["confirmed", "Confirmed"],
      ["rescheduled", "Rescheduled"],
    ])("%j → %j", (input, expected) => {
      expect(statusLabel(input)).toBe(expected);
    });

    /* The one real translation: a queue name on the server, a reason to
       the person reading it. */
    it("names the review queue in the student's terms", () => {
      expect(statusLabel("review")).toBe("Needs review");
    });
  });

  /* The point of the fallback: the backend may add a status tomorrow and
     no card may break because of it. */
  describe("a status the frontend has never seen", () => {
    it("still reads as a word", () => {
      expect(statusLabel("something-new")).toBe("Something new");
    });

    it.each([
      ["cancelled", "Cancelled"],
      ["on_hold", "On hold"],
      ["awaiting_confirmation", "Awaiting confirmation"],
    ])("%j → %j", (input, expected) => {
      expect(statusLabel(input)).toBe(expected);
    });

    /* Sentence case, not Title Case: only the first letter is raised, so
       an acronym in a future value survives intact. */
    it("does not lower-case the rest of the value", () => {
      expect(statusLabel("OA_pending")).toBe("OA pending");
    });

    it("never returns an empty string", () => {
      expect(statusLabel("")).toBe("Unknown");
      expect(statusLabel("   ")).toBe("Unknown");
    });

    it("never returns undefined for any input", () => {
      for (const value of ["", "x", "a-b-c", "ALLCAPS", "1"]) {
        expect(typeof statusLabel(value)).toBe("string");
        expect(statusLabel(value)).not.toBe("");
      }
    });
  });
});

/* Stage wording.
 *
 * Stages are free text — the extractor emits four canonical ones and
 * ReviewCard lets a human retype the field freehand — so this must stay
 * a pass-through with exactly one substitution, not a dictionary that
 * silently drops rounds it was not taught. */

describe("stageLabel", () => {
  describe("passes real stages through untouched", () => {
    it.each([
      ["OA"],
      ["Interview"],
      ["PPT"],
      ["Registration"],
      ["Online Assessment"],
      ["Pre-Placement Talk"],
    ])("%j is unchanged", (input) => {
      expect(stageLabel(input)).toBe(input);
    });

    /* A round nobody has taught this function about still reaches the
       badge verbatim — the alternative would be hiding it. */
    it("passes an unrecognised round through as written", () => {
      expect(stageLabel("Group Discussion")).toBe("Group Discussion");
      expect(stageLabel("Aptitude Round 2")).toBe("Aptitude Round 2");
    });
  });

  /* `extractStage` returns the literal "unknown" when it cannot read a
     round from an email. That is the extractor's vocabulary, and it was
     reaching the student as a shouted UNKNOWN badge. */
  describe("the unresolved sentinel", () => {
    it.each([["unknown"], ["Unknown"], ["UNKNOWN"], ["  unknown  "]])(
      "%j becomes a neutral label",
      (input) => {
        expect(stageLabel(input)).toBe("Other");
      },
    );

    it("treats a blank stage the same way", () => {
      expect(stageLabel("")).toBe("Other");
      expect(stageLabel("   ")).toBe("Other");
    });

    /* "unknown" is only a sentinel when it is the WHOLE value. */
    it("does not rewrite a stage that merely contains the word", () => {
      expect(stageLabel("Unknown Round")).toBe("Unknown Round");
    });
  });
});
