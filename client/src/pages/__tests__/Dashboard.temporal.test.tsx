/* PR-6B RED — the dashboard groups Events by the backend's temporal verdict.
 *
 * PR-5 made the backend the sole owner of temporal classification: every Event
 * arrives carrying `temporalStatus: "upcoming" | "expired"`, derived server-side
 * from date, time, isTimeEstimated and an authoritative clock in IST. The
 * dashboard's job is to put each Event in the right section and nothing more.
 *
 * Today it does not. `Dashboard.tsx` defines "Upcoming" as `status !== "review"`
 * — a lifecycle test, not a temporal one — so an event from last March renders
 * under "Upcoming Events" indefinitely, and there is no Expired section at all.
 *
 * Every fixture below states `temporalStatus` explicitly. Nothing here computes
 * it, and several tests deliberately set a `date` that CONTRADICTS the supplied
 * status: a past date marked upcoming, a future date marked expired. Those are
 * the tests that fail if the frontend ever starts recomputing time locally, and
 * they prove it without touching the system clock — see the note above the
 * "ignores the Event's own date and time" block.
 *
 * Scope: temporal placement only. Nothing here concerns registration numbers,
 * shortlists, or eligibility — whether an Event is relevant to a student is a
 * separate question this PR does not ask.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

import Dashboard from "../Dashboard";
import { getEvents } from "../../api/eventApi";
import type { Event } from "../../types/event";

/* `updateEvent` is included because ReviewCard imports it from the same module;
   a factory that omitted it would fail at import time, not at call time. */
vi.mock("../../api/eventApi", () => ({
  getEvents: vi.fn(),
  updateEvent: vi.fn(),
}));

/* The contract this PR establishes. `Event` does not carry `temporalStatus`
   yet — adding it is the GREEN change — so the field is expressed here as an
   intersection rather than by editing the production type or reaching for
   `any`. Fixtures stay fully type-checked either way. */
type ClassifiedEvent = Event & { temporalStatus: "upcoming" | "expired" };

let nextId = 1;

const makeEvent = (
  overrides: Partial<ClassifiedEvent> & {
    temporalStatus: ClassifiedEvent["temporalStatus"];
  },
): ClassifiedEvent => ({
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
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

/* Renders the dashboard and waits for the fetch to settle.
 *
 * "Needs Review" is the anchor rather than "Upcoming Events" because the
 * loading branch also renders an "Upcoming Events" heading above its skeleton
 * cards — awaiting that would resolve while still loading. */
const renderDashboard = async (events: ClassifiedEvent[]) => {
  vi.mocked(getEvents).mockResolvedValue(events);

  render(<Dashboard />);

  await screen.findByRole("heading", { name: /needs review/i, level: 2 });
};

const sectionFor = (name: RegExp): HTMLElement => {
  const heading = screen.getByRole("heading", { name, level: 2 });
  const section = heading.closest("section");

  if (!section) {
    throw new Error(`Heading ${name} is not inside a <section>`);
  }

  return section;
};

const upcomingSection = () => sectionFor(/upcoming events/i);
const reviewSection = () => sectionFor(/needs review/i);

/* The expired section is now a collapsed <details> labelled "Past
   Events", and its cards are NOT rendered while it is shut — so every
   assertion about what is inside it has to open it first.

   The assertions themselves are unchanged. This helper is the one step
   the new hierarchy adds; what each test then checks about placement,
   ordering and lifecycle status is exactly what it checked before. */
const pastEventsSummary = (): HTMLElement => {
  const summary = screen
    .getByRole("heading", { name: /past events/i, level: 2 })
    .closest("summary");

  if (!summary) {
    throw new Error("Past Events heading is not inside a <summary>");
  }

  return summary;
};

const pastEventsOpen = (): boolean =>
  (pastEventsSummary().parentElement as HTMLDetailsElement).open;

/* Opens the disclosure and waits for the cards to mount.
 *
 * ASYNC BECAUSE THE PLATFORM IS. HTML fires `toggle` as a QUEUED TASK, not
 * synchronously with the click, so the dashboard's `onToggle` — and the
 * re-render that mounts the cards — happen a task later. `act` alone
 * flushes microtasks and would return too early; yielding to the macrotask
 * queue inside it is what lets the toggle land first. */
const expandPastEvents = async (): Promise<void> => {
  const summary = pastEventsSummary();

  if (!pastEventsOpen()) {
    await act(async () => {
      summary.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

/* Opens the disclosure, then returns the section around it.
   Every assertion made through this helper is unchanged from before the
   section became collapsible; opening it is the only step that is new. */
const expiredSection = async (): Promise<HTMLElement> => {
  await expandPastEvents();
  return sectionFor(/past events/i);
};

/* Company names as EventCard renders them: an <h3> per card. Returned in DOM
   order so ordering assertions read naturally. */
const companiesIn = (section: HTMLElement): string[] =>
  within(section)
    .queryAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 1;
});

/* ------------------------------------------------------------------ *
 * A + B. Each status reaches its own section.
 * ------------------------------------------------------------------ */

describe("an Event is placed by its backend temporalStatus", () => {
  it("shows an upcoming Event under Upcoming Events", async () => {
    await renderDashboard([
      makeEvent({ company: "Google", temporalStatus: "upcoming" }),
    ]);

    expect(companiesIn(upcomingSection())).toEqual(["Google"]);
  });

  it("shows an expired Event under Expired Events", async () => {
    await renderDashboard([
      makeEvent({ company: "Microsoft", temporalStatus: "expired" }),
    ]);

    expect(companiesIn(await expiredSection())).toEqual(["Microsoft"]);
  });

  it("does not leave an expired Event in the Upcoming section", async () => {
    await renderDashboard([
      makeEvent({ company: "Microsoft", temporalStatus: "expired" }),
    ]);

    // The defect this PR fixes: today "Upcoming" means `status !== "review"`,
    // so an expired Event renders here.
    expect(companiesIn(upcomingSection())).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * C. A mixed list splits correctly, in both directions.
 * ------------------------------------------------------------------ */

describe("a mixed list is split between the two sections", () => {
  const mixed = () => [
    makeEvent({
      company: "Google",
      date: "2026-09-02T00:00:00.000Z",
      temporalStatus: "upcoming",
    }),
    makeEvent({
      company: "Microsoft",
      date: "2026-08-20T00:00:00.000Z",
      temporalStatus: "expired",
    }),
    makeEvent({
      company: "Amazon",
      date: "2026-09-05T00:00:00.000Z",
      temporalStatus: "upcoming",
    }),
  ];

  it("puts both upcoming Events under Upcoming Events", async () => {
    await renderDashboard(mixed());

    expect(companiesIn(upcomingSection()).sort()).toEqual(["Amazon", "Google"]);
  });

  it("puts the expired Event under Expired Events", async () => {
    await renderDashboard(mixed());

    expect(companiesIn(await expiredSection())).toEqual(["Microsoft"]);
  });

  it("puts no Event in the wrong section", async () => {
    await renderDashboard(mixed());

    expect(companiesIn(upcomingSection())).not.toContain("Microsoft");
    expect(companiesIn(await expiredSection())).not.toContain("Google");
    expect(companiesIn(await expiredSection())).not.toContain("Amazon");
  });
});

/* ------------------------------------------------------------------ *
 * D + F. The frontend does not recompute time.
 *
 * No system-clock manipulation: fake timers interact badly with React's async
 * rendering and with Testing Library's `findBy*` polling, which would make
 * these brittle for reasons unrelated to what they test. Contradicting the
 * date against the status proves the same property deterministically — if the
 * dashboard consulted `date`, `time` or `isTimeEstimated`, every test here
 * would land in the opposite section regardless of what the clock said.
 * ------------------------------------------------------------------ */

describe("the dashboard ignores the Event's own date and time", () => {
  it("separates two Events that share a calendar date", async () => {
    const date = "2026-09-01T00:00:00.000Z";

    await renderDashboard([
      makeEvent({ company: "Google", date, temporalStatus: "upcoming" }),
      makeEvent({ company: "Microsoft", date, temporalStatus: "expired" }),
    ]);

    // Identical dates, opposite sections: only `temporalStatus` can produce
    // this, so no date comparison can be responsible for the split.
    expect(companiesIn(upcomingSection())).toEqual(["Google"]);
    expect(companiesIn(await expiredSection())).toEqual(["Microsoft"]);
  });

  it("keeps a long-past Event upcoming when the backend says so", async () => {
    await renderDashboard([
      makeEvent({
        company: "Google",
        date: "2020-01-01T00:00:00.000Z",
        temporalStatus: "upcoming",
      }),
    ]);

    expect(companiesIn(upcomingSection())).toEqual(["Google"]);
  });

  it("keeps a far-future Event expired when the backend says so", async () => {
    await renderDashboard([
      makeEvent({
        company: "Microsoft",
        date: "2099-12-31T00:00:00.000Z",
        temporalStatus: "expired",
      }),
    ]);

    expect(companiesIn(await expiredSection())).toEqual(["Microsoft"]);
  });

  it("ignores time and isTimeEstimated entirely", async () => {
    await renderDashboard([
      makeEvent({
        company: "Google",
        date: "2020-01-01T00:00:00.000Z",
        time: "09:00",
        isTimeEstimated: true,
        temporalStatus: "upcoming",
      }),
      makeEvent({
        company: "Microsoft",
        date: "2099-12-31T00:00:00.000Z",
        time: "23:59",
        isTimeEstimated: false,
        temporalStatus: "expired",
      }),
    ]);

    expect(companiesIn(upcomingSection())).toEqual(["Google"]);
    expect(companiesIn(await expiredSection())).toEqual(["Microsoft"]);
  });
});

/* ------------------------------------------------------------------ *
 * E. Lifecycle status is a separate axis.
 * ------------------------------------------------------------------ */

describe("lifecycle status does not decide the temporal section", () => {
  it("places two confirmed Events by temporalStatus alone", async () => {
    await renderDashboard([
      makeEvent({
        company: "Google",
        status: "confirmed",
        temporalStatus: "expired",
      }),
      makeEvent({
        company: "Amazon",
        status: "confirmed",
        temporalStatus: "upcoming",
      }),
    ]);

    expect(companiesIn(await expiredSection())).toEqual(["Google"]);
    expect(companiesIn(upcomingSection())).toEqual(["Amazon"]);
  });

  it.each(["scheduled", "confirmed", "rescheduled"])(
    "places a %s Event marked expired under Expired Events",
    async (status) => {
      await renderDashboard([
        makeEvent({ company: "Google", status, temporalStatus: "expired" }),
      ]);

      expect(companiesIn(await expiredSection())).toEqual(["Google"]);
    },
  );

  it("still shows the lifecycle status on the card", async () => {
    await renderDashboard([
      makeEvent({
        company: "Google",
        status: "confirmed",
        temporalStatus: "expired",
      }),
    ]);

    // Grouping by time must not cost the card any information it shows today.
    // The card now renders the STATUS LABEL rather than the raw column
    // value (`statusLabel` in eventDisplay), so this asserts the label —
    // the assertion this suite cares about is that the status is still on
    // the card at all, and it still is.
    expect(
      within(await expiredSection()).getByText("Confirmed"),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * The Review workflow survives unchanged.
 * ------------------------------------------------------------------ */

describe("Events awaiting review stay in the review section", () => {
  it("renders a review Event under Needs Review", async () => {
    await renderDashboard([
      makeEvent({
        company: "Flipkart",
        status: "review",
        temporalStatus: "upcoming",
      }),
    ]);

    // ReviewCard renders the company as an editable input, not as text.
    expect(
      within(reviewSection()).getByDisplayValue("Flipkart"),
    ).toBeInTheDocument();
  });

  it("keeps a review Event out of both temporal sections", async () => {
    await renderDashboard([
      makeEvent({
        company: "Flipkart",
        status: "review",
        temporalStatus: "upcoming",
      }),
      makeEvent({ company: "Google", temporalStatus: "upcoming" }),
    ]);

    expect(companiesIn(upcomingSection())).toEqual(["Google"]);
    expect(companiesIn(await expiredSection())).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * G + H + I. Empty cases, following the dashboard's existing convention:
 * a section always renders, with an EmptyState inside it when it has no rows.
 *
 * The copy asserted below is the copy already in Dashboard.tsx — nothing new
 * is invented here. What an EMPTY Expired section should say is left
 * unasserted on purpose; see the report.
 * ------------------------------------------------------------------ */

describe("empty sections", () => {
  it("shows the existing empty state when nothing is upcoming", async () => {
    await renderDashboard([
      makeEvent({ company: "Microsoft", temporalStatus: "expired" }),
    ]);

    expect(
      within(upcomingSection()).getByText("No events yet"),
    ).toBeInTheDocument();
    expect(companiesIn(await expiredSection())).toEqual(["Microsoft"]);
  });

  it("shows upcoming Events when nothing has expired", async () => {
    await renderDashboard([
      makeEvent({ company: "Google", temporalStatus: "upcoming" }),
    ]);

    expect(companiesIn(upcomingSection())).toEqual(["Google"]);
  });

  it("keeps the first-run empty state when there are no Events at all", async () => {
    await renderDashboard([]);

    expect(
      within(upcomingSection()).getByText("No events yet"),
    ).toBeInTheDocument();
    /* The review section's empty state is now a single compact line
       rather than a panel, and its wording changed with it. What this
       assertion is for — that BOTH sections still say something on a
       first-run account rather than rendering nothing — is unchanged. */
    expect(
      within(reviewSection()).getByText("Nothing needs your attention"),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Sorting is preserved, not redefined. PR-6 is not a sorting change.
 * ------------------------------------------------------------------ */

describe("existing ordering is preserved", () => {
  it("keeps upcoming Events in ascending date order", async () => {
    await renderDashboard([
      makeEvent({
        company: "Later",
        date: "2026-09-20T00:00:00.000Z",
        temporalStatus: "upcoming",
      }),
      makeEvent({
        company: "Sooner",
        date: "2026-09-02T00:00:00.000Z",
        temporalStatus: "upcoming",
      }),
      makeEvent({
        company: "Middle",
        date: "2026-09-10T00:00:00.000Z",
        temporalStatus: "upcoming",
      }),
    ]);

    expect(companiesIn(upcomingSection())).toEqual([
      "Sooner",
      "Middle",
      "Later",
    ]);
  });
});
