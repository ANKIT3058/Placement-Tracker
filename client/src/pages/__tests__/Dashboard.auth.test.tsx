/* PR-7B RED — the dashboard tells a signed-out user they are signed out.
 *
 * Three different facts must produce three different screens:
 *
 *   401          → you are not signed in; here is how to sign in
 *   200 []       → you are signed in and have no events yet
 *   500 / network→ something went wrong on our side
 *
 * Today all three render the same "No events yet" empty state, because
 * `getEvents` does not inspect `res.ok` and `Dashboard` has no catch and no
 * error state at all. The signed-out case is the damaging one: it tells the
 * user their account is empty when the truth is that the app never identified
 * them, and it leaves them with nothing to click.
 *
 * These tests assert observable outcomes — which state is shown, and whether
 * there is a way to start signing in — not copy and not styling. The one
 * concrete thing pinned is the sign-in destination, because that is a
 * navigation contract rather than a design choice: `/gmail/auth` is where the
 * backend begins the OAuth exchange (gmail.route.ts), reached through the
 * same-origin `/api` proxy like every other API call.
 *
 * The backend is not changed and must not be: an unauthenticated GET /event
 * stays 401.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import Dashboard from "../Dashboard";
import { getEvents } from "../../api/eventApi";

vi.mock("../../api/eventApi", () => ({
  getEvents: vi.fn(),
  updateEvent: vi.fn(),
}));

/* What the API client will reject with once it inspects `res.ok` — see
   src/api/__tests__/eventApi.test.ts, which pins that contract. */
const httpError = (status: number): Error & { status: number } =>
  Object.assign(new Error(`Request failed with ${status}`), { status });

/* Waits for the initial fetch to settle. The loading branch renders skeletons
   and no section headings, so the absence of the loading indicator is the
   signal that the dashboard has decided what to show. */
const settled = () =>
  waitFor(() => expect(getEvents).toHaveBeenCalledTimes(1));

const signInLink = () =>
  screen.queryByRole("link", { name: /sign in|log in|connect|continue with google/i });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a signed-out user is told to sign in", () => {
  it("does not claim the account is empty", async () => {
    vi.mocked(getEvents).mockRejectedValue(httpError(401));

    render(<Dashboard />);
    await settled();

    // The damaging conflation: "we don't know who you are" rendered as
    // "you have nothing".
    await waitFor(() => {
      expect(screen.queryByText("No events yet")).not.toBeInTheDocument();
    });
  });

  it("offers a way to start signing in", async () => {
    vi.mocked(getEvents).mockRejectedValue(httpError(401));

    render(<Dashboard />);
    await settled();

    await waitFor(() => expect(signInLink()).toBeInTheDocument());
  });

  it("points the sign-in action at the OAuth entry point", async () => {
    vi.mocked(getEvents).mockRejectedValue(httpError(401));

    render(<Dashboard />);
    await settled();

    // A navigation contract, not a design: OAuth needs a real browser
    // navigation, so this must be a link the browser follows — not a fetch.
    await waitFor(() =>
      expect(signInLink()).toHaveAttribute(
        "href",
        expect.stringContaining("/gmail/auth"),
      ),
    );
  });
});

describe("an authenticated user with no events sees the ordinary empty state", () => {
  it("keeps the existing first-run empty state", async () => {
    vi.mocked(getEvents).mockResolvedValue([]);

    render(<Dashboard />);
    await settled();

    // The control for the 401 case: this is what "you have no events" is
    // supposed to look like, and it must stay exactly as it is.
    expect(await screen.findByText("No events yet")).toBeInTheDocument();
  });

  it("does not offer a sign-in action to someone already signed in", async () => {
    vi.mocked(getEvents).mockResolvedValue([]);

    render(<Dashboard />);
    await settled();

    expect(signInLink()).not.toBeInTheDocument();
  });
});

describe("a server failure is reported as a failure", () => {
  it("does not claim the account is empty", async () => {
    vi.mocked(getEvents).mockRejectedValue(httpError(500));

    render(<Dashboard />);
    await settled();

    await waitFor(() => {
      expect(screen.queryByText("No events yet")).not.toBeInTheDocument();
    });
  });

  it("does not send the user to sign in again", async () => {
    vi.mocked(getEvents).mockRejectedValue(httpError(500));

    render(<Dashboard />);
    await settled();

    // A 500 is not an authentication problem; offering sign-in would send the
    // user round a loop that cannot fix anything.
    await waitFor(() => expect(signInLink()).not.toBeInTheDocument());
  });
});

/* ------------------------------------------------------------------ *
 * PR-7C. Manual ingestion is an authenticated feature.
 *
 * POST /email is behind requireAuth and Email.userId is NOT NULL, so a
 * signed-out caller has no owner to attribute a row to and is refused. Offering
 * the paste-and-extract form to someone in that state advertises an action that
 * cannot succeed — directly above a panel telling them they are signed out.
 *
 * An empty account is emphatically NOT the same state: a signed-in user with no
 * events is exactly who most needs the form.
 * ------------------------------------------------------------------ */

const emailInput = () =>
  screen.queryByRole("button", { name: /extract events/i });

describe("the manual email form follows the authentication state", () => {
  it("is not offered to a signed-out user", async () => {
    vi.mocked(getEvents).mockRejectedValue(httpError(401));

    render(<Dashboard />);
    await settled();

    await waitFor(() => expect(emailInput()).not.toBeInTheDocument());
  });

  it("leaves the sign-in prompt as the only call to action", async () => {
    vi.mocked(getEvents).mockRejectedValue(httpError(401));

    render(<Dashboard />);
    await settled();

    await waitFor(() => expect(signInLink()).toBeInTheDocument());
    expect(emailInput()).not.toBeInTheDocument();
  });

  it("is offered to a signed-in user who has events", async () => {
    vi.mocked(getEvents).mockResolvedValue([]);

    render(<Dashboard />);
    await settled();

    // (fixtures for populated dashboards live in Dashboard.temporal.test.tsx;
    // presence of the control is what matters here)
    await waitFor(() => expect(emailInput()).toBeInTheDocument());
  });

  it("is offered to a signed-in user with no events yet", async () => {
    vi.mocked(getEvents).mockResolvedValue([]);

    render(<Dashboard />);
    await settled();

    // empty account ≠ signed out
    expect(await screen.findByText("No events yet")).toBeInTheDocument();
    expect(emailInput()).toBeInTheDocument();
  });

  it("is offered when the failure is not an authentication problem", async () => {
    vi.mocked(getEvents).mockRejectedValue(httpError(500));

    render(<Dashboard />);
    await settled();

    // A 500 says nothing about who the user is, so the form stays.
    await waitFor(() => expect(emailInput()).toBeInTheDocument());
  });
});
