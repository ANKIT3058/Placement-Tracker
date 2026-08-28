/* The detail view, and the one thing it is now the only place to find.
 *
 * Phase 4 took extraction confidence off EventCard; Phase 5 took the
 * icons, the separator rule and the nested outlines with it. Both passes
 * were only defensible because the number did not disappear from the
 * product — it moved to the two surfaces where it informs a decision.
 * ReviewCard's half is covered by its own suite; this is the other half.
 *
 * Without this, "confidence is not on the card" is a test that passes
 * just as happily if confidence were deleted outright.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import EventDetailsDrawer from "../EventDetailsDrawer";
import type { Event } from "../../types/event";

/* jsdom implements <dialog> but not showModal()/close(), so mounting the
   drawer throws there. Stubbed with the minimum the component uses — it
   calls showModal on mount and close() from the button — rather than
   changing production code to suit the test environment. The real
   behaviour (focus trap, Escape, backdrop) is the platform's. */
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

const makeEvent = (overrides: Partial<Event> = {}): Event => ({
  id: 1,
  company: "google india",
  stage: "OA",
  date: "2026-09-04T00:00:00.000Z",
  time: "10:00",
  isTimeEstimated: false,
  venue: "Online — HackerRank",
  confidence: 0.94,
  status: "scheduled",
  reviewReason: null,
  temporalStatus: "upcoming",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const renderDrawer = (overrides: Partial<Event> = {}) =>
  render(
    <EventDetailsDrawer event={makeEvent(overrides)} onClose={vi.fn()} />,
  );

describe("confidence is still available here", () => {
  it("states the confidence the card does not show", () => {
    renderDrawer({ confidence: 0.94 });

    expect(screen.getByText("Confidence")).toBeInTheDocument();
    expect(screen.getByText(/94%/)).toBeInTheDocument();
  });

  it.each([
    [0.94, "High"],
    [0.71, "Medium"],
    [0.44, "Low"],
  ])("bands %s as %j", (confidence, band) => {
    renderDrawer({ confidence });

    expect(screen.getByText(new RegExp(band))).toBeInTheDocument();
  });
});

describe("the full record, labelled", () => {
  it("labels every field the compact card renders unlabelled", () => {
    renderDrawer();

    for (const label of ["Stage", "Date", "Time", "Venue", "Status"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  /* The card omits the time row entirely when none is known; the drawer
     is the surface that says so out loud. */
  it("states a missing time rather than omitting it", () => {
    renderDrawer({ time: null });

    expect(screen.getByText("Not specified")).toBeInTheDocument();
  });

  it("states a missing venue", () => {
    renderDrawer({ venue: null });

    expect(screen.getByText("To be announced")).toBeInTheDocument();
  });

  /* Same display vocabulary as the card — the two must not disagree. */
  it("uses the same status wording the card uses", () => {
    renderDrawer({ status: "review" });

    expect(screen.getByText("Needs review")).toBeInTheDocument();
  });

  it("uses the same stage wording the card uses", () => {
    renderDrawer({ stage: "unknown" });

    expect(screen.getByText("Other")).toBeInTheDocument();
  });

  it("titles itself with the readable company name", () => {
    renderDrawer({ company: "american express" });

    expect(
      screen.getByRole("heading", { name: "American Express" }),
    ).toBeInTheDocument();
  });
});
