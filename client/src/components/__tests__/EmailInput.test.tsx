/* PR-7C RED — EmailInput must say what actually went wrong.
 *
 * PR-7B gave the API client a real error contract: 2xx resolves, anything else
 * rejects with an `ApiError` carrying `status`, and a network failure rejects
 * with fetch's own TypeError. EmailInput was never updated to read it. Its
 * `catch` treats every rejection identically and reports
 *
 *     "Could not reach the server. Check your connection and try again."
 *
 * so a 401, a 400 and a 500 all claim a connectivity problem that did not
 * happen — the server was reached and answered clearly in every one of those
 * cases. The 401 is the damaging one: a user whose session expired is told to
 * check their network instead of to sign in, which is the same conflation
 * PR-7B set out to remove from the dashboard, surviving in a second component.
 *
 * These tests pin four distinguishable outcomes. They deliberately do NOT pin
 * exact copy for the cases where no wording exists yet — asserting invented
 * strings would over-specify GREEN. What they pin is the distinction: which
 * category each failure belongs to, and which categories it must not be
 * confused with.
 *
 * `ApiError` is imported for real, not stubbed, so these run against the actual
 * contract PR-7B established rather than a local imitation of it.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

import EmailInput from "../EmailInput";
import { processEmail } from "../../api/emailApi";
import { ApiError } from "../../api/http";

vi.mock("../../api/emailApi", () => ({
  processEmail: vi.fn(),
}));

const EMAIL_TEXT = "Amazon OA on 20th Aug, venue PFA seating plan";

const SUCCESS_RESPONSE = {
  success: true,
  message: "Email queued for processing",
};

/* Types the email and presses Extract Events. The button is disabled until the
   textarea has content, so the order matters. */
const submit = async (text = EMAIL_TEXT) => {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /extract events/i }));
  await waitFor(() => expect(processEmail).toHaveBeenCalled());
};

/* Renders, submits against a given rejection, and returns the message the user
   is shown. Unmounts so the caller can compare two failures in one test. */
const messageFor = async (rejection: unknown): Promise<string> => {
  vi.mocked(processEmail).mockRejectedValue(rejection);

  const { unmount } = render(<EmailInput refresh={vi.fn()} />);
  await submit();

  const alert = await screen.findByRole("alert");
  const message = alert.textContent ?? "";

  unmount();
  return message;
};

const SIGN_IN_WORDING = /sign in|signed out|session|log in|authenticat/i;
const CONNECTIVITY_WORDING = /reach the server|connection|offline|network/i;

beforeEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ *
 * D. The success path is unchanged.
 * ------------------------------------------------------------------ */

describe("a successful submission behaves exactly as before", () => {
  beforeEach(() => {
    vi.mocked(processEmail).mockResolvedValue(SUCCESS_RESPONSE);
  });

  it("sends the text the user entered", async () => {
    render(<EmailInput refresh={vi.fn()} />);

    await submit();

    expect(processEmail).toHaveBeenCalledWith(EMAIL_TEXT);
  });

  it("clears the textarea", async () => {
    render(<EmailInput refresh={vi.fn()} />);

    await submit();

    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
  });

  it("confirms the email was processed", async () => {
    render(<EmailInput refresh={vi.fn()} />);

    await submit();

    expect(
      await screen.findByText("Email processed successfully"),
    ).toBeInTheDocument();
  });

  it("refreshes the dashboard once", async () => {
    const refresh = vi.fn();

    render(<EmailInput refresh={refresh} />);
    await submit();

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("reports no error", async () => {
    render(<EmailInput refresh={vi.fn()} />);

    await submit();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * E. 401 — an authentication problem.
 * ------------------------------------------------------------------ */

describe("a 401 is reported as an authentication problem", () => {
  it("tells the user their session needs re-establishing", async () => {
    const message = await messageFor(new ApiError(401));

    expect(message).toMatch(SIGN_IN_WORDING);
  });

  it("does not blame the connection", async () => {
    const message = await messageFor(new ApiError(401));

    // The server was reached. It answered. Saying otherwise sends the user to
    // debug a network that is working.
    expect(message).not.toMatch(CONNECTIVITY_WORDING);
  });
});

/* ------------------------------------------------------------------ *
 * F. A network failure — the one case the current message fits.
 * ------------------------------------------------------------------ */

describe("a network failure keeps the existing message", () => {
  it("blames the connection", async () => {
    const message = await messageFor(new TypeError("Failed to fetch"));

    expect(message).toMatch(CONNECTIVITY_WORDING);
  });

  it("does not send the user to sign in", async () => {
    const message = await messageFor(new TypeError("Failed to fetch"));

    expect(message).not.toMatch(SIGN_IN_WORDING);
  });
});

/* ------------------------------------------------------------------ *
 * G + H. 400 and 500 — neither is a connectivity or an auth problem, and
 * they are not each other either.
 * ------------------------------------------------------------------ */

describe("a rejected request is reported as a request problem", () => {
  it("does not blame the connection", async () => {
    const message = await messageFor(new ApiError(400, "Missing required fields"));

    expect(message).not.toMatch(CONNECTIVITY_WORDING);
  });

  it("does not send the user to sign in", async () => {
    const message = await messageFor(new ApiError(400, "Missing required fields"));

    expect(message).not.toMatch(SIGN_IN_WORDING);
  });
});

describe("a server failure is reported as a server problem", () => {
  it("does not blame the connection", async () => {
    const message = await messageFor(new ApiError(500));

    expect(message).not.toMatch(CONNECTIVITY_WORDING);
  });

  it("does not send the user to sign in", async () => {
    const message = await messageFor(new ApiError(500));

    expect(message).not.toMatch(SIGN_IN_WORDING);
  });
});

describe("the four failures are not collapsed into one message", () => {
  it("distinguishes a rejected request from a server failure", async () => {
    const badRequest = await messageFor(new ApiError(400));
    const serverError = await messageFor(new ApiError(500));

    // Four causes, four things worth telling the user. If 400 and 500 read the
    // same, the distinction exists only in the code.
    expect(badRequest).not.toBe(serverError);
  });

  it("distinguishes an authentication problem from a network problem", async () => {
    const unauthorized = await messageFor(new ApiError(401));
    const offline = await messageFor(new TypeError("Failed to fetch"));

    expect(unauthorized).not.toBe(offline);
  });
});

/* Phase 6 — the success message's own lifetime.
 *
 * It used to be dismissed by a bare `setTimeout` fired from inside the
 * submit handler, with nothing cancelling it. Two consequences, both
 * pinned below: a pending write survived the component (this section
 * unmounts for real when a refresh comes back 401), and two submissions
 * in quick succession left two timers running, so the first could clear
 * the second one's message early.
 *
 * The message and its three-second lifetime are unchanged — only who
 * owns the timer. */

describe("the success message clears itself", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(processEmail).mockResolvedValue(SUCCESS_RESPONSE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays on screen immediately after a successful submission", async () => {
    render(<EmailInput refresh={vi.fn()} />);
    await submit();

    expect(
      await screen.findByText(/email processed successfully/i),
    ).toBeInTheDocument();
  });

  it("disappears once its window has passed", async () => {
    render(<EmailInput refresh={vi.fn()} />);
    await submit();

    await screen.findByText(/email processed successfully/i);

    await act(async () => {
      vi.advanceTimersByTime(3200);
    });

    expect(screen.queryByText(/email processed successfully/i)).toBeNull();
  });

  /* The stacked-timer case: the second success must get its own full
     window rather than inheriting the remains of the first one's. */
  it("gives a second submission a fresh window", async () => {
    render(<EmailInput refresh={vi.fn()} />);
    await submit();
    await screen.findByText(/email processed successfully/i);

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    vi.mocked(processEmail).mockClear();
    await submit("a second email");
    await screen.findByText(/email processed successfully/i);

    /* The first timer would have fired by now if it were still pending. */
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    expect(
      screen.getByText(/email processed successfully/i),
    ).toBeInTheDocument();
  });

  /* Unmounting mid-window must leave nothing pending. */
  it("cancels its timer when the section unmounts", async () => {
    const { unmount } = render(<EmailInput refresh={vi.fn()} />);
    await submit();
    await screen.findByText(/email processed successfully/i);

    unmount();

    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
