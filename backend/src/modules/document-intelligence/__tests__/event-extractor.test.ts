// The event extractor's two guarantees:
//
//   1. It runs ONLY for event-carrying document types. A participant document
//      must not reach the provider at all — the gate is a cost and latency
//      boundary, not just a correctness one, so "returned {}" is not sufficient
//      evidence on its own. These tests assert the provider was never called.
//   2. It never throws. Any failure degrades to an empty EventInformation,
//      where every field absent means "this document said nothing about it"
//      (leave-unchanged), never "clear this value".
//
// It talks to OpenAI through `getOpenAIClient` rather than the AI Core, so that
// is the seam mocked here. (The Core/direct-client split is pre-existing and
// deliberately not refactored as part of this phase.)

const create = jest.fn();
const getOpenAIClient = jest.fn(() => ({
  chat: { completions: { create } },
}));

jest.mock("../../extraction/extraction.service", () => ({
  getOpenAIClient: (...args: unknown[]) =>
    (getOpenAIClient as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { EventExtractor } from "../extractors/event-extractor.service";
import { DOCUMENT_TYPE, type DocumentType } from "../document-type";
import type { ClassificationResult } from "../classifier/classification-result.types";

const PARSED = { text: "amazon interview schedule, 12 Sept, LT-1, 10 AM" };

const classified = (documentType: DocumentType): ClassificationResult => ({
  documentType,
  confidence: 0.9,
  summary: "",
});

// Shape the OpenAI SDK returns; the service reads choices[0].message.content.
const reply = (content: string) => ({
  choices: [{ message: { content } }],
});

let extractor: EventExtractor;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  extractor = new EventExtractor();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("event documents invoke the provider and extract fields", () => {
  test.each([
    DOCUMENT_TYPE.JOB_DESCRIPTION,
    DOCUMENT_TYPE.INTERVIEW_SCHEDULE,
    DOCUMENT_TYPE.GENERAL_INSTRUCTIONS,
  ])("%s reaches the provider", async (documentType) => {
    create.mockResolvedValue(
      reply(
        JSON.stringify({
          company: "Amazon",
          stage: "interview",
          date: "2026-09-12",
          time: "10 AM",
          venue: "LT-1",
        }),
      ),
    );

    const result = await extractor.extract(PARSED, classified(documentType));

    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      company: "Amazon",
      stage: "interview",
      date: new Date("2026-09-12"),
      time: "10 AM",
      venue: "LT-1",
    });
  });

  test("keeps only the fields the document actually revealed", async () => {
    // A venue notice: venue and nothing else. Absent fields must stay absent
    // rather than becoming null/empty, because undefined is what downstream
    // update logic reads as "leave unchanged".
    create.mockResolvedValue(
      reply(JSON.stringify({ venue: "Seminar Hall", company: "   " })),
    );

    const result = await extractor.extract(
      PARSED,
      classified(DOCUMENT_TYPE.GENERAL_INSTRUCTIONS),
    );

    expect(result).toEqual({ venue: "Seminar Hall" });
    expect(result).not.toHaveProperty("company");
    expect(result).not.toHaveProperty("date");
  });

  test("strips markdown code fences before parsing", async () => {
    create.mockResolvedValue(
      reply('```json\n{"company":"Google"}\n```'),
    );

    const result = await extractor.extract(
      PARSED,
      classified(DOCUMENT_TYPE.JOB_DESCRIPTION),
    );

    expect(result).toEqual({ company: "Google" });
  });

  test("drops an unparseable date rather than inventing one", async () => {
    create.mockResolvedValue(
      reply(JSON.stringify({ company: "Amazon", date: "sometime next week" })),
    );

    const result = await extractor.extract(
      PARSED,
      classified(DOCUMENT_TYPE.INTERVIEW_SCHEDULE),
    );

    expect(result).toEqual({ company: "Amazon" });
  });
});

describe("participant documents do not invoke the provider", () => {
  test.each([
    DOCUMENT_TYPE.SHORTLIST,
    DOCUMENT_TYPE.SEATING_ARRANGEMENT,
    DOCUMENT_TYPE.RESULT,
  ])("%s short-circuits to {} with no provider call", async (documentType) => {
    const result = await extractor.extract(PARSED, classified(documentType));

    expect(result).toEqual({});
    expect(create).not.toHaveBeenCalled();
    expect(getOpenAIClient).not.toHaveBeenCalled();
  });

  test("UNKNOWN also short-circuits", async () => {
    const result = await extractor.extract(
      PARSED,
      classified(DOCUMENT_TYPE.UNKNOWN),
    );

    expect(result).toEqual({});
    expect(create).not.toHaveBeenCalled();
  });

  test("an event type with no text short-circuits", async () => {
    const result = await extractor.extract(
      { text: "   " },
      classified(DOCUMENT_TYPE.JOB_DESCRIPTION),
    );

    expect(result).toEqual({});
    expect(create).not.toHaveBeenCalled();
  });
});

describe("failure degrades safely", () => {
  test("malformed JSON returns {} and does not throw", async () => {
    create.mockResolvedValue(reply("not json at all"));

    await expect(
      extractor.extract(PARSED, classified(DOCUMENT_TYPE.JOB_DESCRIPTION)),
    ).resolves.toEqual({});
  });

  test("an empty provider response returns {}", async () => {
    create.mockResolvedValue(reply(""));

    await expect(
      extractor.extract(PARSED, classified(DOCUMENT_TYPE.JOB_DESCRIPTION)),
    ).resolves.toEqual({});
  });

  test("a provider error returns {} and does not throw", async () => {
    create.mockRejectedValue(new Error("rate limited"));

    await expect(
      extractor.extract(PARSED, classified(DOCUMENT_TYPE.JOB_DESCRIPTION)),
    ).resolves.toEqual({});
  });

  test("a missing API key returns {} and does not throw", async () => {
    // getOpenAIClient throws synchronously when OPENAI_API_KEY is unset. That
    // is reachable in production — the drain workflow deliberately ships no
    // key — so it must degrade like any other failure.
    getOpenAIClient.mockImplementation(() => {
      throw new Error("OPENAI_API_KEY not set");
    });

    await expect(
      extractor.extract(PARSED, classified(DOCUMENT_TYPE.JOB_DESCRIPTION)),
    ).resolves.toEqual({});
  });
});
