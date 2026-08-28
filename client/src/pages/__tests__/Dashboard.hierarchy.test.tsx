/* Phase 2 — the dashboard's information hierarchy.
 *
 * On real data this page holds three upcoming events and sixty-eight
 * expired ones, so rendering history at full weight buries the only part
 * anyone opens the page for. This suite pins the shape that fixes that:
 *
 *   - the events come before the tool panels, not after them;
 *   - Past Events is a disclosure, shut on arrival;
 *   - while it is shut, its cards are NOT IN THE DOM — hiding them with
 *     CSS would still be sixty-eight cards' worth of work;
 *   - opening and closing it both work, from the keyboard as well.
 *
 * Temporal PLACEMENT — which event belongs in which section — is not
 * retested here; Dashboard.temporal.test.tsx owns that and still does.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

import Dashboard from "../Dashboard";
import { getEvents, updateEvent } from "../../api/eventApi";
import type { Event } from "../../types/event";

vi.mock("../../api/eventApi", () => ({
  getEvents: vi.fn(),
  updateEvent: vi.fn(),
}));

/* The two optional sections fetch on mount. Mocked so this suite makes no
   network call of any kind — they reject, which is the state in which each
   renders nothing, and that is exactly what the order assertions expect. */
vi.mock("../../api/userApi", () => ({
  getStudentProfile: vi.fn().mockRejectedValue(new Error("not in this test")),
  updateStudentProfile: vi.fn(),
  getShortlistParticipation: vi
    .fn()
    .mockRejectedValue(new Error("not in this test")),
}));

/* jsdom implements <dialog> but not showModal()/close(), so mounting
   EventDetailsDrawer throws "showModal is not a function" there. Stubbed
   with the minimum the component actually uses — it calls showModal on
   mount and close() from the button — so the drawer can be exercised
   without changing production code to suit the test environment. The real
   browser behaviour (focus trap, Escape, backdrop) is the platform's and
   is not what these tests are about. */
beforeEach(() => {
  const proto = window.HTMLDialogElement.prototype as unknown as {
    showModal: () => void;
    close: () => void;
  };

  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };

  proto.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

let nextId = 1;

const makeEvent = (overrides: Partial<Event> = {}): Event => ({
  id: nextId++,
  company: "Acme",
  stage: "OA",
  date: "2026-09-01T00:00:00.000Z",
  time: null,
  isTimeEstimated: false,
  venue: null,
  confidence: 0.9,
  status: "scheduled",
  reviewReason: null,
  temporalStatus: "upcoming",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const renderDashboard = async (events: Event[]) => {
  vi.mocked(getEvents).mockResolvedValue(events);

  render(<Dashboard />);

  await screen.findByRole("heading", { name: /needs review/i, level: 2 });
};

const heading = (name: RegExp) =>
  screen.getByRole("heading", { name, level: 2 });

const pastSummary = (): HTMLElement => {
  const found = heading(/past events/i).closest("summary");

  if (!found) {
    throw new Error("Past Events heading is not inside a <summary>");
  }

  return found;
};

const pastDetails = (): HTMLDetailsElement =>
  pastSummary().parentElement as HTMLDetailsElement;

/* HTML fires `toggle` as a queued task rather than synchronously with the
   click, so the re-render that mounts the cards lands a task later. */
const togglePastEvents = async (): Promise<void> => {
  await act(async () => {
    pastSummary().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const pastSection = (): HTMLElement => {
  const section = heading(/past events/i).closest("section");

  if (!section) {
    throw new Error("Past Events is not inside a <section>");
  }

  return section;
};

const cardCompaniesIn = (section: HTMLElement): string[] =>
  within(section)
    .queryAllByRole("heading", { level: 3 })
    .map((h) => h.textContent ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 1;
});

/* ------------------------------------------------------------------ *
 * 1 + 2. What stays visible.
 * ------------------------------------------------------------------ */

describe("current information stays visible", () => {
  it("shows upcoming events without any interaction", async () => {
    await renderDashboard([
      makeEvent({ company: "Google", temporalStatus: "upcoming" }),
    ]);

    const upcoming = heading(/upcoming events/i).closest("section")!;

    expect(cardCompaniesIn(upcoming)).toEqual(["Google"]);
  });

  it("shows the review section when something needs review", async () => {
    await renderDashboard([
      makeEvent({ company: "Flipkart", status: "review" }),
    ]);

    const review = heading(/needs review/i).closest("section")!;

    expect(within(review).getByDisplayValue("Flipkart")).toBeInTheDocument();
  });

  it("keeps the first-run empty upcoming state", async () => {
    await renderDashboard([]);

    const upcoming = heading(/upcoming events/i).closest("section")!;

    expect(within(upcoming).getByText("No events yet")).toBeInTheDocument();
  });

  it("keeps the empty upcoming state when only past events exist", async () => {
    await renderDashboard([
      makeEvent({ company: "Microsoft", temporalStatus: "expired" }),
    ]);

    const upcoming = heading(/upcoming events/i).closest("section")!;

    expect(within(upcoming).getByText("No events yet")).toBeInTheDocument();
  });

  /* The TITLE was fine; the description underneath it was not, in two
     ways. It told every reader to paste an email "above" — which stopped
     being true the moment Phase 2 moved the tool panels below the events
     — and it said the same thing to a student whose drives have all
     already happened, for whom the useful fact is that their history is
     a section further down. An empty Upcoming is not an empty account. */
  it("points a student with only past events at Past Events", async () => {
    await renderDashboard([
      makeEvent({ company: "Microsoft", temporalStatus: "expired" }),
    ]);

    const upcoming = heading(/upcoming events/i).closest("section")!;

    expect(
      within(upcoming).getByText(/under Past Events below/i),
    ).toBeInTheDocument();
  });

  it("tells a first-run student where the email form actually is", async () => {
    await renderDashboard([]);

    const upcoming = heading(/upcoming events/i).closest("section")!;

    expect(
      within(upcoming).getByText(/paste a placement email below/i),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * 3 + 4 + 9. Collapsed on arrival, and genuinely not rendered.
 * ------------------------------------------------------------------ */

describe("past events are collapsed by default", () => {
  const withHistory = () => [
    makeEvent({ company: "Google", temporalStatus: "upcoming" }),
    makeEvent({ company: "Microsoft", temporalStatus: "expired" }),
    makeEvent({ company: "Amazon", temporalStatus: "expired" }),
  ];

  it("starts shut", async () => {
    await renderDashboard(withHistory());

    expect(pastDetails().open).toBe(false);
  });

  /* The property that makes collapsing worth doing: not hidden, absent. */
  it("renders none of the past event cards while shut", async () => {
    await renderDashboard(withHistory());

    expect(cardCompaniesIn(pastSection())).toEqual([]);
    expect(screen.queryByText("Microsoft")).toBeNull();
    expect(screen.queryByText("Amazon")).toBeNull();
  });

  it("still shows how many there are", async () => {
    await renderDashboard(withHistory());

    expect(within(pastSummary()).getByText("2")).toBeInTheDocument();
  });

  it("shows a zero count rather than disappearing", async () => {
    await renderDashboard([
      makeEvent({ company: "Google", temporalStatus: "upcoming" }),
    ]);

    expect(within(pastSummary()).getByText("0")).toBeInTheDocument();
  });

  it("does not hide the upcoming cards along with the past ones", async () => {
    await renderDashboard(withHistory());

    const upcoming = heading(/upcoming events/i).closest("section")!;

    expect(cardCompaniesIn(upcoming)).toEqual(["Google"]);
  });
});

/* ------------------------------------------------------------------ *
 * 5 + 6. Opening and closing.
 * ------------------------------------------------------------------ */

describe("the past events disclosure opens and closes", () => {
  const withHistory = () => [
    makeEvent({ company: "Microsoft", temporalStatus: "expired" }),
    makeEvent({ company: "Amazon", temporalStatus: "expired" }),
  ];

  it("reveals the past cards when activated", async () => {
    await renderDashboard(withHistory());

    await togglePastEvents();

    expect(pastDetails().open).toBe(true);
    expect(cardCompaniesIn(pastSection()).sort()).toEqual([
      "Amazon",
      "Microsoft",
    ]);
  });

  it("hides them again when activated a second time", async () => {
    await renderDashboard(withHistory());

    await togglePastEvents();
    await togglePastEvents();

    expect(pastDetails().open).toBe(false);
    expect(cardCompaniesIn(pastSection())).toEqual([]);
  });

  it("opens from the keyboard", async () => {
    await renderDashboard(withHistory());

    /* Enter on a <summary> dispatches a click, which is the whole reason
       a native disclosure is used instead of a div with an onClick. */
    const summary = pastSummary();

    await act(async () => {
      summary.focus();
      summary.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      summary.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(pastDetails().open).toBe(true);
  });

  it("shows the existing empty state when opened with no history", async () => {
    await renderDashboard([
      makeEvent({ company: "Google", temporalStatus: "upcoming" }),
    ]);

    await togglePastEvents();

    expect(
      within(pastSection()).getByText("Nothing has expired"),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * 7. The actions that already existed still work.
 * ------------------------------------------------------------------ */

describe("existing behaviour survives the reordering", () => {
  it("still opens the details dialog from an upcoming card", async () => {
    await renderDashboard([makeEvent({ company: "Google" })]);

    await act(async () => {
      screen.getByRole("button", { name: /view details for google/i }).click();
    });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("still opens the details dialog from a past card once revealed", async () => {
    await renderDashboard([
      makeEvent({ company: "Microsoft", temporalStatus: "expired" }),
    ]);

    await togglePastEvents();

    await act(async () => {
      screen
        .getByRole("button", { name: /view details for microsoft/i })
        .click();
    });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("still saves a review correction", async () => {
    vi.mocked(updateEvent).mockResolvedValue(undefined);

    await renderDashboard([
      makeEvent({ company: "Flipkart", status: "review", stage: "OA" }),
    ]);

    await act(async () => {
      screen.getByRole("button", { name: /confirm & save/i }).click();
    });

    expect(updateEvent).toHaveBeenCalledWith(1, {
      company: "Flipkart",
      stage: "OA",
    });
  });

  it("still offers the manual email form, below the events", async () => {
    await renderDashboard([makeEvent({ company: "Google" })]);

    expect(
      heading(/process placement email/i),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * The ordering itself.
 * ------------------------------------------------------------------ */

describe("section order puts the events first", () => {
  it("orders upcoming, review, past, then the tools", async () => {
    await renderDashboard([makeEvent({ company: "Google" })]);

    const order = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent ?? "");

    const index = (label: RegExp) => order.findIndex((t) => label.test(t));

    expect(index(/upcoming events/i)).toBeLessThan(index(/needs review/i));
    expect(index(/needs review/i)).toBeLessThan(index(/past events/i));
    expect(index(/past events/i)).toBeLessThan(
      index(/process placement email/i),
    );
  });
});
