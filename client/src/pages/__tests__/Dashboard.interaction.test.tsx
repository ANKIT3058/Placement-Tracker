/* Phase 6 — how the dashboard BEHAVES, as opposed to what it renders.
 *
 * The existing suites pin structure (hierarchy), grouping (temporal) and
 * authentication. None of them drives the two controls a student touches
 * most — the search box and the stage chips — or covers what happens to
 * the page while a child component is refetching.
 *
 * The refetch case is the one that motivated this file. `refresh()` sets
 * the same `loading` flag the first paint uses, so confirming a single
 * review event replaced every card on the page with skeletons for the
 * length of a round trip: a local action producing a global loading
 * state. That is invisible to a structural test and obvious to a user.
 *
 * Everything here asserts through roles and text, never class names or
 * pixels, so the interactions stay pinned while the styling moves.
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

/* The two optional sections fetch on mount. Rejected so this suite makes
   no network call of any kind — that is the state in which each renders
   nothing, which keeps them out of the queries below. */
vi.mock("../../api/userApi", () => ({
  getStudentProfile: vi.fn().mockRejectedValue(new Error("not in this test")),
  updateStudentProfile: vi.fn(),
  getShortlistParticipation: vi
    .fn()
    .mockRejectedValue(new Error("not in this test")),
}));

/* jsdom implements <dialog> but not showModal()/close(). Stubbed with the
   minimum the drawer uses, rather than changing production code to suit
   the test environment. `close()` dispatches the real event, which is
   what Escape and the close button both go through. */
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
  company: "acme",
  stage: "OA",
  date: "2026-09-04T00:00:00.000Z",
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

const upcoming = (): HTMLElement =>
  screen
    .getByRole("heading", { name: /upcoming events/i, level: 2 })
    .closest("section")!;

const shownCompanies = (): string[] =>
  within(upcoming())
    .queryAllByRole("heading", { level: 3 })
    .map((h) => h.textContent ?? "");

/* React tracks the input's value internally, so the native setter has to
   be used before dispatching, or the change event carries a stale value. */
const typeSearch = async (value: string) => {
  const input = screen.getByLabelText(/search events by company/i);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;

  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const clickChip = async (label: string) => {
  await act(async () => {
    screen.getByRole("button", { name: label }).click();
  });
};

const chip = (label: string) => screen.getByRole("button", { name: label });

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 1;
});

/* ------------------------------------------------------------------ *
 * Search.
 * ------------------------------------------------------------------ */

describe("searching by company", () => {
  const catalogue = () => [
    makeEvent({ company: "google india", stage: "OA" }),
    makeEvent({ company: "flipkart", stage: "Interview" }),
    makeEvent({ company: "tata consultancy services", stage: "PPT" }),
  ];

  it("narrows the list as the student types", async () => {
    await renderDashboard(catalogue());

    await typeSearch("flip");

    expect(shownCompanies()).toEqual(["Flipkart"]);
  });

  /* The stored value is canonical lower case and the DISPLAYED value is
     title-cased, so a student typing what they see must still match. */
  it("matches regardless of case", async () => {
    await renderDashboard(catalogue());

    await typeSearch("GOOGLE");
    expect(shownCompanies()).toEqual(["Google India"]);

    await typeSearch("google");
    expect(shownCompanies()).toEqual(["Google India"]);
  });

  it("matches on a fragment from the middle of a name", async () => {
    await renderDashboard(catalogue());

    await typeSearch("consultancy");

    expect(shownCompanies()).toEqual(["Tata Consultancy Services"]);
  });

  it("restores every event when the search is cleared", async () => {
    await renderDashboard(catalogue());

    await typeSearch("flip");
    expect(shownCompanies()).toHaveLength(1);

    await typeSearch("");

    expect(shownCompanies()).toHaveLength(3);
  });

  /* Surrounding whitespace is trimmed before matching, so a stray space
     from a paste does not empty the list. */
  it("ignores surrounding whitespace", async () => {
    await renderDashboard(catalogue());

    await typeSearch("  flip  ");

    expect(shownCompanies()).toEqual(["Flipkart"]);
  });

  it("announces the result count to assistive technology", async () => {
    await renderDashboard(catalogue());

    await typeSearch("flip");

    expect(
      screen.getByText("1 of 3 events match the current filters"),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * The no-match message. One line, not a panel.
 * ------------------------------------------------------------------ */

describe("when nothing matches", () => {
  const catalogue = () => [
    makeEvent({ company: "google india", stage: "OA" }),
    makeEvent({ company: "flipkart", stage: "Interview" }),
  ];

  it("says so in a single line naming the term", async () => {
    await renderDashboard(catalogue());

    await typeSearch("zzzz");

    expect(screen.getByText("No events match “zzzz”")).toBeInTheDocument();
  });

  /* With both filters applied the student cannot tell which one emptied
     the list, so the message names the stage as well as the term. */
  it("names the stage too when a stage filter is also applied", async () => {
    await renderDashboard(catalogue());

    await typeSearch("zzzz");
    await clickChip("OA");

    expect(screen.getByText("No OA events match “zzzz”")).toBeInTheDocument();
  });

  it("reports an empty stage without inventing a search term", async () => {
    await renderDashboard([makeEvent({ company: "google india", stage: "OA" })]);

    await clickChip("PPT");

    expect(screen.getByText("No PPT events coming up")).toBeInTheDocument();
  });

  /* The panel this replaced carried a heading AND a paragraph of advice
     for a situation the student created one keystroke ago and can undo
     the same way. */
  it("does not restate the situation in a second paragraph", async () => {
    await renderDashboard(catalogue());

    await typeSearch("zzzz");

    expect(screen.queryByText(/try a shorter or different term/i)).toBeNull();
    expect(screen.queryByText("No matching events")).toBeNull();
  });

  it("recovers as soon as the search is cleared", async () => {
    await renderDashboard(catalogue());

    await typeSearch("zzzz");
    await typeSearch("");

    expect(shownCompanies()).toHaveLength(2);
    expect(screen.queryByText(/no events match/i)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Stage filters.
 * ------------------------------------------------------------------ */

describe("filtering by stage", () => {
  const catalogue = () => [
    makeEvent({ company: "alpha", stage: "Registration" }),
    makeEvent({ company: "beta", stage: "OA" }),
    makeEvent({ company: "gamma", stage: "Interview" }),
    makeEvent({ company: "delta", stage: "PPT" }),
  ];

  it.each([
    ["Registration", "Alpha"],
    ["OA", "Beta"],
    ["Interview", "Gamma"],
    ["PPT", "Delta"],
  ])("%s shows only its own events", async (label, expected) => {
    await renderDashboard(catalogue());

    await clickChip(label);

    expect(shownCompanies()).toEqual([expected]);
  });

  it("All shows everything again", async () => {
    await renderDashboard(catalogue());

    await clickChip("OA");
    expect(shownCompanies()).toHaveLength(1);

    await clickChip("All");

    expect(shownCompanies()).toHaveLength(4);
  });

  /* Exactly one selection, and it is exposed to assistive technology
     rather than carried by colour alone. */
  it("marks exactly one chip as pressed", async () => {
    await renderDashboard(catalogue());

    await clickChip("Interview");

    const labels = ["All", "Registration", "OA", "Interview", "PPT"];
    const pressed = labels.filter(
      (l) => chip(l).getAttribute("aria-pressed") === "true",
    );

    expect(pressed).toEqual(["Interview"]);
  });

  it("starts with All selected", async () => {
    await renderDashboard(catalogue());

    expect(chip("All")).toHaveAttribute("aria-pressed", "true");
  });

  it("switching stages replaces the selection rather than adding to it", async () => {
    await renderDashboard(catalogue());

    await clickChip("OA");
    await clickChip("PPT");

    expect(chip("OA")).toHaveAttribute("aria-pressed", "false");
    expect(chip("PPT")).toHaveAttribute("aria-pressed", "true");
    expect(shownCompanies()).toEqual(["Delta"]);
  });
});

/* ------------------------------------------------------------------ *
 * The two together.
 * ------------------------------------------------------------------ */

describe("search and stage compose", () => {
  const catalogue = () => [
    makeEvent({ company: "acme corp", stage: "OA" }),
    makeEvent({ company: "acme corp", stage: "Interview" }),
    makeEvent({ company: "zenith", stage: "OA" }),
  ];

  it("applies both predicates at once", async () => {
    await renderDashboard(catalogue());

    await typeSearch("acme");
    await clickChip("OA");

    expect(shownCompanies()).toEqual(["Acme Corp"]);
    expect(
      screen.getByText("1 of 3 events match the current filters"),
    ).toBeInTheDocument();
  });

  /* Changing one control must not silently reset the other. */
  it("keeps the search term when the stage changes", async () => {
    await renderDashboard(catalogue());

    await typeSearch("acme");
    await clickChip("Interview");

    expect(screen.getByLabelText(/search events by company/i)).toHaveValue(
      "acme",
    );
    expect(shownCompanies()).toEqual(["Acme Corp"]);
  });

  it("keeps the stage when the search changes", async () => {
    await renderDashboard(catalogue());

    await clickChip("OA");
    await typeSearch("zen");

    expect(chip("OA")).toHaveAttribute("aria-pressed", "true");
    expect(shownCompanies()).toEqual(["Zenith"]);
  });
});

/* ------------------------------------------------------------------ *
 * Loading. The reason this file exists.
 * ------------------------------------------------------------------ */

describe("loading feedback", () => {
  /* A first paint has nothing to show, so placeholders are the honest
     thing to draw. */
  it("shows placeholders while the first load is in flight", async () => {
    let release!: (events: Event[]) => void;
    vi.mocked(getEvents).mockReturnValue(
      new Promise<Event[]>((resolve) => {
        release = resolve;
      }),
    );

    render(<Dashboard />);

    expect(screen.getByText("Loading events…")).toBeInTheDocument();

    await act(async () => {
      release([makeEvent({ company: "google india" })]);
    });

    expect(screen.queryByText("Loading events…")).toBeNull();
  });

  /* A REFETCH IS NOT A FIRST PAINT. Confirming one review event calls the
     same `refresh()` the first load uses, and the page used to replace
     every card with placeholders while it ran. */
  it("keeps the existing events on screen while a refresh runs", async () => {
    vi.mocked(updateEvent).mockResolvedValue(undefined);

    const loaded = [
      makeEvent({ company: "google india" }),
      makeEvent({ company: "flipkart", status: "review" }),
    ];

    await renderDashboard(loaded);
    expect(shownCompanies()).toEqual(["Google India"]);

    /* Hold the refetch open so the transient state can be observed. */
    let release!: (events: Event[]) => void;
    vi.mocked(getEvents).mockReturnValue(
      new Promise<Event[]>((resolve) => {
        release = resolve;
      }),
    );

    await act(async () => {
      screen.getByRole("button", { name: /confirm & save/i }).click();
    });

    /* Mid-refresh: the events the student was reading are still there. */
    expect(shownCompanies()).toEqual(["Google India"]);
    expect(screen.queryByText("Loading events…")).toBeNull();

    await act(async () => {
      release(loaded);
    });

    expect(shownCompanies()).toEqual(["Google India"]);
  });
});

/* ------------------------------------------------------------------ *
 * The details drawer, opened and closed repeatedly.
 * ------------------------------------------------------------------ */

describe("the details drawer can be reopened", () => {
  const catalogue = () => [
    makeEvent({ company: "google india" }),
    makeEvent({ company: "flipkart" }),
  ];

  it("closes on the dialog's own close event", async () => {
    await renderDashboard(catalogue());

    await act(async () => {
      screen.getByRole("button", { name: /view details for google/i }).click();
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    /* The event Escape, the close button and the backdrop all go through. */
    await act(async () => {
      (document.querySelector("dialog") as HTMLDialogElement).close();
    });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /* The state that would break if closing left the component mounted:
     reopening the SAME card does not change any prop, so a stale mount
     would simply never call showModal again. */
  it("reopens the same card after closing", async () => {
    await renderDashboard(catalogue());

    await act(async () => {
      screen.getByRole("button", { name: /view details for google/i }).click();
    });
    await act(async () => {
      (document.querySelector("dialog") as HTMLDialogElement).close();
    });
    await act(async () => {
      screen.getByRole("button", { name: /view details for google/i }).click();
    });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens a different card after closing the first", async () => {
    await renderDashboard(catalogue());

    await act(async () => {
      screen.getByRole("button", { name: /view details for google/i }).click();
    });
    await act(async () => {
      (document.querySelector("dialog") as HTMLDialogElement).close();
    });
    await act(async () => {
      screen.getByRole("button", { name: /view details for flipkart/i }).click();
    });

    const dialog = screen.getByRole("dialog");

    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("Flipkart")).toBeInTheDocument();
  });
});
