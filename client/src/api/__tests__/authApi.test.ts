/* PR-7E RED — the logout API helper.
 *
 * `POST /auth/logout` already exists and is already correct: it destroys the
 * Redis session, clears the cookie with matching attributes, and answers 200
 * whether or not a session was there. There is simply no client for it.
 *
 * This pins the smallest helper that fits the existing API layer —
 * `client/src/api/authApi.ts`, alongside `eventApi` and `emailApi`, going
 * through the shared `requestJson` so it inherits PR-7B/7D's error contract for
 * free.
 *
 * ON IDEMPOTENCY. The brief anticipated a 401 needing to be treated as success.
 * It does not arise: `/auth/logout` is deliberately NOT behind `requireAuth`
 * (auth.routes.ts:6) and answers 200 for a caller with no session, precisely so
 * that "you are now logged out" is true either way and the response cannot be
 * used to probe whether a cookie was valid. Inventing 401-as-success on the
 * client would encode a contract the server does not have — so the real
 * behaviour is tested instead, here and in
 * backend/src/modules/auth/__tests__/logout.api.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { logout } from "../authApi";
import { ApiError } from "../http";

const respond = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const mockFetch = vi.fn();

/* The request the helper actually issued. */
const call = () => mockFetch.mock.calls[0] ?? [];

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("logout ends the session", () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue(respond(200, { success: true }));
  });

  it("resolves when the server confirms", async () => {
    await expect(logout()).resolves.not.toThrow();
  });

  it("posts to the logout endpoint", async () => {
    await logout();

    const [url, init] = call();

    expect(String(url)).toContain("/auth/logout");
    expect(init?.method).toBe("POST");
  });

  it("is a POST, never a GET", async () => {
    await logout();

    // Logout is state-changing, and `SameSite=Lax` sends the session cookie on
    // cross-site top-level GET navigations — a GET form would be reachable
    // from any page that can navigate the browser (RFC-001 §11.4).
    expect(call()[1]?.method).not.toBe("GET");
  });

  it("sends no body", async () => {
    await logout();

    // The session is identified by its cookie. There is nothing for a caller
    // to supply, and accepting anything would invite a caller to name a
    // session that is not theirs.
    expect(call()[1]?.body).toBeUndefined();
  });
});

describe("a caller with no session is still logged out", () => {
  it("resolves when the server reports success for an absent session", async () => {
    // What the backend actually answers — see the note at the top of this file.
    mockFetch.mockResolvedValue(respond(200, { success: true }));

    await expect(logout()).resolves.not.toThrow();
  });
});

describe("a failed logout is reported, not hidden", () => {
  it("rejects on a server failure", async () => {
    mockFetch.mockResolvedValue(respond(500, { message: "Failed to log out" }));

    // Converting this to success at the API layer would let the UI show a
    // signed-out screen while the session is still live on the server — the
    // most dangerous possible lie for this particular action.
    await expect(logout()).rejects.toBeInstanceOf(ApiError);
  });

  it("carries the status so the caller can tell failures apart", async () => {
    mockFetch.mockResolvedValue(respond(500, { message: "Failed to log out" }));

    await expect(logout()).rejects.toMatchObject({ status: 500 });
  });

  it("propagates a network failure unchanged", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(logout()).rejects.toBeInstanceOf(TypeError);
  });
});
