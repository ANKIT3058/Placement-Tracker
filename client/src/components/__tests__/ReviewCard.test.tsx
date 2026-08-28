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
import { ApiError } from "../../api/http";

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

/* ------------------------------------------------------------------ *
 * PR-7D — a failed confirmation must be visible.
 *
 * `handleConfirm` has try/finally and no catch. Since PR-7B made `updateEvent`
 * reject on any non-2xx, a failure is now an unhandled promise rejection: the
 * spinner stops, the card stays, `refresh()` never runs, and the reviewer is
 * told nothing at all. They cannot tell a refused save from a successful one
 * that changed nothing.
 *
 * The 400 case carries the most weight. PR-3's allowlist answers with a message
 * naming exactly which fields were refused and which are editable — the single
 * most useful sentence the backend produces — and it is currently thrown away
 * twice over: once by `requestJson` not reading the body, once by ReviewCard
 * not catching.
 *
 * Wording is pinned only where the server authored it. For 401/500/network the
 * tests assert the CATEGORY, so GREEN chooses the copy.
 * ------------------------------------------------------------------ */

const SIGN_IN_WORDING = /sign in|signed out|session|log in|authenticat/i;
const CONNECTIVITY_WORDING = /reach the server|connection|offline|network/i;

const ALLOWLIST_MESSAGE =
  "Unsupported field(s): confidence, status. Only company, stage can be edited.";

/* Renders, confirms against a given rejection, and returns what the reviewer
   is shown. */
const failWith = async (rejection: unknown): Promise<string> => {
  vi.mocked(updateEvent).mockRejectedValue(rejection);

  render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);
  await confirm();

  const alert = await screen.findByRole("alert");
  return alert.textContent ?? "";
};

describe("a refused save is reported to the reviewer", () => {
  it("shows the server's explanation for a rejected request", async () => {
    const message = await failWith(new ApiError(400, ALLOWLIST_MESSAGE));

    // Verbatim: a paraphrase would lose the field names, which are the only
    // part a reviewer (or the next developer) can act on.
    expect(message).toContain(ALLOWLIST_MESSAGE);
  });

  it("reports an expired session as an authentication problem", async () => {
    const message = await failWith(new ApiError(401));

    expect(message).toMatch(SIGN_IN_WORDING);
    expect(message).not.toMatch(CONNECTIVITY_WORDING);
  });

  it("reports a server failure without blaming the session", async () => {
    const message = await failWith(new ApiError(500));

    expect(message).not.toMatch(SIGN_IN_WORDING);
    expect(message).not.toMatch(CONNECTIVITY_WORDING);
  });

  it("reports a network failure as a connectivity problem", async () => {
    const message = await failWith(new TypeError("Failed to fetch"));

    expect(message).toMatch(CONNECTIVITY_WORDING);
    expect(message).not.toMatch(SIGN_IN_WORDING);
  });
});

describe("a refused save leaves the card usable", () => {
  it("stops the saving state", async () => {
    vi.mocked(updateEvent).mockRejectedValue(new ApiError(500));

    render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);
    await confirm();

    // Back to "Confirm & Save", enabled — the reviewer can correct and retry.
    const button = await screen.findByRole("button", {
      name: /confirm & save/i,
    });
    expect(button).not.toBeDisabled();
  });

  it("keeps the reviewer's edits on screen", async () => {
    vi.mocked(updateEvent).mockRejectedValue(new ApiError(500));

    render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/company/i), {
      target: { value: "Amazon India" },
    });
    await confirm();

    // Losing a correction because the save failed would make the failure worse
    // than the bug.
    await waitFor(() =>
      expect(screen.getByLabelText(/company/i)).toHaveValue("Amazon India"),
    );
  });

  it("does not refresh the queue", async () => {
    const refresh = vi.fn();
    vi.mocked(updateEvent).mockRejectedValue(new ApiError(500));

    render(<ReviewCard event={reviewEvent} refresh={refresh} />);
    await confirm();

    // Refreshing would re-fetch unchanged data and re-render the same card,
    // reading as a successful save that did nothing.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeInTheDocument());
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("a successful save reports no error", () => {
  it("shows no alert", async () => {
    render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);

    await confirm();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

/* Phase 6 — what the reviewer sees and can do WHILE a save is in flight.
 *
 * A confirmation is a write, and the one failure mode a write must not
 * have is happening twice. These pin the three things that prevent it
 * and the feedback that explains why the card has gone quiet. */

describe("a save in flight", () => {
  /* Hold the request open so the in-flight state can be observed. */
  const holdSave = () => {
    let release!: () => void;

    vi.mocked(updateEvent).mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({});
      }),
    );

    return () => release();
  };

  it("disables the button so a second click cannot land", () => {
    holdSave();
    render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);

    const button = screen.getByRole("button", { name: /confirm & save/i });
    fireEvent.click(button);

    expect(button).toBeDisabled();
  });

  it("says what is happening rather than going blank", () => {
    holdSave();
    render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /confirm & save/i }));

    expect(screen.getByRole("button", { name: /saving/i })).toBeInTheDocument();
  });

  /* `aria-busy` is what makes the state available to a screen reader,
     and — since Phase 6 — what keeps the button legible while it is
     disabled, so it is worth pinning rather than leaving implicit. */
  it("marks itself busy for assistive technology", () => {
    holdSave();
    render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /confirm & save/i }));

    expect(screen.getByRole("button", { name: /saving/i })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  /* The fields are frozen too: an edit made mid-flight would not be in
     the request already on the wire, so accepting it would show the
     reviewer a value the server never received. */
  it("freezes the fields it is submitting", () => {
    holdSave();
    render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /confirm & save/i }));

    expect(screen.getByDisplayValue("amazon")).toBeDisabled();
    expect(screen.getByDisplayValue("OA")).toBeDisabled();
  });

  /* The guard behind the disabled attribute. Three clicks, one PATCH. */
  it("sends exactly one request however many times it is clicked", async () => {
    const release = holdSave();
    render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);

    const button = screen.getByRole("button", { name: /confirm & save/i });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));

    release();
    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));
  });

  it("becomes usable again once the save resolves", async () => {
    const release = holdSave();
    render(<ReviewCard event={reviewEvent} refresh={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /confirm & save/i }));
    release();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /confirm & save/i }),
      ).toBeEnabled(),
    );
  });
});
