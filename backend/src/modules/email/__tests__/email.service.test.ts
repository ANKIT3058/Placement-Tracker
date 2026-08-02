// mock prisma FIRST (inline factory – only needs what email.service directly uses)
jest.mock("../../../lib/prisma", () => ({
  prisma: {
    event: {
      create: jest.fn(),
    },
  },
}));

// mock extraction repository (prevents prisma import chain)
jest.mock("../../extraction/extraction.repository", () => ({
  createExtraction: jest.fn(),
}));

// FIX: mock matching service.
// email.service calls matchEventV2 BEFORE the isLowConfidence branch, so without
// this mock the real matching.service runs → findByEventKey → prisma.event.findUnique
// → TypeError because that method is absent from the partial prisma mock above.
jest.mock("../../matching/matching.service", () => ({
  matchEventV2: jest.fn().mockResolvedValue(null),
}));

// mock the email repository: the abandon path calls updateEmailStatus, which
// would otherwise reach the real repository and the partial prisma mock above.
jest.mock("../email.repository", () => ({
  updateEmailStatus: jest.fn(),
}));

// auto-mock the two services email.service delegates to
jest.mock("../../extraction/extraction.service");
jest.mock("../../event/event.service");

import { processEmail as processEmailScoped } from "../email.service";
import * as extraction from "../../extraction/extraction.service";
import * as eventService from "../../event/event.service";
import * as matching from "../../matching/matching.service";
import * as emailRepo from "../email.repository";
import { EMAIL_STATUS } from "../../../shared/constants/email.constants";

// AC-5.9. Ownership is mandatory, so these suites run as a concrete tenant
// rather than the null tenant they used during the migration window. The value
// is arbitrary — what these assertions check is that the owner is threaded
// through unchanged, not which owner it is.
const TENANT = { userId: 1 };

// Wrapped rather than threaded through each call site so the existing
// assertions stay byte-identical.
const processEmail = (email: any, emailId: number) =>
  processEmailScoped(TENANT, email, emailId);

describe("Email Service - Low Confidence Handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should create event with review status when confidence is low", async () => {
    // mock extraction
    (extraction.extract as jest.Mock).mockResolvedValue({
      data: {
        company: "amazon",
        stage: "OA",
        date: "2026-08-20",
      },
      confidence: 0.4,
    });

    // mock createEventService
    (eventService.createEventService as jest.Mock).mockResolvedValue({
      status: "review",
    });

    // processEmail signature is (email, emailId); emailId is forwarded to
    // createExtraction/updateEmailStatus, so a value must be supplied.
    const result = await processEmail(
      {
        body: "Amazon OA next week evening",
      } as any,
      1,
    );

    expect(eventService.createEventService).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        status: "review",
      }),
    );

    expect(result.status).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// AC-4 / D-10: the "unknown" company placeholder must never reach the engine.
//
// Extraction substitutes the literal "unknown" when no company resolves. That
// string is truthy, so it satisfied the old viability gate: the observation was
// scored, matched, and persisted as a real Event named "unknown" — which then
// became a matching candidate for every later unresolved observation, so
// unrelated activities accumulated onto one record.
//
// The gate now treats the placeholder as a missing company, which is the
// ABANDON outcome the Decision Model already defines for this case. Because the
// gate runs before recognition and before any write, abandoning there keeps the
// placeholder out of the identity key, out of the candidate queries, and out of
// the database at once.
// ---------------------------------------------------------------------------

const extracted = (company: unknown, confidence = 0.9) => ({
  data: { company, stage: "OA", date: "2026-08-20" },
  confidence,
  status: "complete",
  isTimeEstimated: false,
});

describe("Viability Gate - unresolved company (AC-4 / D-10)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (matching.matchEventV2 as jest.Mock).mockResolvedValue(null);
  });

  it("abandons an observation whose company is the placeholder", async () => {
    (extraction.extract as jest.Mock).mockResolvedValue(extracted("unknown"));

    const result = await processEmail({ body: "OA on 20th Aug" } as any, 1);

    // Never persisted, in either direction.
    expect(eventService.createEventService).not.toHaveBeenCalled();
    expect(eventService.updateEventService).not.toHaveBeenCalled();
    // Never reached recognition, so it can be neither a candidate nor part of
    // an identity key nor an input to similarity scoring.
    expect(matching.matchEventV2).not.toHaveBeenCalled();
    // Recorded as the ABANDON outcome the handbook specifies.
    expect(emailRepo.updateEmailStatus).toHaveBeenCalledWith(
      TENANT,
      1,
      EMAIL_STATUS.IGNORED,
    );
    expect(result).toBeUndefined();
  });

  it.each([
    ["exact placeholder", "unknown"],
    ["uppercased", "UNKNOWN"],
    ["padded", "  unknown  "],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["null", null],
    ["undefined", undefined],
  ])("abandons when the company is %s", async (_label, company) => {
    (extraction.extract as jest.Mock).mockResolvedValue(extracted(company));

    await processEmail({ body: "OA on 20th Aug" } as any, 1);

    expect(eventService.createEventService).not.toHaveBeenCalled();
    expect(matching.matchEventV2).not.toHaveBeenCalled();
    expect(emailRepo.updateEmailStatus).toHaveBeenCalledWith(
      TENANT,
      1,
      EMAIL_STATUS.IGNORED,
    );
  });

  it("abandons the placeholder even at maximum confidence", async () => {
    // Pre-AC-4 this was the dangerous case: a confident observation with no
    // company cleared the trust threshold and created the magnet Event.
    (extraction.extract as jest.Mock).mockResolvedValue(
      extracted("unknown", 1.0),
    );

    await processEmail({ body: "OA on 20th Aug" } as any, 1);

    expect(eventService.createEventService).not.toHaveBeenCalled();
    expect(matching.matchEventV2).not.toHaveBeenCalled();
  });

  // --- Valid companies are untouched ---------------------------------------

  it("still processes a resolved company", async () => {
    (extraction.extract as jest.Mock).mockResolvedValue(extracted("amazon"));
    (eventService.createEventService as jest.Mock).mockResolvedValue({
      id: 1,
      company: "amazon",
    });

    const result = await processEmail(
      { body: "Amazon OA on 20th Aug" } as any,
      1,
    );

    expect(matching.matchEventV2).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ company: "amazon" }),
    );
    expect(eventService.createEventService).toHaveBeenCalled();
    expect(result.company).toBe("amazon");
  });

  it("still processes a company that merely contains the word 'unknown'", async () => {
    (extraction.extract as jest.Mock).mockResolvedValue(
      extracted("unknown systems"),
    );
    (eventService.createEventService as jest.Mock).mockResolvedValue({
      id: 2,
      company: "unknown systems",
    });

    await processEmail({ body: "Unknown Systems OA on 20th Aug" } as any, 1);

    expect(eventService.createEventService).toHaveBeenCalled();
  });

  // --- The review path is unaffected ---------------------------------------

  it("still routes a low-confidence observation with a real company to review", async () => {
    (extraction.extract as jest.Mock).mockResolvedValue(
      extracted("amazon", 0.4),
    );
    (eventService.createEventService as jest.Mock).mockResolvedValue({
      status: "review",
    });

    const result = await processEmail(
      { body: "Amazon OA next week evening" } as any,
      1,
    );

    expect(eventService.createEventService).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ status: "review" }),
    );
    expect(result.status).toBe("review");
  });

  it("abandons rather than reviewing when the company is unresolved", async () => {
    // Both conditions at once: no company AND low confidence. The gate runs
    // first, so this is ABANDON — not a review Event named "unknown".
    (extraction.extract as jest.Mock).mockResolvedValue(
      extracted("unknown", 0.3),
    );

    await processEmail({ body: "OA next week" } as any, 1);

    expect(eventService.createEventService).not.toHaveBeenCalled();
    expect(emailRepo.updateEmailStatus).toHaveBeenCalledWith(
      TENANT,
      1,
      EMAIL_STATUS.IGNORED,
    );
  });
});
