jest.mock("../../../lib/prisma");
jest.mock("../event.repository", () => ({
  updateEvent: jest.fn(),
}));

import { detectChanges } from "../event.service";
import { updateEventService } from "../event.service";
import * as repo from "../event.repository";

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

    // mock DB response
    (repo.updateEvent as jest.Mock).mockResolvedValue({
      ...existing,
      ...incoming,
    });

    const result = await updateEventService(
      existing.id,
      existing,
      incoming as any,
    );

    // ASSERT 1: repo was called
    expect(repo.updateEvent).toHaveBeenCalled();

    // ASSERT 2: correct data passed
    expect(repo.updateEvent).toHaveBeenCalledWith(
      existing.id,
      expect.objectContaining({
        time: "15:00",
        confidence: 0.9,
      }),
    );

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
