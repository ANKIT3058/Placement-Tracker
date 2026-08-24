// The classifier's contract is that it NEVER throws: an unclassifiable document
// is a normal outcome, not an error, so every failure degrades to
// UNKNOWN / confidence 0 / empty summary. That contract is what lets the wider
// pipeline treat "we did not understand this" as information rather than as a
// job failure, and it is the property these tests pin.
//
// The AI Core is mocked at `structuredCompletion`, which is the seam the
// classifier actually talks through. `RetryPolicy` is constructed at module load
// (`NO_RETRY`), so the mock must provide a constructible class or importing the
// service throws before any test runs.

const structuredCompletion = jest.fn();

jest.mock("../../ai/index", () => ({
  structuredCompletion: (...args: unknown[]) =>
    (structuredCompletion as unknown as (...a: unknown[]) => unknown)(...args),
  RetryPolicy: class RetryPolicy {
    constructor(_options?: unknown) {}
  },
}));

import { DocumentClassifier } from "../classifier/document-classifier.service";
import { DOCUMENT_TYPE } from "../document-type";

const PARSED = { text: "shortlisted candidates for the amazon online assessment" };

let classifier: DocumentClassifier;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  classifier = new DocumentClassifier();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("known classification", () => {
  // The prompt asks the model for upper-cased DOCUMENT_TYPE keys ("SHORTLIST"),
  // and the service maps them back to the domain values ("shortlist"). Both
  // halves of that mapping are behaviour a consumer depends on.
  test.each([
    ["SHORTLIST", DOCUMENT_TYPE.SHORTLIST],
    ["JOB_DESCRIPTION", DOCUMENT_TYPE.JOB_DESCRIPTION],
    ["INTERVIEW_SCHEDULE", DOCUMENT_TYPE.INTERVIEW_SCHEDULE],
    ["SEATING_ARRANGEMENT", DOCUMENT_TYPE.SEATING_ARRANGEMENT],
    ["RESULT", DOCUMENT_TYPE.RESULT],
    ["GENERAL_INSTRUCTIONS", DOCUMENT_TYPE.GENERAL_INSTRUCTIONS],
  ])("maps the model label %s to its DocumentType", async (label, expected) => {
    structuredCompletion.mockResolvedValue({
      documentType: label,
      confidence: 0.9,
      summary: "A shortlist for the OA.",
    });

    const result = await classifier.classify(PARSED);

    expect(result).toEqual({
      documentType: expected,
      confidence: 0.9,
      summary: "A shortlist for the OA.",
    });
  });

  test("tolerates surrounding whitespace and lower case in the label", async () => {
    structuredCompletion.mockResolvedValue({
      documentType: "  shortlist  ",
      confidence: 0.5,
      summary: "  trimmed  ",
    });

    const result = await classifier.classify(PARSED);

    expect(result.documentType).toBe(DOCUMENT_TYPE.SHORTLIST);
    expect(result.summary).toBe("trimmed");
  });
});

describe("unknown classification", () => {
  test("an unrecognised label becomes UNKNOWN rather than propagating", async () => {
    structuredCompletion.mockResolvedValue({
      documentType: "PAYSLIP",
      confidence: 0.8,
      summary: "Not a placement document.",
    });

    const result = await classifier.classify(PARSED);

    expect(result.documentType).toBe(DOCUMENT_TYPE.UNKNOWN);
    // The confidence and summary the model DID return are still preserved —
    // only the label is unrecognised.
    expect(result.confidence).toBe(0.8);
    expect(result.summary).toBe("Not a placement document.");
  });

  test("a missing or non-string label becomes UNKNOWN", async () => {
    structuredCompletion.mockResolvedValue({ confidence: 0.4, summary: "x" });

    const result = await classifier.classify(PARSED);

    expect(result.documentType).toBe(DOCUMENT_TYPE.UNKNOWN);
  });

  // No text means no document to classify (an image-only PDF, an empty parse).
  // Calling the provider would spend money to be told nothing.
  test.each([
    ["empty string", ""],
    ["whitespace only", "   \n\t "],
  ])("does not call the provider for %s", async (_label, text) => {
    const result = await classifier.classify({ text });

    expect(structuredCompletion).not.toHaveBeenCalled();
    expect(result).toEqual({
      documentType: DOCUMENT_TYPE.UNKNOWN,
      confidence: 0,
      summary: "",
    });
  });
});

describe("confidence clamping", () => {
  test.each([
    ["above the range", 1.7, 1],
    ["below the range", -0.5, 0],
    ["at the upper bound", 1, 1],
    ["at the lower bound", 0, 0],
    ["inside the range", 0.42, 0.42],
  ])("%s: %p becomes %p", async (_label, returned, expected) => {
    structuredCompletion.mockResolvedValue({
      documentType: "SHORTLIST",
      confidence: returned,
      summary: "",
    });

    const result = await classifier.classify(PARSED);

    expect(result.confidence).toBe(expected);
  });

  test.each([
    ["a string", "0.9"],
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("%s becomes 0 rather than propagating", async (_label, returned) => {
    structuredCompletion.mockResolvedValue({
      documentType: "SHORTLIST",
      confidence: returned,
      summary: "",
    });

    const result = await classifier.classify(PARSED);

    expect(result.confidence).toBe(0);
  });
});

describe("provider failure", () => {
  test("returns UNKNOWN_RESULT and does not throw", async () => {
    structuredCompletion.mockRejectedValue(new Error("provider exploded"));

    // The assertion is the absence of a rejection as much as the value.
    await expect(classifier.classify(PARSED)).resolves.toEqual({
      documentType: DOCUMENT_TYPE.UNKNOWN,
      confidence: 0,
      summary: "",
    });
  });

  test("a non-Error rejection is also contained", async () => {
    structuredCompletion.mockRejectedValue("just a string");

    await expect(classifier.classify(PARSED)).resolves.toEqual({
      documentType: DOCUMENT_TYPE.UNKNOWN,
      confidence: 0,
      summary: "",
    });
  });

  test("malformed output (not an object) degrades safely", async () => {
    structuredCompletion.mockResolvedValue(null);

    await expect(classifier.classify(PARSED)).resolves.toEqual({
      documentType: DOCUMENT_TYPE.UNKNOWN,
      confidence: 0,
      summary: "",
    });
  });
});
