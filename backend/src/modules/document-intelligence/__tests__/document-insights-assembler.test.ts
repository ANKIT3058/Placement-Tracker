// The assembler is the one deterministic component in this layer: a pure merge,
// no AI, no I/O, nothing to mock.
//
// Its single decision is whether each optional slice is meaningful enough to
// attach. That decision matters downstream because ABSENT and EMPTY are not the
// same statement: an absent `eventInformation` means "no event information was
// understood", and it is what the persistence layer writes as SQL NULL. A hollow
// `{}` attached instead would claim the document was understood to contain
// nothing, which is a different and false claim.

import { DocumentInsightsAssembler } from "../document-insights-assembler";
import { DOCUMENT_TYPE } from "../document-type";
import type { ClassificationResult } from "../classifier/classification-result.types";
import type { EventInformation } from "../event-information.types";
import type { ParticipantInformation } from "../participant-information.types";

const CLASSIFICATION: ClassificationResult = {
  documentType: DOCUMENT_TYPE.SHORTLIST,
  confidence: 0.87,
  summary: "Shortlist for the Amazon OA.",
};

const NO_EVENT: EventInformation = {};
const NO_PARTICIPANTS: ParticipantInformation = { participants: [] };

let assembler: DocumentInsightsAssembler;

beforeEach(() => {
  assembler = new DocumentInsightsAssembler();
});

describe("classification always passes through", () => {
  test("carries type, confidence and summary verbatim", () => {
    const insights = assembler.assemble(
      CLASSIFICATION,
      NO_EVENT,
      NO_PARTICIPANTS,
    );

    expect(insights.classification).toBe(DOCUMENT_TYPE.SHORTLIST);
    expect(insights.confidence).toBe(0.87);
    expect(insights.summary).toBe("Shortlist for the Amazon OA.");
  });

  test("a low-confidence classification is preserved, not discarded", () => {
    // Low confidence is information, not a failure. Dropping it here would
    // remove the signal a reviewer needs.
    const insights = assembler.assemble(
      { ...CLASSIFICATION, confidence: 0.05 },
      NO_EVENT,
      NO_PARTICIPANTS,
    );

    expect(insights.confidence).toBe(0.05);
    expect(insights.classification).toBe(DOCUMENT_TYPE.SHORTLIST);
  });
});

describe("eventInformation is included when present", () => {
  test("attached when at least one field was understood", () => {
    const insights = assembler.assemble(
      CLASSIFICATION,
      { venue: "LT-1" },
      NO_PARTICIPANTS,
    );

    expect(insights.eventInformation).toEqual({ venue: "LT-1" });
  });

  test("a single field is enough", () => {
    const insights = assembler.assemble(
      CLASSIFICATION,
      { company: "Amazon" },
      NO_PARTICIPANTS,
    );

    expect(insights).toHaveProperty("eventInformation");
  });

  test("omitted entirely when no field was understood", () => {
    const insights = assembler.assemble(
      CLASSIFICATION,
      NO_EVENT,
      NO_PARTICIPANTS,
    );

    // Absent, not `{}` — the key must not exist at all.
    expect(insights).not.toHaveProperty("eventInformation");
    expect(insights.eventInformation).toBeUndefined();
  });

  test("an object whose every field is undefined counts as nothing understood", () => {
    const insights = assembler.assemble(
      CLASSIFICATION,
      { company: undefined, venue: undefined },
      NO_PARTICIPANTS,
    );

    expect(insights).not.toHaveProperty("eventInformation");
  });
});

describe("participantInformation is included when participants exist", () => {
  test("attached when the list is non-empty", () => {
    const participants: ParticipantInformation = {
      participants: [{ attributes: { roll_no: "21BCE1234" } }],
    };

    const insights = assembler.assemble(CLASSIFICATION, NO_EVENT, participants);

    expect(insights.participantInformation).toEqual(participants);
  });

  test("omitted entirely when the list is empty", () => {
    const insights = assembler.assemble(
      CLASSIFICATION,
      NO_EVENT,
      NO_PARTICIPANTS,
    );

    // An empty list is "no participants understood", which must not be
    // persisted as an empty array claiming the document listed nobody.
    expect(insights).not.toHaveProperty("participantInformation");
    expect(insights.participantInformation).toBeUndefined();
  });
});

describe("both slices together", () => {
  test("an empty extraction produces neither optional slice", () => {
    const insights = assembler.assemble(
      CLASSIFICATION,
      NO_EVENT,
      NO_PARTICIPANTS,
    );

    expect(Object.keys(insights).sort()).toEqual([
      "classification",
      "confidence",
      "summary",
    ]);
  });

  test("both are attached when both carry content", () => {
    // Not reachable through the current extractor gates, which are disjoint —
    // but the assembler is a pure merge and must not encode that routing rule.
    const insights = assembler.assemble(
      CLASSIFICATION,
      { venue: "LT-1" },
      { participants: [{ attributes: { seat: "A-14" } }] },
    );

    expect(insights.eventInformation).toEqual({ venue: "LT-1" });
    expect(insights.participantInformation).toEqual({
      participants: [{ attributes: { seat: "A-14" } }],
    });
  });
});
