// The participant extractor is the mirror image of the event extractor: it runs
// only for participant-carrying document types, and it preserves whatever the
// document said without imposing a student model.
//
// That second property is the one worth pinning hardest. Participants are an
// open bag of attributes keyed by the document's OWN column labels — there are
// no required fields, and entity resolution is deliberately deferred to a later
// layer. A test that asserted a `rollNumber` field would be encoding exactly the
// premature student model the design rejects, so these tests assert the labels
// survive verbatim instead.

const create = jest.fn();
const getOpenAIClient = jest.fn(() => ({
  chat: { completions: { create } },
}));

jest.mock("../../extraction/extraction.service", () => ({
  getOpenAIClient: (...args: unknown[]) =>
    (getOpenAIClient as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { ParticipantExtractor } from "../extractors/participant-extractor.service";
import { DOCUMENT_TYPE, type DocumentType } from "../document-type";
import type { ClassificationResult } from "../classifier/classification-result.types";

const PARSED = { text: "roll_no,name,status\n21BCE1234,A Kumar,shortlisted" };

const classified = (documentType: DocumentType): ClassificationResult => ({
  documentType,
  confidence: 0.9,
  summary: "",
});

const reply = (content: string) => ({
  choices: [{ message: { content } }],
});

let extractor: ParticipantExtractor;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  extractor = new ParticipantExtractor();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("participant documents invoke the provider", () => {
  test.each([
    DOCUMENT_TYPE.SHORTLIST,
    DOCUMENT_TYPE.SEATING_ARRANGEMENT,
    DOCUMENT_TYPE.RESULT,
  ])("%s reaches the provider", async (documentType) => {
    create.mockResolvedValue(
      reply(
        JSON.stringify({
          participants: [
            { attributes: { roll_no: "21BCE1234", status: "shortlisted" } },
          ],
        }),
      ),
    );

    const result = await extractor.extract(PARSED, classified(documentType));

    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      participants: [
        { attributes: { roll_no: "21BCE1234", status: "shortlisted" } },
      ],
    });
  });

  test("keeps the document's own labels verbatim, imposing no student schema", async () => {
    // Three different documents describing people three different ways. None of
    // these keys is normalised, renamed or required.
    create.mockResolvedValue(
      reply(
        JSON.stringify({
          participants: [
            { attributes: { "Roll No.": "21BCE1234", Seat: "A-14" } },
            { attributes: { name: "B Singh", panel: "2" } },
          ],
        }),
      ),
    );

    const result = await extractor.extract(
      PARSED,
      classified(DOCUMENT_TYPE.SEATING_ARRANGEMENT),
    );

    expect(result.participants).toEqual([
      { attributes: { "Roll No.": "21BCE1234", Seat: "A-14" } },
      { attributes: { name: "B Singh", panel: "2" } },
    ]);
  });

  test("coerces scalar values to strings and drops unusable ones", async () => {
    create.mockResolvedValue(
      reply(
        JSON.stringify({
          participants: [
            {
              attributes: {
                seat: 14,
                present: true,
                notes: null,
                blank: "   ",
                room: "LT-1",
              },
            },
          ],
        }),
      ),
    );

    const result = await extractor.extract(
      PARSED,
      classified(DOCUMENT_TYPE.SHORTLIST),
    );

    expect(result.participants[0].attributes).toEqual({
      seat: "14",
      present: "true",
      room: "LT-1",
    });
  });

  test("accepts a bare attribute object as well as the wrapped form", async () => {
    create.mockResolvedValue(
      reply(JSON.stringify({ participants: [{ roll_no: "21BCE9999" }] })),
    );

    const result = await extractor.extract(
      PARSED,
      classified(DOCUMENT_TYPE.SHORTLIST),
    );

    expect(result.participants).toEqual([
      { attributes: { roll_no: "21BCE9999" } },
    ]);
  });

  test("drops an entry with no usable attributes rather than emitting a hollow participant", async () => {
    create.mockResolvedValue(
      reply(
        JSON.stringify({
          participants: [{ attributes: {} }, { attributes: { seat: "A-1" } }],
        }),
      ),
    );

    const result = await extractor.extract(
      PARSED,
      classified(DOCUMENT_TYPE.SHORTLIST),
    );

    expect(result.participants).toEqual([{ attributes: { seat: "A-1" } }]);
  });
});

describe("event documents do not invoke the provider", () => {
  test.each([
    DOCUMENT_TYPE.JOB_DESCRIPTION,
    DOCUMENT_TYPE.INTERVIEW_SCHEDULE,
    DOCUMENT_TYPE.GENERAL_INSTRUCTIONS,
  ])("%s short-circuits with no provider call", async (documentType) => {
    const result = await extractor.extract(PARSED, classified(documentType));

    expect(result).toEqual({ participants: [] });
    expect(create).not.toHaveBeenCalled();
    expect(getOpenAIClient).not.toHaveBeenCalled();
  });

  test("UNKNOWN also short-circuits", async () => {
    const result = await extractor.extract(
      PARSED,
      classified(DOCUMENT_TYPE.UNKNOWN),
    );

    expect(result).toEqual({ participants: [] });
    expect(create).not.toHaveBeenCalled();
  });

  test("a participant type with no text short-circuits", async () => {
    const result = await extractor.extract(
      { text: "  " },
      classified(DOCUMENT_TYPE.SHORTLIST),
    );

    expect(result).toEqual({ participants: [] });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("malformed responses produce an empty participant list", () => {
  test.each([
    ["participants is not an array", JSON.stringify({ participants: {} })],
    ["participants is absent", JSON.stringify({ total: 3 })],
    ["not JSON at all", "sorry, I cannot help with that"],
    ["an empty response", ""],
  ])("%s", async (_label, content) => {
    create.mockResolvedValue(reply(content));

    await expect(
      extractor.extract(PARSED, classified(DOCUMENT_TYPE.SHORTLIST)),
    ).resolves.toEqual({ participants: [] });
  });
});

describe("provider failure does not throw", () => {
  test("a rejected request degrades to an empty list", async () => {
    create.mockRejectedValue(new Error("rate limited"));

    await expect(
      extractor.extract(PARSED, classified(DOCUMENT_TYPE.SHORTLIST)),
    ).resolves.toEqual({ participants: [] });
  });

  test("a missing API key degrades to an empty list", async () => {
    getOpenAIClient.mockImplementation(() => {
      throw new Error("OPENAI_API_KEY not set");
    });

    await expect(
      extractor.extract(PARSED, classified(DOCUMENT_TYPE.SHORTLIST)),
    ).resolves.toEqual({ participants: [] });
  });
});
