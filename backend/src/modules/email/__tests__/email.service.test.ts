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
  saveExtraction: jest.fn(),
}));

// FIX: mock matching service.
// email.service calls matchEventV2 BEFORE the isLowConfidence branch, so without
// this mock the real matching.service runs → findByEventKey → prisma.event.findUnique
// → TypeError because that method is absent from the partial prisma mock above.
jest.mock("../../matching/matching.service", () => ({
  matchEventV2: jest.fn().mockResolvedValue(null),
}));

// auto-mock the two services email.service delegates to
jest.mock("../../extraction/extraction.service");
jest.mock("../../event/event.service");

import { processEmail } from "../email.service";
import * as extraction from "../../extraction/extraction.service";
import * as eventService from "../../event/event.service";
import * as matching from "../../matching/matching.service";

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

    const result = await processEmail({
      body: "Amazon OA next week evening",
    } as any);

    expect(eventService.createEventService).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "review",
      }),
    );

    expect(result.status).toBe("review");
  });
});
