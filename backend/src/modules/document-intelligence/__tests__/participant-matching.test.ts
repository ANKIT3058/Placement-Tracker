// G-8.4 — deciding whether a registration number appears among participants.
//
// This is the entity-resolution layer `participant-information.types` deferred,
// and every rule in it is a decision that was made deliberately rather than
// discovered. The assertions below are mostly about REFUSAL — which keys are
// never read, which values are never treated as equal, and which rows are
// skipped even though one of their fields matches.
//
// The failure being guarded against is asymmetric. A missed match tells a
// student nothing, which is recoverable. A false match tells them they are
// shortlisted when they are not, which is not — they may stop looking, or turn
// up somewhere they were never expected. So where the rules are conservative,
// the tests assert that conservatism directly.

import {
  participantMatches,
  participantsInclude,
} from "../participant-matching";
import type { Participant } from "../participant-information.types";

const participant = (attributes: Record<string, string>): Participant => ({
  attributes,
});

const NUMBER = "20231234";

describe("registration-like keys are recognised by an allowlist", () => {
  // One family of spellings per case: the extractor is instructed to copy the
  // document's own column headers verbatim, so the same field arrives punctuated
  // and cased however a human typed it into a spreadsheet.
  test.each([
    "roll_no",
    "Roll No",
    "ROLL-NO.",
    "Roll  Number",
    "rollNumber",
    "reg_no",
    "Reg. No",
    "Registration Number",
    "REGISTRATIONNO",
    "enrollment_no",
    "Enrolment Number",
    "University Roll No",
    "Student ID",
  ])("%s is read as a registration number", (key) => {
    expect(participantMatches(participant({ [key]: NUMBER }), NUMBER)).toBe(
      true,
    );
  });

  // THE ALLOWLIST IS THE POINT. A shortlist pairs a roll number with other
  // columns, and a value that happens to equal the user's number in one of them
  // is a coincidence, not evidence of participation.
  test.each([
    ["seat", { seat: NUMBER }],
    ["rank", { rank: NUMBER }],
    ["phone", { phone: NUMBER }],
    ["name", { name: NUMBER }],
    ["status", { status: NUMBER }],
    ["marks", { marks: NUMBER }],
    ["an unlabelled column", { column_3: NUMBER }],
  ])("%s is never scanned", (_label, attributes) => {
    expect(participantMatches(participant(attributes), NUMBER)).toBe(false);
  });
});

describe("values are compared by trim and case only", () => {
  // Stated as explicit (document value, stored value) pairs rather than derived,
  // so each row says exactly which two strings are being claimed equal.
  test.each([
    ["identical", "20231234", "20231234"],
    ["document upper, stored lower", "2023ABCD", "2023abcd"],
    ["document lower, stored upper", "2023abcd", "2023ABCD"],
    ["whitespace around the stored value", "20231234", "  20231234  "],
    ["whitespace around the document value", "  20231234  ", "20231234"],
    ["whitespace around both", "  20231234 ", " 20231234  "],
  ])("%s matches", (_label, documentValue, stored) => {
    expect(
      participantMatches(participant({ roll_no: documentValue }), stored),
    ).toBe(true);
  });

  test("case differences on both sides still match", () => {
    expect(
      participantMatches(participant({ roll_no: "btech/2023/42" }), "BTECH/2023/42"),
    ).toBe(true);
  });

  // PUNCTUATION IS NOT STRIPPED, and this is the deliberate limit. Removing
  // separators would also make "2023-1" equal "20231", which is a different
  // student — so a possible match is declined rather than guessed.
  test.each([
    ["different separators", "BTECH-2023-42", "BTECH/2023/42"],
    ["separator vs none", "2023-1234", "20231234"],
    ["internal spacing", "2023 1234", "20231234"],
  ])("%s does not match", (_label, documentValue, stored) => {
    expect(
      participantMatches(participant({ roll_no: documentValue }), stored),
    ).toBe(false);
  });

  test("a different number does not match", () => {
    expect(
      participantMatches(participant({ roll_no: "20239999" }), NUMBER),
    ).toBe(false);
  });
});

describe("conflicting registration-like values mean unmatched", () => {
  // THE RULE THAT MATTERS MOST. One of these fields agrees with the user, and
  // the row is still skipped: a row whose own registration columns disagree is
  // one this layer cannot read confidently, and matching on whichever half
  // happened to agree would be a guess.
  test("a row is skipped even when one value matches", () => {
    const row = participant({ roll_no: NUMBER, reg_no: "20239999" });

    expect(participantMatches(row, NUMBER)).toBe(false);
  });

  test("the order of the conflicting fields does not matter", () => {
    const row = participant({ reg_no: "20239999", roll_no: NUMBER });

    expect(participantMatches(row, NUMBER)).toBe(false);
  });

  test("agreeing duplicates are not a conflict", () => {
    // One student's number repeated under two headers is one number.
    const row = participant({ roll_no: NUMBER, registration_number: NUMBER });

    expect(participantMatches(row, NUMBER)).toBe(true);
  });

  test("duplicates differing only by case are not a conflict", () => {
    const row = participant({ roll_no: "2023abcd", reg_no: "2023ABCD" });

    expect(participantMatches(row, "2023ABCD")).toBe(true);
  });

  test("a conflict blocks the match even against the second value", () => {
    const row = participant({ roll_no: NUMBER, reg_no: "20239999" });

    expect(participantMatches(row, "20239999")).toBe(false);
  });
});

describe("empty and malformed input matches nothing", () => {
  test.each([
    ["no attributes", {}],
    ["an empty value", { roll_no: "" }],
    ["a whitespace-only value", { roll_no: "   " }],
  ])("%s does not match", (_label, attributes) => {
    expect(participantMatches(participant(attributes), NUMBER)).toBe(false);
  });

  test("a non-string value is ignored", () => {
    const row = { attributes: { roll_no: 20231234 } } as unknown as Participant;

    expect(participantMatches(row, NUMBER)).toBe(false);
  });

  test.each([
    ["an empty registration number", ""],
    ["a whitespace-only registration number", "   "],
  ])("%s matches nothing", (_label, stored) => {
    // Otherwise a blank number would compare equal to a blank cell and report
    // participation in every list.
    expect(participantsInclude([participant({ roll_no: "" })], stored)).toBe(
      false,
    );
    expect(participantsInclude([participant({ roll_no: NUMBER })], stored)).toBe(
      false,
    );
  });
});

describe("scanning a document's participants", () => {
  const OTHERS = [
    participant({ roll_no: "20230001", name: "A Student" }),
    participant({ roll_no: "20230002", name: "B Student" }),
  ];

  test("finds the caller among other participants", () => {
    const list = [...OTHERS, participant({ roll_no: NUMBER, name: "C" })];

    expect(participantsInclude(list, NUMBER)).toBe(true);
  });

  test("reports absence when the caller is not listed", () => {
    expect(participantsInclude(OTHERS, NUMBER)).toBe(false);
  });

  test("an empty list matches nothing", () => {
    expect(participantsInclude([], NUMBER)).toBe(false);
  });

  test("one unreadable row does not prevent a match on another", () => {
    // A conflicting row is skipped, not fatal: the rest of the document is still
    // read.
    const list = [
      participant({ roll_no: "20230001", reg_no: "20230002" }),
      participant({ roll_no: NUMBER }),
    ];

    expect(participantsInclude(list, NUMBER)).toBe(true);
  });

  test("returns a boolean and nothing about other participants", () => {
    const list = [...OTHERS, participant({ roll_no: NUMBER })];

    // The question is "am I on this list", not "who else is". The return type
    // is what makes exposing another student's row impossible rather than
    // merely avoided.
    expect(typeof participantsInclude(list, NUMBER)).toBe("boolean");
  });
});
