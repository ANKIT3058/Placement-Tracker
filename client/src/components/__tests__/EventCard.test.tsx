/* What an EventCard says to a student.
 *
 * There was no suite for this component, which is how the card kept
 * every field it had ever been given: an extraction confidence meter sat
 * in the footer beside the status, ahead of it in reading order, and a
 * low-confidence event drew a red "Low · 44%" chip that read as though
 * the DRIVE were in doubt rather than the parser.
 *
 * Phase 4 took confidence off this card. These tests pin both halves of
 * that: everything a student needs is still here, and the pipeline's
 * own numbers are not. They assert on TEXT AND ROLES, never on pixels or
 * class names, so the card can be restyled without touching them.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import EventCard from "../EventCard";
import type { Event } from "../../types/event";

/* Deliberately shaped like a row the API really sends: the company is
   canonical lower case (the backend cleanup canonicalised it), and the
   time is the 24h "HH:MM" the column stores rather than something
   pre-formatted. */
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

const renderCard = (overrides: Partial<Event> = {}, onSelect = vi.fn()) => {
  render(<EventCard event={makeEvent(overrides)} onSelect={onSelect} />);

  return onSelect;
};

/* ------------------------------------------------------------------ *
 * What the student sees.
 * ------------------------------------------------------------------ */

describe("the event itself", () => {
  it("shows the company, made readable from the canonical value", () => {
    renderCard({ company: "american express" });

    expect(screen.getByText("American Express")).toBeInTheDocument();
  });

  it("shows the company as a heading, so the card has a spine", () => {
    renderCard({ company: "google india" });

    expect(
      screen.getByRole("heading", { name: "Google India", level: 3 }),
    ).toBeInTheDocument();
  });

  it("shows the stage", () => {
    renderCard({ stage: "Interview" });

    expect(screen.getByText("Interview")).toBeInTheDocument();
  });

  it("shows the date", () => {
    renderCard();

    expect(screen.getByText("Sep 4, 2026")).toBeInTheDocument();
  });

  it("shows the time when there is one", () => {
    renderCard({ time: "10:00" });

    expect(screen.getByText("10:00 AM")).toBeInTheDocument();
  });

  it("shows the venue when there is one", () => {
    renderCard({ venue: "Main Auditorium" });

    expect(screen.getByText("Main Auditorium")).toBeInTheDocument();
  });

  it("shows the status", () => {
    renderCard({ status: "scheduled" });

    expect(screen.getByText("Scheduled")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * What the student no longer sees. The whole point of the phase.
 * ------------------------------------------------------------------ */

describe("extraction confidence is not on the card", () => {
  /* Across the whole 0..1 range, because the old card rendered a
     different label and a different colour at each band — and the low
     band was the actively misleading one. */
  it.each([
    ["high", 0.94],
    ["medium", 0.71],
    ["low", 0.44],
  ])("renders no percentage for %s confidence", (_band, confidence) => {
    renderCard({ confidence });

    expect(screen.queryByText(/%/)).toBeNull();
  });

  it.each([["High"], ["Medium"], ["Low"]])(
    "renders no %j confidence label",
    (label) => {
      renderCard({ confidence: 0.44 });

      expect(screen.queryByText(new RegExp(`\\b${label}\\b`))).toBeNull();
    },
  );

  /* The tooltip said "AI extraction confidence" in so many words — the
     clearest piece of pipeline vocabulary the card carried. */
  it("mentions neither extraction nor confidence anywhere", () => {
    const { container } = render(
      <EventCard event={makeEvent({ confidence: 0.44 })} onSelect={vi.fn()} />,
    );

    expect(container.innerHTML).not.toMatch(/confidence/i);
    expect(container.innerHTML).not.toMatch(/extraction/i);
  });

  /* Removed from the PRESENTATION, not from the data: the prop is still
     required and the card still accepts and ignores it. */
  it("still accepts an event carrying a confidence value", () => {
    renderCard({ confidence: 0.12 });

    expect(screen.getByRole("heading", { level: 3 })).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Values the backend may send that today's frontend has never seen.
 * ------------------------------------------------------------------ */

describe("unknown values stay safely representable", () => {
  it("renders a human label for an unrecognised status", () => {
    renderCard({ status: "something-new" });

    expect(screen.getByText("Something new")).toBeInTheDocument();
  });

  it("renders a neutral label for the unresolved stage sentinel", () => {
    renderCard({ stage: "unknown" });

    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.queryByText("unknown")).toBeNull();
  });

  it("never renders a blank status chip", () => {
    renderCard({ status: "" });

    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("never renders the literal string undefined", () => {
    const { container } = render(
      <EventCard
        event={makeEvent({ status: "brand-new", stage: "Mystery Round" })}
        onSelect={vi.fn()}
      />,
    );

    expect(container.textContent).not.toMatch(/undefined/);
  });
});

/* ------------------------------------------------------------------ *
 * Absent data. Unchanged behaviour — pinned because this phase touched
 * the rows these values render in.
 * ------------------------------------------------------------------ */

describe("missing and estimated values", () => {
  it("omits the time row entirely when no time is known", () => {
    renderCard({ time: null });

    expect(screen.queryByText(/AM|PM/)).toBeNull();
    /* The date is still there — a missing time must not cost the date. */
    expect(screen.getByText("Sep 4, 2026")).toBeInTheDocument();
  });

  it("marks an estimated time as estimated", () => {
    renderCard({ time: "14:30", isTimeEstimated: true });

    expect(screen.getByText("2:30 PM (estimated)")).toBeInTheDocument();
  });

  it("does not mark a stated time as estimated", () => {
    renderCard({ time: "14:30", isTimeEstimated: false });

    expect(screen.getByText("2:30 PM")).toBeInTheDocument();
  });

  it("says a missing venue is to be announced", () => {
    renderCard({ venue: null });

    expect(screen.getByText("To be announced")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * The card is still the control it was.
 * ------------------------------------------------------------------ */

describe("opening the details view", () => {
  it("keeps an accessible name naming the company", () => {
    renderCard({ company: "google india" });

    expect(
      screen.getByRole("button", { name: "View details for Google India" }),
    ).toBeInTheDocument();
  });

  it("announces that it opens a dialog", () => {
    renderCard();

    expect(screen.getByRole("button")).toHaveAttribute(
      "aria-haspopup",
      "dialog",
    );
  });

  it("is reachable by keyboard", () => {
    renderCard();

    expect(screen.getByRole("button")).toHaveAttribute("tabindex", "0");
  });

  it("calls onSelect when activated", () => {
    const onSelect = renderCard();

    screen.getByRole("button").click();

    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
