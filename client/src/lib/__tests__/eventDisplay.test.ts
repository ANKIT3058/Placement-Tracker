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
import { titleCase } from "../eventDisplay";

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
