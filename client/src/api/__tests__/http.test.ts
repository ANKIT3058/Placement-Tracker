/* PR-7D RED — requestJson keeps the server's explanation.
 *
 * PR-7B established the status contract and deliberately stopped there:
 * `requestJson` throws `ApiError(res.status)` without ever reading the body.
 * Every client-facing error the backend sends carries a server-authored
 * `message` — "Missing required fields", "Authentication required", and PR-3's
 * "Unsupported field(s): …. Only company, stage can be edited." — and all of it
 * is discarded at that line.
 *
 * The allowlist message is the one that matters. It names exactly which fields
 * were refused and which are permitted; nothing downstream can reconstruct it
 * from the number 400. Losing it turns a precise, actionable answer into a
 * shrug.
 *
 * `ApiError` already takes an optional message — the field is wired, only the
 * call site is not — so this is about what `requestJson` chooses to read, not
 * about widening the error type.
 *
 * The other half of the contract is that reading the body must never be able to
 * REPLACE the failure. An error response may be empty, plain text, or malformed
 * JSON; in each case the HTTP failure is still the truth, and a SyntaxError
 * surfacing where a 500 belongs would be strictly worse than today's behaviour.
 * Tests C and D exist to pin that.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { requestJson, ApiError } from "../http";

const URL = "/api/event";

/* A minimal stand-in for a fetch Response — only the members the client
   touches. `json` is a factory so a test can make parsing fail. */
const respond = (status: number, json: () => Promise<unknown>) => ({
  ok: status >= 200 && status < 300,
  status,
  json,
});

const withBody = (status: number, body: unknown) =>
  respond(status, async () => body);

/* What `res.json()` does for an empty or non-JSON body: it rejects. */
const withUnreadableBody = (status: number) =>
  respond(status, async () => {
    throw new SyntaxError("Unexpected end of JSON input");
  });

const mockFetch = vi.fn();

/* Captures the rejection so its properties can be inspected. `rejects.toThrow`
   alone cannot tell an ApiError from a SyntaxError that escaped. */
const failureOf = async (): Promise<unknown> => {
  try {
    await requestJson(URL);
    throw new Error("expected requestJson to reject");
  } catch (error) {
    return error;
  }
};

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ *
 * A. The server's own message survives.
 * ------------------------------------------------------------------ */

describe("a JSON error body carrying a message", () => {
  const SERVER_MESSAGE =
    "Unsupported field(s): confidence, status. Only company, stage can be edited.";

  beforeEach(() => {
    mockFetch.mockResolvedValue(withBody(400, { message: SERVER_MESSAGE }));
  });

  it("still rejects with an ApiError", async () => {
    expect(await failureOf()).toBeInstanceOf(ApiError);
  });

  it("keeps the status", async () => {
    expect(await failureOf()).toMatchObject({ status: 400 });
  });

  it("keeps the server's message verbatim", async () => {
    // Not paraphrased and not prefixed: this string is the whole value of
    // reading the body at all.
    expect(await failureOf()).toMatchObject({ message: SERVER_MESSAGE });
  });
});

/* ------------------------------------------------------------------ *
 * B. Only `message` is trusted — no scavenging other fields.
 * ------------------------------------------------------------------ */

describe("a JSON error body with no message", () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue(withBody(500, { error: "something" }));
  });

  it("keeps the status", async () => {
    expect(await failureOf()).toMatchObject({ status: 500 });
  });

  it("falls back to the default message", async () => {
    // Compared against the class's own default rather than a literal, so the
    // assertion survives a rewording of that default.
    const failure = await failureOf();

    expect((failure as Error).message).toBe(new ApiError(500).message);
  });

  it("does not surface unrecognised fields", async () => {
    // `message` is the field every backend error in this app actually carries.
    // Reaching for whatever else happens to be present would make the contract
    // "display any string the server sent", which is a different and much
    // larger promise.
    expect((await failureOf() as Error).message).not.toContain("something");
  });
});

/* ------------------------------------------------------------------ *
 * C + D. Reading the body must never replace the failure.
 * ------------------------------------------------------------------ */

describe("an error body that cannot be parsed", () => {
  it("still rejects with an ApiError when the body is empty", async () => {
    mockFetch.mockResolvedValue(withUnreadableBody(500));

    const failure = await failureOf();

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 500 });
  });

  it("does not let a SyntaxError escape in place of the HTTP error", async () => {
    mockFetch.mockResolvedValue(withUnreadableBody(500));

    // The request failed with 500. That fact must survive a failed attempt to
    // read why.
    expect(await failureOf()).not.toBeInstanceOf(SyntaxError);
  });

  it("still rejects with an ApiError for a non-JSON body", async () => {
    mockFetch.mockResolvedValue(withUnreadableBody(502));

    expect(await failureOf()).toMatchObject({ status: 502 });
  });
});

/* ------------------------------------------------------------------ *
 * E. A network failure is not an HTTP failure.
 * ------------------------------------------------------------------ */

describe("a network failure", () => {
  beforeEach(() => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
  });

  it("propagates the original error", async () => {
    expect(await failureOf()).toBeInstanceOf(TypeError);
  });

  it("is not turned into an ApiError", async () => {
    expect(await failureOf()).not.toBeInstanceOf(ApiError);
  });

  it("invents no HTTP status", async () => {
    // There was no response. Attaching a status would be a fact the client made
    // up, and callers branch on exactly that field.
    expect(await failureOf()).not.toHaveProperty("status");
  });
});

/* ------------------------------------------------------------------ *
 * F. Success is untouched.
 * ------------------------------------------------------------------ */

describe("successful responses are unchanged", () => {
  it("resolves a 200 body", async () => {
    const events = [{ id: 1, company: "amazon" }];
    mockFetch.mockResolvedValue(withBody(200, events));

    await expect(requestJson(URL)).resolves.toEqual(events);
  });

  it("resolves a 202 body", async () => {
    const accepted = { success: true, message: "Email queued for processing" };
    mockFetch.mockResolvedValue(withBody(202, accepted));

    await expect(requestJson(URL)).resolves.toEqual(accepted);
  });

  it("resolves an empty list without treating it as a failure", async () => {
    mockFetch.mockResolvedValue(withBody(200, []));

    await expect(requestJson(URL)).resolves.toEqual([]);
  });
});
