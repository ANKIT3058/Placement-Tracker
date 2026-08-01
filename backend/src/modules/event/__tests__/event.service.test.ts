jest.mock("../../../lib/prisma");
jest.mock("../event.repository", () => ({
  updateEvent: jest.fn(),
}));

import { detectChanges } from "../event.service";
import {
  updateEventService,
  updateEventManuallyService,
} from "../event.service";
import * as repo from "../event.repository";
import { prisma } from "../../../lib/prisma";

describe("Event Service - Venue Logic", () => {
  test("explicit null should clear venue", () => {
    const existing = {
      venue: "auditorium",
      date: new Date("2026-08-20"),
    };

    const incoming = {
      venue: null,
      venueMeta: { value: null, isExplicit: true },
      date: "2026-08-20",
    };

    const { changes } = detectChanges(existing, incoming);

    expect(changes).toEqual([
      {
        field: "venue",
        oldValue: "auditorium",
        newValue: "null",
      },
    ]);
  });

  test("no mention should NOT change venue", () => {
    const existing = {
      venue: "auditorium",
      date: new Date("2026-08-20"),
    };

    const incoming = {
      venue: null,
      venueMeta: { value: null, isExplicit: false },
      date: "2026-08-20",
    };

    const { changes } = detectChanges(existing, incoming);

    expect(changes.length).toBe(0);
  });
});

describe("Confidence Logic", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  it("should skip update when new confidence is lower", async () => {
    const existing = {
      id: 1,
      company: "amazon",
      stage: "OA",
      date: new Date("2026-08-20"),
      time: "10:00",
      venue: "zoom",
      confidence: 0.9,
    };

    const incoming = {
      company: "amazon",
      stage: "OA",
      date: "2026-08-20",
      time: "15:00",
      venue: "zoom",
      confidence: 0.5,
    };

    const result = await updateEventService(
      existing.id,
      existing,
      incoming as any,
    );

    expect(result.time).toBe("10:00"); // unchanged
  });

  it("should update when new confidence is higher", async () => {
    const existing = {
      id: 1,
      company: "amazon",
      stage: "OA",
      date: new Date("2026-08-20"),
      time: "10:00",
      venue: "zoom",
      confidence: 0.4,
    };

    const incoming = {
      company: "amazon",
      stage: "OA",
      date: "2026-08-20",
      time: "15:00",
      venue: "zoom",
      confidence: 0.9,
    };

    // mock DB response: the event write now happens through the transaction
    // client (tx.event.update), so stub prisma.event.update instead of the repo.
    (prisma.event.update as jest.Mock).mockResolvedValue({
      ...existing,
      ...incoming,
    });

    const result = await updateEventService(
      existing.id,
      existing,
      incoming as any,
    );

    // ASSERT 1: the event was updated inside the transaction
    expect(prisma.event.update).toHaveBeenCalled();

    // ASSERT 2: correct data passed
    expect(prisma.event.update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: expect.objectContaining({
        time: "15:00",
        confidence: 0.9,
      }),
    });

    // ASSERT 3: result updated
    expect(result.time).toBe("15:00");
    expect(result.confidence).toBe(0.9);
  });

  it("should NOT call repo when no changes", async () => {
    const existing = {
      id: 1,
      company: "amazon",
      stage: "OA",
      date: new Date("2026-08-20"),
      time: "10:00",
      venue: "zoom",
      confidence: 0.9,
    };

    const incoming = {
      company: "amazon",
      stage: "OA",
      date: "2026-08-20",
      time: "10:00",
      venue: "zoom",
      confidence: 0.95,
    };

    const result = await updateEventService(
      existing.id,
      existing,
      incoming as any,
    );

    expect(repo.updateEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-3 / D-9: manual confirmation is the highest authority in the system.
//
// `updateEventManuallyService` sets confidence to exactly 1.0. A maximally
// confident extraction also reaches 1.0, and the incumbent guard is a strict
// `<`, so `1.0 < 1.0` was false and the automated update proceeded — rewriting
// fields, and flipping `confirmed` to `rescheduled` when the date differed.
//
// Authority is now carried by status, not by the confidence scalar: a confirmed
// Event is immutable with respect to automated inference. The confidence
// comparator is deliberately unchanged.
// ---------------------------------------------------------------------------

const confirmedEvent = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  company: "amazon",
  stage: "OA",
  date: new Date("2026-08-20"),
  time: "10:00",
  venue: "zoom",
  confidence: 1.0,
  status: "confirmed",
  eventKey: "amazon|OA|2026-08-20",
  ...overrides,
});

describe("Manual Authority (AC-3 / D-9)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- The exact defect ----------------------------------------------------

  it("does not overwrite a confirmed Event with an equally confident observation", async () => {
    const existing = confirmedEvent();

    // The reachable worst case: a maximally confident extraction. Pre-AC-3 this
    // passed the `newConfidence < existingConfidence` guard because 1.0 < 1.0
    // is false, and the update was applied.
    const incoming = {
      company: "amazon",
      stage: "OA",
      date: "2026-08-20",
      time: "15:00",
      venue: "hackerrank",
      confidence: 1.0,
    };

    const result = await updateEventService(
      existing.id,
      existing,
      incoming as any,
    );

    expect(prisma.event.update).not.toHaveBeenCalled();
    expect(prisma.eventUpdate.create).not.toHaveBeenCalled();
    expect(result).toBe(existing);
    expect(result.time).toBe("10:00");
    expect(result.venue).toBe("zoom");
  });

  it("does not reschedule a confirmed Event when the incoming date differs", async () => {
    const existing = confirmedEvent();

    const incoming = {
      company: "amazon",
      stage: "OA",
      date: "2026-08-27", // a week later
      time: "10:00",
      venue: "zoom",
      confidence: 1.0,
    };

    const result = await updateEventService(
      existing.id,
      existing,
      incoming as any,
    );

    // Status must survive, and the identity key must not be regenerated.
    expect(prisma.event.update).not.toHaveBeenCalled();
    expect(result.status).toBe("confirmed");
    expect(result.eventKey).toBe("amazon|OA|2026-08-20");
    expect(result.date).toEqual(new Date("2026-08-20"));
  });

  it("writes no history when an automated update is refused", async () => {
    const existing = confirmedEvent();

    await updateEventService(
      existing.id,
      existing,
      {
        company: "amazon",
        stage: "OA",
        date: "2026-08-21",
        time: "18:00",
        confidence: 1.0,
      } as any,
    );

    // A refused update changed nothing, so it records nothing — consistent with
    // the existing REJECT path (EventUpdate.md: history records accepted belief).
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.eventUpdate.create).not.toHaveBeenCalled();
  });

  it("leaves the confirmed Event's confidence untouched", async () => {
    const existing = confirmedEvent();

    const result = await updateEventService(
      existing.id,
      existing,
      {
        company: "amazon",
        stage: "OA",
        date: "2026-08-20",
        time: "15:00",
        confidence: 1.0,
      } as any,
    );

    expect(result.confidence).toBe(1.0);
    expect(prisma.event.update).not.toHaveBeenCalled();
  });

  // --- Automated observations of every strength are refused ----------------

  it.each([0, 0.5, 0.6, 0.9, 1.0])(
    "refuses an automated observation with confidence %s",
    async (confidence) => {
      const existing = confirmedEvent();

      const result = await updateEventService(
        existing.id,
        existing,
        {
          company: "amazon",
          stage: "OA",
          date: "2026-08-20",
          time: "23:59",
          confidence,
        } as any,
      );

      expect(prisma.event.update).not.toHaveBeenCalled();
      expect(result.time).toBe("10:00");
    },
  );

  // --- Everything else still behaves exactly as before ---------------------

  it("still updates an Event awaiting review", async () => {
    const existing = confirmedEvent({
      status: "review",
      confidence: 0.4,
      reviewReason: "Low confidence: missing venue",
    });

    const incoming = {
      company: "amazon",
      stage: "OA",
      date: "2026-08-20",
      time: "15:00",
      confidence: 0.9,
    };

    (prisma.event.update as jest.Mock).mockResolvedValue({
      ...existing,
      time: "15:00",
      confidence: 0.9,
    });

    const result = await updateEventService(
      existing.id,
      existing,
      incoming as any,
    );

    expect(prisma.event.update).toHaveBeenCalled();
    expect(result.time).toBe("15:00");
  });

  it.each(["scheduled", "rescheduled"])(
    "still updates a %s Event",
    async (status) => {
      const existing = confirmedEvent({ status, confidence: 0.5 });

      (prisma.event.update as jest.Mock).mockResolvedValue({
        ...existing,
        time: "15:00",
        confidence: 0.9,
      });

      const result = await updateEventService(
        existing.id,
        existing,
        {
          company: "amazon",
          stage: "OA",
          date: "2026-08-20",
          time: "15:00",
          confidence: 0.9,
        } as any,
      );

      expect(prisma.event.update).toHaveBeenCalled();
      expect(result.time).toBe("15:00");
    },
  );

  it("still updates an Event with no status set", async () => {
    // Defensive: the guard tests for equality with "confirmed", so an Event
    // whose status is absent must not be caught by it.
    const existing = confirmedEvent({ status: undefined, confidence: 0.5 });

    (prisma.event.update as jest.Mock).mockResolvedValue({
      ...existing,
      time: "15:00",
    });

    await updateEventService(
      existing.id,
      existing,
      {
        company: "amazon",
        stage: "OA",
        date: "2026-08-20",
        time: "15:00",
        confidence: 0.9,
      } as any,
    );

    expect(prisma.event.update).toHaveBeenCalled();
  });

  // --- The human path is unaffected ----------------------------------------

  it("still allows a human to edit a confirmed Event", async () => {
    // Manual edits do not go through updateEventService at all; they use the
    // separate confirmation path, which the guard must not block.
    (prisma.event.update as jest.Mock).mockResolvedValue({
      ...confirmedEvent(),
      company: "Amazon India",
      confidence: 1.0,
      status: "confirmed",
    });

    const result = await updateEventManuallyService(1, {
      company: "Amazon India",
    });

    expect(prisma.event.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({
        company: "Amazon India",
        confidence: 1.0,
        status: "confirmed",
        reviewReason: null,
      }),
    });
    expect(result.company).toBe("Amazon India");
  });
});
