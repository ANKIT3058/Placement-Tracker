/* PR-7A RED — the review queue's PATCH payload.
 *
 * PR-3 gave `PATCH /event/:id` a strict allowlist: a request may carry
 * `company` and `stage` and nothing else, and any other property rejects the
 * whole request with 400. `confidence`, `status` and `reviewReason` are set by
 * the server as part of what confirmation MEANS — a human decision raises trust
 * to certainty and clears the doubt — so a client that supplies them is
 * asserting values it does not own.
 *
 * ReviewCard still sends all four. Before PR-3 the extra two were silently
 * overwritten server-side and the outcome was identical either way, which is
 * why the redundancy survived unnoticed; PR-3 turned "ignored" into "rejected",
 * and Confirm & Save has been answering 400 since.
 *
 * The backend is correct and is not touched by this PR. These tests pin the
 * client side of the same contract, so the two cannot drift apart again
 * without something going red.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import ReviewCard from "../ReviewCard";
import { updateEvent } from "../../api/eventApi";

vi.mock("../../api/eventApi", () => ({
  getEvents: vi.fn(),
  updateEvent: vi.fn(),
}));

const EVENT_ID = 42;

const reviewEvent = {
  id: EVENT_ID,
  company: "amazon",
  stage: "OA",
  confidence: 0.4,
  reviewReason: "Low confidence: missing venue",
};

/* The payload handed to the API client — i.e. what would go on the wire as the
   PATCH body. Asserting here rather than on `fetch` keeps the test at the
   boundary ReviewCard actually owns: which fields it chooses to send. */
const patchBody = () => vi.mocked(updateEvent).mock.calls[0]?.[1];

const confirm = async () => {
  fireEvent.click(screen.getByRole("button", { name: /confirm & save/i }));
  await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(updateEvent).mockResolvedValue({});
});

describe("Confirm & Save sends only what the endpoint accepts", () => {
  it("sends exactly company and stage", async () => {
    render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);

    await confirm();

    expect(patchBody()).toEqual({ company: "amazon", stage: "OA" });
  });

  it("sends no server-controlled fields", async () => {
    render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);

    await confirm();

    // Absence, not a particular value: the server decides these, and a client
    // that names them at all is refused by the allowlist.
    expect(patchBody()).not.toHaveProperty("confidence");
    expect(patchBody()).not.toHaveProperty("status");
    expect(patchBody()).not.toHaveProperty("reviewReason");
  });
});

/* ------------------------------------------------------------------ *
 * The review workflow itself is unchanged. These pass today and must keep
 * passing: correcting the payload must not cost the card its behaviour.
 * ------------------------------------------------------------------ */

describe("the existing review behaviour is preserved", () => {
  it("sends the reviewer's corrections rather than the original values", async () => {
    render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/company/i), {
      target: { value: "Amazon India" },
    });
    fireEvent.change(screen.getByLabelText(/stage/i), {
      target: { value: "Interview" },
    });

    await confirm();

    expect(patchBody()).toMatchObject({
      company: "Amazon India",
      stage: "Interview",
    });
  });

  it("targets the Event being reviewed", async () => {
    render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);

    await confirm();

    expect(vi.mocked(updateEvent).mock.calls[0]?.[0]).toBe(EVENT_ID);
  });

  it("refreshes the queue once the confirmation succeeds", async () => {
    const refresh = vi.fn();

    render(<ReviewCard event={reviewEvent} refresh={refresh} />);

    await confirm();

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("still shows the reviewer why the Event needs review", async () => {
    render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);

    expect(
      screen.getByText("Low confidence: missing venue"),
    ).toBeInTheDocument();
  });
});
