/* PR-8B RED — the frontend half of double-submit.
 *
 * The server issues `placement.csrf` in a readable cookie; the browser must
 * echo it in `X-CSRF-Token` on every state-changing request. A cross-origin
 * attacker can cause a request but cannot read the cookie to echo it, and
 * cannot set the header without a preflight CORS will refuse.
 *
 * ONE integration point. `requestJson` is the only place any API call reaches
 * `fetch` (verified: `grep fetch client/src` matches http.ts and nothing else),
 * so attaching the header there means `getEvents`, `updateEvent`,
 * `processEmail` and `logout` all inherit it without a line changing in any of
 * them. That is the whole reason PR-8B is small: a per-caller scheme would be
 * four edits now and a forgotten one later.
 *
 * These tests never touch the session cookie. `placement.sid` is HttpOnly and
 * unreadable from script by design; the CSRF token is a separate, deliberately
 * readable value, and conflating the two is the classic way to get this wrong.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { requestJson } from "../http";

const CSRF_COOKIE = "placement.csrf";
const TOKEN = "tYRk9wQ2p3Lm5xVzhBc0RmR2hK";

const mockFetch = vi.fn();

const respond = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/* Headers as they would go on the wire, normalised so the assertions do not
   depend on whether the implementation uses a plain object or a Headers
   instance. */
const sentHeaders = (): Record<string, string> => {
  const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
  const raw = init?.headers;

  if (!raw) return {};

  const entries =
    raw instanceof Headers
      ? [...raw.entries()]
      : Array.isArray(raw)
        ? raw
        : Object.entries(raw as Record<string, string>);

  return Object.fromEntries(
    entries.map(([key, value]) => [String(key).toLowerCase(), String(value)]),
  );
};

const csrfHeader = () => sentHeaders()["x-csrf-token"];

const setCookie = (value: string) => {
  document.cookie = `${CSRF_COOKIE}=${value}; path=/`;
};

const clearCookies = () => {
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
};

beforeEach(() => {
  clearCookies();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(respond(200, {}));
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearCookies();
});

describe("state-changing requests carry the token", () => {
  beforeEach(() => {
    setCookie(TOKEN);
  });

  it("attaches it to a POST", async () => {
    await requestJson("/api/email", { method: "POST", body: "{}" });

    expect(csrfHeader()).toBe(TOKEN);
  });

  it("attaches it to a PATCH", async () => {
    await requestJson("/api/event/1", { method: "PATCH", body: "{}" });

    expect(csrfHeader()).toBe(TOKEN);
  });

  it("attaches it to a DELETE", async () => {
    await requestJson("/api/event/1", { method: "DELETE" });

    expect(csrfHeader()).toBe(TOKEN);
  });

  it("attaches it to a POST that sets no other headers", async () => {
    // `logout()` sends `{ method: "POST" }` and nothing else. It must still be
    // protected without any change to authApi.ts.
    await requestJson("/api/auth/logout", { method: "POST" });

    expect(csrfHeader()).toBe(TOKEN);
  });

  it("keeps the caller's own headers", async () => {
    await requestJson("/api/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(sentHeaders()["content-type"]).toBe("application/json");
    expect(csrfHeader()).toBe(TOKEN);
  });
});

describe("reads do not carry the token", () => {
  beforeEach(() => {
    setCookie(TOKEN);
  });

  it("omits it from a GET", async () => {
    await requestJson("/api/event");

    // Reads are exempt server-side; sending it anyway would widen the header's
    // exposure for no gain.
    expect(csrfHeader()).toBeUndefined();
  });

  it("omits it when the method is given explicitly as GET", async () => {
    await requestJson("/api/event", { method: "GET" });

    expect(csrfHeader()).toBeUndefined();
  });
});

describe("the token comes from the cookie and nowhere else", () => {
  it("sends no token when the cookie is absent", async () => {
    await requestJson("/api/email", { method: "POST", body: "{}" });

    // The server will refuse this with 403, which is the correct outcome — the
    // client must not invent a value.
    expect(csrfHeader()).toBeUndefined();
  });

  it("finds the token among other cookies", async () => {
    document.cookie = "other=irrelevant; path=/";
    setCookie(TOKEN);
    document.cookie = "another=value; path=/";

    await requestJson("/api/email", { method: "POST", body: "{}" });

    expect(csrfHeader()).toBe(TOKEN);
  });

  it("does not confuse the session cookie for the token", async () => {
    // `placement.sid` is HttpOnly in production and unreadable from script;
    // jsdom does not enforce that, which makes this worth asserting explicitly.
    document.cookie = "placement.sid=a-session-identifier; path=/";
    setCookie(TOKEN);

    await requestJson("/api/email", { method: "POST", body: "{}" });

    expect(csrfHeader()).toBe(TOKEN);
    expect(csrfHeader()).not.toBe("a-session-identifier");
  });

  it("does not send the session cookie in any header", async () => {
    document.cookie = "placement.sid=a-session-identifier; path=/";
    setCookie(TOKEN);

    await requestJson("/api/email", { method: "POST", body: "{}" });

    expect(JSON.stringify(sentHeaders())).not.toContain("a-session-identifier");
  });
});

describe("a caller cannot substitute its own token", () => {
  it("overrides a caller-supplied CSRF header with the cookie value", async () => {
    setCookie(TOKEN);

    await requestJson("/api/email", {
      method: "POST",
      headers: { "X-CSRF-Token": "attacker-chosen" },
      body: "{}",
    });

    // The canonical value is the cookie. A caller that could override it —
    // deliberately or by copying an example — would silently opt out of the
    // protection, and the request would simply 403 with no obvious cause.
    expect(csrfHeader()).toBe(TOKEN);
  });

  it("overrides it regardless of header casing", async () => {
    setCookie(TOKEN);

    await requestJson("/api/email", {
      method: "POST",
      headers: { "x-csrf-token": "attacker-chosen" },
      body: "{}",
    });

    expect(csrfHeader()).toBe(TOKEN);
  });
});
