// The orchestrator owns the ORDER of the Document Intelligence pipeline and
// nothing else, so these tests are about wiring and boundaries rather than about
// classification or extraction quality — those belong to the component suites
// that already cover them.
//
// Two properties are worth pinning hardest:
//
//   1. The classification result reaches BOTH extractors. Each extractor decides
//      for itself whether it handles that type; if the orchestrator failed to
//      pass it, or passed a different one to each, the gates would misfire in a
//      way no component test could catch.
//   2. Nothing here touches the database. The service returns DocumentInsights
//      and persistence is a separate call, which is what allows this layer to be
//      exercised with no PostgreSQL at all.
//
// Collaborators are injected as fakes through the constructor — the same seam
// DocumentProcessingService exposes for its storage and parser registry — so no
// module mocking is needed for the pipeline itself.

// The repository is mocked purely so the "does not persist" assertion has
// something to assert against. If the service ever grew a write, this spy is
// what would catch it.
const saveDocumentIntelligence = jest.fn();
jest.mock("../document-intelligence.repository", () => ({
  saveDocumentIntelligence: (...args: unknown[]) =>
    (saveDocumentIntelligence as unknown as (...a: unknown[]) => unknown)(
      ...args,
    ),
}));

// Any property access on the Prisma client throws. If the orchestration path
// reached the database at all — directly or through a collaborator it should not
// have — `analyze` would reject instead of resolving.
jest.mock("../../../lib/prisma", () => ({
  get prisma(): never {
    throw new Error("the orchestration layer must not touch the database");
  },
}));

// Note: the real `ai/index` is deliberately NOT mocked here. It briefly had to
// be, because `ai/openai-provider` imported the OpenAI client from
// `extraction.service` and closed a cycle that ts-jest's CommonJS output could
// not resolve — merely importing this service failed to load. The client now
// lives in the leaf module `ai/openai-client`, so the real chain imports
// cleanly and this suite exercises it without that crutch.

import { DocumentIntelligenceService } from "../document-intelligence.service";
import { DOCUMENT_TYPE, type DocumentType } from "../document-type";
import { DocumentInsightsAssembler } from "../document-insights-assembler";
import type { ClassificationResult } from "../classifier/classification-result.types";
import type { EventInformation } from "../event-information.types";
import type { ParticipantInformation } from "../participant-information.types";
import type { DocumentClassifier } from "../classifier/document-classifier.service";
import type { EventExtractor } from "../extractors/event-extractor.service";
import type { ParticipantExtractor } from "../extractors/participant-extractor.service";

const PARSED = { text: "amazon interview schedule, 12 Sept, LT-1" };

const classified = (
  documentType: DocumentType,
  overrides: Partial<ClassificationResult> = {},
): ClassificationResult => ({
  documentType,
  confidence: 0.9,
  summary: "A summary.",
  ...overrides,
});

const NO_EVENT: EventInformation = {};
const NO_PARTICIPANTS: ParticipantInformation = { participants: [] };

const SOME_EVENT: EventInformation = { company: "Amazon", venue: "LT-1" };
const SOME_PARTICIPANTS: ParticipantInformation = {
  participants: [{ attributes: { roll_no: "21BCE1234" } }],
};

let classify: jest.Mock;
let extractEvent: jest.Mock;
let extractParticipants: jest.Mock;
let assemble: jest.SpyInstance;
let service: DocumentIntelligenceService;

// The real assembler is used rather than a fake: it is pure, deterministic and
// already covered, and using it means these tests assert the SHAPE the pipeline
// actually produces instead of a shape a stub was told to return. It is spied on
// so the arguments it receives can still be inspected.
const buildService = () => {
  const assembler = new DocumentInsightsAssembler();
  assemble = jest.spyOn(assembler, "assemble");

  return new DocumentIntelligenceService(
    { classify } as unknown as DocumentClassifier,
    { extract: extractEvent } as unknown as EventExtractor,
    { extract: extractParticipants } as unknown as ParticipantExtractor,
    assembler,
  );
};

beforeEach(() => {
  jest.clearAllMocks();

  classify = jest.fn(async () => classified(DOCUMENT_TYPE.INTERVIEW_SCHEDULE));
  extractEvent = jest.fn(async () => NO_EVENT);
  extractParticipants = jest.fn(async () => NO_PARTICIPANTS);

  service = buildService();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("orchestration", () => {
  test("classifies the document exactly once, from the parsed input", async () => {
    await service.analyze(PARSED);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith(PARSED);
  });

  test("hands the SAME classification to both extractors, with the parsed document", async () => {
    const classification = classified(DOCUMENT_TYPE.SHORTLIST);
    classify.mockResolvedValue(classification);

    await service.analyze(PARSED);

    // The decisive wiring assertion: an orchestrator that forgot to pass the
    // classification, or derived a second one, would break every extractor gate
    // downstream without any component test noticing.
    expect(extractEvent).toHaveBeenCalledWith(PARSED, classification);
    expect(extractParticipants).toHaveBeenCalledWith(PARSED, classification);
  });

  test("invokes both extractors, letting each gate itself", async () => {
    await service.analyze(PARSED);

    // Routing belongs to the extractors, not here. The orchestrator must not
    // pre-select one, or adding a document type would mean editing two places.
    expect(extractEvent).toHaveBeenCalledTimes(1);
    expect(extractParticipants).toHaveBeenCalledTimes(1);
  });

  test("classifies before extracting", async () => {
    const order: string[] = [];

    classify.mockImplementation(async () => {
      order.push("classify");
      return classified(DOCUMENT_TYPE.INTERVIEW_SCHEDULE);
    });
    extractEvent.mockImplementation(async () => {
      order.push("event");
      return NO_EVENT;
    });
    extractParticipants.mockImplementation(async () => {
      order.push("participants");
      return NO_PARTICIPANTS;
    });

    service = buildService();
    await service.analyze(PARSED);

    expect(order).toEqual(["classify", "event", "participants"]);
  });

  test("assembles from exactly the three collaborator results, in order", async () => {
    const classification = classified(DOCUMENT_TYPE.INTERVIEW_SCHEDULE);
    classify.mockResolvedValue(classification);
    extractEvent.mockResolvedValue(SOME_EVENT);
    extractParticipants.mockResolvedValue(SOME_PARTICIPANTS);

    await service.analyze(PARSED);

    expect(assemble).toHaveBeenCalledTimes(1);
    expect(assemble).toHaveBeenCalledWith(
      classification,
      SOME_EVENT,
      SOME_PARTICIPANTS,
    );
  });
});

describe("the returned DocumentInsights", () => {
  test("an event document carries eventInformation and no participant slice", async () => {
    classify.mockResolvedValue(classified(DOCUMENT_TYPE.INTERVIEW_SCHEDULE));
    extractEvent.mockResolvedValue(SOME_EVENT);
    extractParticipants.mockResolvedValue(NO_PARTICIPANTS);

    const insights = await service.analyze(PARSED);

    expect(insights).toEqual({
      classification: DOCUMENT_TYPE.INTERVIEW_SCHEDULE,
      confidence: 0.9,
      summary: "A summary.",
      eventInformation: SOME_EVENT,
    });
    expect(insights).not.toHaveProperty("participantInformation");
  });

  test("a participant document carries participantInformation and no event slice", async () => {
    classify.mockResolvedValue(classified(DOCUMENT_TYPE.SHORTLIST));
    extractEvent.mockResolvedValue(NO_EVENT);
    extractParticipants.mockResolvedValue(SOME_PARTICIPANTS);

    const insights = await service.analyze(PARSED);

    expect(insights).toEqual({
      classification: DOCUMENT_TYPE.SHORTLIST,
      confidence: 0.9,
      summary: "A summary.",
      participantInformation: SOME_PARTICIPANTS,
    });
    expect(insights).not.toHaveProperty("eventInformation");
  });

  test("carries the classification confidence through untouched", async () => {
    classify.mockResolvedValue(
      classified(DOCUMENT_TYPE.RESULT, { confidence: 0.13 }),
    );

    const insights = await service.analyze(PARSED);

    // Low confidence is information a reviewer needs, not a failure to suppress.
    expect(insights.confidence).toBe(0.13);
    expect(insights.classification).toBe(DOCUMENT_TYPE.RESULT);
  });
});

describe("unknown and degraded documents", () => {
  test("an UNKNOWN document still produces valid insights with neither slice", async () => {
    classify.mockResolvedValue(
      classified(DOCUMENT_TYPE.UNKNOWN, { confidence: 0, summary: "" }),
    );

    const insights = await service.analyze(PARSED);

    expect(insights).toEqual({
      classification: DOCUMENT_TYPE.UNKNOWN,
      confidence: 0,
      summary: "",
    });
  });

  test("a failed classification degrades to insights rather than an exception", async () => {
    // This is what the classifier actually returns when the provider fails: it
    // never throws, so the failure reaches the orchestrator as a VALUE and the
    // pipeline continues to a well-formed result.
    classify.mockResolvedValue({
      documentType: DOCUMENT_TYPE.UNKNOWN,
      confidence: 0,
      summary: "",
    });

    await expect(service.analyze(PARSED)).resolves.toEqual({
      classification: DOCUMENT_TYPE.UNKNOWN,
      confidence: 0,
      summary: "",
    });
  });

  test("failed extractions degrade to absent slices, not empty ones", async () => {
    // The extractors' documented failure values.
    extractEvent.mockResolvedValue({});
    extractParticipants.mockResolvedValue({ participants: [] });

    const insights = await service.analyze(PARSED);

    expect(insights).not.toHaveProperty("eventInformation");
    expect(insights).not.toHaveProperty("participantInformation");
  });
});

describe("architectural boundaries", () => {
  test("does not persist", async () => {
    await service.analyze(PARSED);

    // Writing the result belongs to the repository, called separately by
    // whoever owns the transaction — not by the layer that produced it.
    expect(saveDocumentIntelligence).not.toHaveBeenCalled();
  });

  test("completes with no database available", async () => {
    // The prisma mock throws on any access, so resolving at all is the proof.
    await expect(service.analyze(PARSED)).resolves.toBeDefined();
  });

  test("propagates a collaborator that breaks its no-throw contract", async () => {
    // The components are contractually no-throw, so anything that escapes one
    // is a defect rather than an expected outcome. Swallowing it here would hide
    // that defect; the pipeline's fail-soft policy lives at the call site that
    // persists the result.
    classify.mockRejectedValue(new Error("contract violated"));

    await expect(service.analyze(PARSED)).rejects.toThrow("contract violated");
  });

  test("stops the pipeline when classification fails outright", async () => {
    classify.mockRejectedValue(new Error("contract violated"));

    await expect(service.analyze(PARSED)).rejects.toThrow();

    // No extraction should have been attempted against a classification that
    // does not exist.
    expect(extractEvent).not.toHaveBeenCalled();
    expect(extractParticipants).not.toHaveBeenCalled();
  });
});

describe("the default construction", () => {
  test("uses the module singletons when no collaborators are supplied", () => {
    // Guards the production wiring: G-6.3 will construct this with no
    // arguments, and a missing default would only surface at runtime.
    expect(() => new DocumentIntelligenceService()).not.toThrow();
  });
});
