/* G-8.3 — the student profile API client.
 *
 * A registration number is optional campus information, never identity, and the
 * profile is addressed by the authenticated session alone. The assertions that
 * carry this file are therefore mostly about what the client does NOT do: it
 * sends no id, it imposes no format rule, and it does not trim.
 *
 * That last pair matters more than it looks. The server deliberately accepts
 * arbitrary strings and owns the trimming; a client-side rule would be a second
 * implementation of a decision that was made once, free to drift, and invisible
 * to the API contract's own tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { getStudentProfile, updateStudentProfile } from "../userApi";

/* A minimal stand-in for a fetch Response — only the members the client
   touches. Constructing a real Response would test the platform, not us. */
const respondWith = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const profileBody = (registrationNumber: string | null) => ({
  success: true,
  profile: { registrationNumber },
});

const mockFetch = vi.fn();

const urlOf = (call: unknown[]) => String(call[0]);
const initOf = (call: unknown[]) => call[1] as RequestInit | undefined;
const bodyOf = (call: unknown[]) =>
  JSON.parse(String(initOf(call)?.body ?? "{}"));

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getStudentProfile", () => {
  it("reads the caller's own profile with no id in the URL", async () => {
    mockFetch.mockResolvedValue(respondWith(200, profileBody("20231234")));

    await getStudentProfile();

    const url = urlOf(mockFetch.mock.calls[0]);

    // The session is the whole address. A `/user/1/profile` shape would mean
    // the client believed it could name a row, and the backend has no such
    // route to answer it.
    expect(url).toMatch(/\/user\/profile$/);
    expect(url).not.toMatch(/\/user\/\d+/);
  });

  it("unwraps the profile from the envelope", async () => {
    mockFetch.mockResolvedValue(respondWith(200, profileBody("ABC-123")));

    await expect(getStudentProfile()).resolves.toEqual({
      registrationNumber: "ABC-123",
    });
  });

  it("returns null for a student who has never set one", async () => {
    mockFetch.mockResolvedValue(respondWith(200, profileBody(null)));

    // Not an error and not an empty state to be fixed — an ordinary account.
    await expect(getStudentProfile()).resolves.toEqual({
      registrationNumber: null,
    });
  });

  it("issues no method, so the shared client treats it as a safe GET", async () => {
    mockFetch.mockResolvedValue(respondWith(200, profileBody(null)));

    await getStudentProfile();

    expect(initOf(mockFetch.mock.calls[0])?.method).toBeUndefined();
  });

  it("rejects with the status when the server refuses", async () => {
    mockFetch.mockResolvedValue(
      respondWith(401, { success: false, message: "Authentication required" }),
    );

    // 401 must reach the caller as a failure, not as data. This is the same
    // contract `getEvents` needed: a signed-out session and an empty profile
    // are different facts.
    await expect(getStudentProfile()).rejects.toMatchObject({ status: 401 });
  });
});

describe("updateStudentProfile", () => {
  it("PATCHes the caller's own profile", async () => {
    mockFetch.mockResolvedValue(respondWith(200, profileBody("20231234")));

    await updateStudentProfile("20231234");

    const call = mockFetch.mock.calls[0];

    expect(urlOf(call)).toMatch(/\/user\/profile$/);
    expect(initOf(call)?.method).toBe("PATCH");
  });

  it("sends the registration number and nothing else", async () => {
    mockFetch.mockResolvedValue(respondWith(200, profileBody("20231234")));

    await updateStudentProfile("20231234");

    const body = bodyOf(mockFetch.mock.calls[0]);

    // THE OWNERSHIP ASSERTION. A `userId` or `id` here would be a claim about
    // whose row to write; the server refuses both, and the client must not make
    // the attempt. Asserted as the exact key set so a future field cannot slip
    // in unnoticed.
    expect(Object.keys(body)).toEqual(["registrationNumber"]);
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("id");
  });

  it("sends null to clear the number", async () => {
    mockFetch.mockResolvedValue(respondWith(200, profileBody(null)));

    await updateStudentProfile(null);

    // Explicitly null, not an omitted field: the server treats an omission as
    // "change nothing", so a clear must say so.
    expect(bodyOf(mockFetch.mock.calls[0])).toEqual({
      registrationNumber: null,
    });
  });

  // NO FORMAT RULE, NO NORMALIZATION. Each of these reaches the server exactly
  // as typed — the client has no opinion about what a registration number looks
  // like, and the server accepts arbitrary strings by design.
  it.each([
    "20231234",
    "2023ABCD",
    "ABC-123",
    "BTECH/2023/42",
    "anything",
    "21BCE1234",
    "  padded  ",
    "MiXeDcAsE",
  ])("passes %o through untouched", async (value) => {
    mockFetch.mockResolvedValue(respondWith(200, profileBody(value)));

    await updateStudentProfile(value);

    // Untouched includes the whitespace: trimming is the server's behaviour and
    // lives there. Doing it here as well would be two implementations of one
    // rule.
    expect(bodyOf(mockFetch.mock.calls[0]).registrationNumber).toBe(value);
  });

  it("rejects with 409 when the number belongs to someone else", async () => {
    mockFetch.mockResolvedValue(
      respondWith(409, {
        success: false,
        message: "That registration number is already in use",
      }),
    );

    // The status is what the UI needs to say something specific and true. The
    // body deliberately identifies no one, and this client adds nothing to it.
    await expect(updateStudentProfile("20231234")).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rejects with the status for ordinary failures", async () => {
    mockFetch.mockResolvedValue(
      respondWith(500, { success: false, message: "Failed" }),
    );

    await expect(updateStudentProfile("20231234")).rejects.toMatchObject({
      status: 500,
    });
  });
});
