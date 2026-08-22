/* PR-7B RED — the API client must distinguish "not signed in" from "no data".
 *
 * `getEvents` currently returns `res.json()` without inspecting `res.ok`, so a
 * 401 body — `{ success: false, message: "Authentication required" }` — comes
 * back as an ordinary resolved value. The Dashboard then does
 * `Array.isArray(data) ? data : []` and renders "No events yet", which is the
 * same thing it renders for a signed-in user with an empty account.
 *
 * A signed-out session, an empty account, and a broken server are three
 * different facts about the world, and the client currently collapses all of
 * them into one. That is a real defect on its own terms, and it is also how a
 * stale diagnosis of the auth flow survived several rounds of investigation:
 * the UI was reporting "you have no events" while the backend was saying
 * "I don't know who you are".
 *
 * These tests pin the minimum contract that keeps the three apart. They assert
 * the HTTP status reaches the caller, not a particular Error subclass, so GREEN
 * stays free to choose how to represent it.
 *
 * The backend is correct and unchanged: an unauthenticated GET /event MUST
 * stay 401. Nothing here asks for that to be relaxed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { getEvents } from "../eventApi";

/* A minimal stand-in for a fetch Response — only the three members the client
   touches. Constructing a real Response would test the platform, not us. */
const respondWith = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getEvents distinguishes authentication failure from empty data", () => {
  it("rejects when the session is missing", async () => {
    mockFetch.mockResolvedValue(
      respondWith(401, { success: false, message: "Authentication required" }),
    );

    // Today this resolves with the error body, which the caller cannot tell
    // apart from data.
    await expect(getEvents()).rejects.toThrow();
  });

  it("reports 401 on the rejection so the caller can recognise it", async () => {
    mockFetch.mockResolvedValue(
      respondWith(401, { success: false, message: "Authentication required" }),
    );

    // The status is the contract — the smallest thing that separates "sign in"
    // from "something broke". How it is wrapped is GREEN's choice.
    await expect(getEvents()).rejects.toMatchObject({ status: 401 });
  });

  it("returns the list for an authenticated user with no events", async () => {
    mockFetch.mockResolvedValue(respondWith(200, []));

    // The control case: an empty account is a SUCCESS, and must stay one.
    await expect(getEvents()).resolves.toEqual([]);
  });

  it("returns the list for an authenticated user with events", async () => {
    const events = [{ id: 1, company: "amazon" }];
    mockFetch.mockResolvedValue(respondWith(200, events));

    await expect(getEvents()).resolves.toEqual(events);
  });

  it("rejects on a server failure, distinctly from a signed-out session", async () => {
    mockFetch.mockResolvedValue(
      respondWith(500, { message: "Failed to fetch events" }),
    );

    await expect(getEvents()).rejects.toMatchObject({ status: 500 });
  });

  it("propagates a network failure rather than swallowing it", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    // No response at all: there is no status to report, but the caller must
    // still learn that the request did not succeed.
    await expect(getEvents()).rejects.toThrow();
  });
});
