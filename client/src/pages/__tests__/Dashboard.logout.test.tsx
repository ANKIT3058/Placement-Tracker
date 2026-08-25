/* PR-7E RED — logging out from the dashboard.
 *
 * The session is already destroyable: POST /auth/logout tears down the Redis
 * record and clears the cookie, and the backend suite now pins that. What is
 * missing is any way to ask for it — `grep -ri logout client/src` returns
 * nothing.
 *
 * No new authentication state is introduced. The dashboard already infers
 * "signed out" from a 401 on GET /event (PR-7B), so logging out is three
 * steps: end the session, re-fetch, and let the existing state machine do the
 * rest. That is why these tests assert `getEvents` is called AGAIN after logout
 * rather than looking for an internal flag — the source of truth stays where it
 * is.
 *
 * The logout request is asserted at the FETCH boundary rather than by mocking a
 * module, so the tests do not dictate where the helper lives. Any
 * implementation that issues a POST to /auth/logout satisfies them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import Dashboard from "../Dashboard";
import { getEvents } from "../../api/eventApi";

/* The Dashboard renders StudentProfileSection, which fetches the caller's
   profile on mount (G-8.3). Mocked at the module boundary for the same reason
   `eventApi` is: this file asserts the LOGOUT request at the fetch boundary and
   queues responses in order, so an unrelated call landing first would silently
   consume the one queued for the POST. Nothing here is about the profile. */
vi.mock("../../api/userApi", () => ({
  getStudentProfile: vi.fn().mockRejectedValue(new Error("not under test")),
  updateStudentProfile: vi.fn(),
}));

vi.mock("../../api/eventApi", () => ({
  getEvents: vi.fn(),
  updateEvent: vi.fn(),
}));

const httpError = (status: number): Error & { status: number } =>
  Object.assign(new Error(`Request failed with ${status}`), { status });

const anEvent = {
  id: 1,
  company: "Amazon",
  stage: "OA",
  date: "2026-09-05T00:00:00.000Z",
  time: null,
  isTimeEstimated: false,
  venue: null,
  confidence: 0.9,
  status: "scheduled",
  temporalStatus: "upcoming" as const,
  reviewReason: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const settled = () => waitFor(() => expect(getEvents).toHaveBeenCalled());

const logoutButton = () => screen.queryByRole("button", { name: /log ?out/i });

const signInLink = () =>
  screen.queryByRole("link", {
    name: /sign in|log in|connect|continue with google/i,
  });

const emailInputControl = () =>
  screen.queryByRole("button", { name: /extract events/i });

const eventCard = () => screen.queryByRole("heading", { name: "Amazon" });

const mockFetch = vi.fn();

const respond = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/* Signed in on the first fetch, signed out on every one after — what the server
   reports once the session has been destroyed. */
const signedInThenOut = () => {
  vi.mocked(getEvents)
    .mockResolvedValueOnce([anEvent])
    .mockRejectedValue(httpError(401));
};

const clickLogout = () => {
  fireEvent.click(screen.getByRole("button", { name: /log ?out/i }));
};

const logoutRequests = () =>
  mockFetch.mock.calls.filter(([url]) => String(url).includes("/auth/logout"));

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(respond(200, { success: true }));
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the logout control follows the authentication state", () => {
  it("is offered to a signed-in user", async () => {
    vi.mocked(getEvents).mockResolvedValue([anEvent]);

    render(<Dashboard />);
    await settled();

    await waitFor(() => expect(logoutButton()).toBeInTheDocument());
  });

  it("is a button, not a link", async () => {
    vi.mocked(getEvents).mockResolvedValue([anEvent]);

    render(<Dashboard />);
    await settled();

    // Logging out is a state-changing POST. A link would be semantically wrong
    // and, as a GET, CSRF-reachable under SameSite=Lax.
    await waitFor(() =>
      expect(logoutButton()?.tagName.toLowerCase()).toBe("button"),
    );
  });

  it("is not offered to a signed-out user", async () => {
    vi.mocked(getEvents).mockRejectedValue(httpError(401));

    render(<Dashboard />);
    await settled();

    await waitFor(() => expect(signInLink()).toBeInTheDocument());
    expect(logoutButton()).not.toBeInTheDocument();
  });
});

describe("logging out returns the user to the signed-out dashboard", () => {
  it("posts to the logout endpoint exactly once", async () => {
    signedInThenOut();

    render(<Dashboard />);
    await waitFor(() => expect(logoutButton()).toBeInTheDocument());
    clickLogout();

    await waitFor(() => expect(logoutRequests()).toHaveLength(1));
    expect(logoutRequests()[0]?.[1]?.method).toBe("POST");
  });

  it("re-checks the authentication state through the existing fetch", async () => {
    signedInThenOut();

    render(<Dashboard />);
    await waitFor(() => expect(logoutButton()).toBeInTheDocument());
    clickLogout();

    // No new source of truth: the dashboard asks GET /event again and believes
    // the answer.
    await waitFor(() => expect(getEvents).toHaveBeenCalledTimes(2));
  });

  it("shows the signed-out state", async () => {
    signedInThenOut();

    render(<Dashboard />);
    await waitFor(() => expect(logoutButton()).toBeInTheDocument());
    clickLogout();

    await waitFor(() => expect(signInLink()).toBeInTheDocument());
  });

  it("leaves no events on screen", async () => {
    signedInThenOut();

    render(<Dashboard />);
    await waitFor(() => expect(eventCard()).toBeInTheDocument());
    clickLogout();

    // A stale card after logging out suggests the data is still reachable.
    await waitFor(() => expect(eventCard()).not.toBeInTheDocument());
  });

  it("hides the manual email form", async () => {
    signedInThenOut();

    render(<Dashboard />);
    await waitFor(() => expect(logoutButton()).toBeInTheDocument());
    clickLogout();

    await waitFor(() => expect(emailInputControl()).not.toBeInTheDocument());
  });

  it("hides the logout control itself", async () => {
    signedInThenOut();

    render(<Dashboard />);
    await waitFor(() => expect(logoutButton()).toBeInTheDocument());
    clickLogout();

    await waitFor(() => expect(logoutButton()).not.toBeInTheDocument());
  });
});

describe("a failed logout leaves the user signed in", () => {
  it("reports a server failure", async () => {
    vi.mocked(getEvents).mockResolvedValue([anEvent]);
    mockFetch.mockResolvedValue(respond(500, { message: "Failed to log out" }));

    render(<Dashboard />);
    await waitFor(() => expect(logoutButton()).toBeInTheDocument());
    clickLogout();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("does not pretend the user is signed out", async () => {
    vi.mocked(getEvents).mockResolvedValue([anEvent]);
    mockFetch.mockResolvedValue(respond(500, { message: "Failed to log out" }));

    render(<Dashboard />);
    await waitFor(() => expect(logoutButton()).toBeInTheDocument());
    clickLogout();

    await screen.findByRole("alert");

    // The session may still be live on the server. A signed-out screen here
    // would be the most dangerous possible lie for this action — on a shared
    // machine especially.
    expect(signInLink()).not.toBeInTheDocument();
    expect(eventCard()).toBeInTheDocument();
  });

  it("reports a network failure as a connectivity problem", async () => {
    vi.mocked(getEvents).mockResolvedValue([anEvent]);
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    render(<Dashboard />);
    await waitFor(() => expect(logoutButton()).toBeInTheDocument());
    clickLogout();

    const alert = await screen.findByRole("alert");

    expect(alert.textContent ?? "").toMatch(
      /reach the server|connection|offline|network/i,
    );
    expect(signInLink()).not.toBeInTheDocument();
  });

  it("can be retried after a failure", async () => {
    vi.mocked(getEvents)
      .mockResolvedValueOnce([anEvent])
      .mockRejectedValue(httpError(401));
    mockFetch
      .mockResolvedValueOnce(respond(500, { message: "Failed to log out" }))
      .mockResolvedValue(respond(200, { success: true }));

    render(<Dashboard />);
    await waitFor(() => expect(logoutButton()).toBeInTheDocument());

    clickLogout();
    await screen.findByRole("alert");

    // One failure must not disable the control for good.
    clickLogout();

    await waitFor(() => expect(signInLink()).toBeInTheDocument());
  });
});

describe("logging out cannot be issued twice at once", () => {
  it("ignores a second click while the first is in flight", async () => {
    vi.mocked(getEvents)
      .mockResolvedValueOnce([anEvent])
      .mockRejectedValue(httpError(401));

    let release: (value: unknown) => void = () => {};
    mockFetch.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    render(<Dashboard />);
    await waitFor(() => expect(logoutButton()).toBeInTheDocument());

    clickLogout();
    clickLogout();

    release(respond(200, { success: true }));

    // Two clicks, one request: the control is disabled while the request is
    // outstanding.
    await waitFor(() => expect(logoutRequests()).toHaveLength(1));
  });
});
