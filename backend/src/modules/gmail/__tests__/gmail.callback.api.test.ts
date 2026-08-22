// PR-7B — where the browser lands after signing in.
// PR-7F — and whether this browser is the one that asked to sign in.
//
// `GET /gmail/callback` is not an API call. Google sends the BROWSER there as a
// top-level navigation, so whatever the handler returns is what the user sees —
// that is PR-7B's concern, and the redirect tests below are unchanged in intent.
//
// PR-7F adds the security half. The callback currently reads `code` and nothing
// else, so it cannot distinguish an authorization response that answers THIS
// browser's request from one an attacker obtained for their own Google identity
// and then induced the victim to visit. The consequence is not session
// confusion but a tenant crossing: the victim's browser is bound to the
// attacker's userId, and anything the victim then pastes or confirms is written
// into the attacker's tenant.
//
// The whole flow is exercised — `/gmail/auth` first, then the callback, through
// one supertest agent, so the state and PKCE verifier come from the same place
// a real browser would get them. `generateAuthUrl` is therefore the REAL
// implementation; only the Google round trips are mocked.

process.env.FRONTEND_URL = "https://placement-tracker.example";

// See gmail.auth.api.test.ts — the real store needs a live Redis, and these
// tests need a session that survives two requests.
jest.mock("connect-redis", () => ({
  RedisStore: jest.requireActual("express-session").MemoryStore,
}));

jest.mock("../../../infrastructure/queue/queues", () => ({
  emailQueue: { add: jest.fn() },
}));

jest.mock("../../../lib/prisma", () => ({
  prisma: { event: {}, email: {}, user: {} },
}));

// Only the Google round trips are replaced. `generateAuthUrl` stays real so the
// authorization URL under test is the one the application actually builds.
jest.mock("../gmail.service", () => ({
  ...jest.requireActual("../gmail.service"),
  getTokens: jest.fn(async () => ({
    id_token: "id-token",
    refresh_token: "refresh-token",
  })),
  verifyGoogleIdToken: jest.fn(async () => ({
    googleSub: "sub-1",
    email: "student@college.edu",
    emailVerified: true,
    name: "Student",
    imageUrl: null,
  })),
  getGmailAddress: jest.fn(async () => "student@college.edu"),
}));

jest.mock("../gmail.repository", () => ({
  connectGmailAccount: jest.fn(async () => ({ id: 3 })),
}));

jest.mock("../gmail.sync.service", () => ({
  syncUserMailboxes: jest.fn(),
}));

jest.mock("../../user/user.service", () => {
  class UnverifiedGoogleIdentityError extends Error {}
  class InactiveUserError extends Error {}

  return {
    resolveUserFromGoogleIdentity: jest.fn(async () => ({
      id: 1,
      publicId: "user-1",
      status: "active",
    })),
    UnverifiedGoogleIdentityError,
    InactiveUserError,
  };
});

jest.mock("../../auth/session.service", () => ({
  establishSession: jest.fn(async () => undefined),
  destroySession: jest.fn(async () => undefined),
  isSessionExpired: jest.fn(() => false),
}));

import { createHash } from "node:crypto";
import request from "supertest";

import app from "../../../app";
import { getTokens, verifyGoogleIdToken } from "../gmail.service";
import { connectGmailAccount } from "../gmail.repository";
import { resolveUserFromGoogleIdentity } from "../../user/user.service";
import { establishSession } from "../../auth/session.service";

type Agent = ReturnType<typeof request.agent>;

const newBrowser = (): Agent => request.agent(app);

/* Starts the flow the way a browser does, and returns what Google was sent. */
const startAuth = async (agent: Agent) => {
  const res = await agent.get("/gmail/auth");
  const url = new URL(res.headers.location as string);

  return {
    state: url.searchParams.get("state") ?? "",
    challenge: url.searchParams.get("code_challenge") ?? "",
  };
};

const callback = (agent: Agent, query: string) =>
  agent.get(`/gmail/callback${query}`);

/* Every value the token exchange was handed, flattened one level so the
   assertion does not depend on whether the verifier arrives positionally or in
   an options object. */
const tokenExchangeStrings = (): string[] => {
  const call = (getTokens as jest.Mock).mock.calls[0] ?? [];

  return call.flatMap((arg: unknown) => {
    if (typeof arg === "string") return [arg];
    if (arg !== null && typeof arg === "object") {
      return Object.values(arg as Record<string, unknown>).filter(
        (value): value is string => typeof value === "string",
      );
    }
    return [];
  });
};

const s256 = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/* Nothing downstream of state validation may run. Asserted together because
   "rejected" means no side effects, not merely a 400. */
const expectNoAuthenticationSideEffects = () => {
  expect(getTokens).not.toHaveBeenCalled();
  expect(resolveUserFromGoogleIdentity).not.toHaveBeenCalled();
  expect(connectGmailAccount).not.toHaveBeenCalled();
  expect(establishSession).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * PR-7B regressions, migrated. These previously called the callback with
 * `?code=auth-code` and no state, which the new contract refuses; they now
 * establish the pre-auth session through /gmail/auth exactly as a browser
 * would, so they keep testing what they were written to test.
 * ------------------------------------------------------------------ */

describe("a legitimate callback completes the sign-in", () => {
  test("redirects the browser back to the application", async () => {
    const browser = newBrowser();
    const { state } = await startAuth(browser);

    const res = await callback(browser, `?code=auth-code&state=${state}`);

    expect(res.status).toBe(302);
  });

  test("sends the browser to the configured frontend origin", async () => {
    const browser = newBrowser();
    const { state } = await startAuth(browser);

    const res = await callback(browser, `?code=auth-code&state=${state}`);

    expect(res.headers.location).toBe(process.env.FRONTEND_URL);
  });

  test("establishes the session before responding", async () => {
    const browser = newBrowser();
    const { state } = await startAuth(browser);

    await callback(browser, `?code=auth-code&state=${state}`);

    expect(establishSession).toHaveBeenCalledTimes(1);
  });

  test("still refuses a request with no authorization code", async () => {
    const browser = newBrowser();
    const { state } = await startAuth(browser);

    const res = await callback(browser, `?state=${state}`);

    expect(res.status).toBe(400);
    expect(establishSession).not.toHaveBeenCalled();
  });

  test("still verifies the Google identity and connects the mailbox", async () => {
    const browser = newBrowser();
    const { state } = await startAuth(browser);

    await callback(browser, `?code=auth-code&state=${state}`);

    expect(verifyGoogleIdToken).toHaveBeenCalledTimes(1);
    expect(resolveUserFromGoogleIdentity).toHaveBeenCalledTimes(1);
    expect(connectGmailAccount).toHaveBeenCalledWith(
      "student@college.edu",
      "refresh-token",
      1,
    );
  });
});

/* ------------------------------------------------------------------ *
 * State validation.
 * ------------------------------------------------------------------ */

describe("a callback with no state is refused", () => {
  test("answers 400", async () => {
    const browser = newBrowser();
    await startAuth(browser);

    const res = await callback(browser, "?code=auth-code");

    expect(res.status).toBe(400);
  });

  test("performs no part of the sign-in", async () => {
    const browser = newBrowser();
    await startAuth(browser);

    await callback(browser, "?code=auth-code");

    expectNoAuthenticationSideEffects();
  });
});

describe("a callback with the wrong state is refused", () => {
  test("answers 400", async () => {
    const browser = newBrowser();
    await startAuth(browser);

    const res = await callback(
      browser,
      "?code=auth-code&state=not-the-issued-state",
    );

    expect(res.status).toBe(400);
  });

  test("performs no part of the sign-in", async () => {
    const browser = newBrowser();
    await startAuth(browser);

    await callback(browser, "?code=auth-code&state=not-the-issued-state");

    expectNoAuthenticationSideEffects();
  });
});

/* ------------------------------------------------------------------ *
 * THE LOGIN-CSRF TEST.
 *
 * The attacker completes consent in their own browser, keeps the callback URL
 * unspent, and induces the victim to visit it. Two agents are two cookie jars,
 * which is exactly the distinction the current implementation cannot make: the
 * code is genuine, the identity is genuine, and the only thing wrong is that
 * this is not the browser that asked.
 * ------------------------------------------------------------------ */

describe("an authorization response issued to another browser is refused", () => {
  test("answers 400 for the victim", async () => {
    const attacker = newBrowser();
    const { state: attackerState } = await startAuth(attacker);

    const victim = newBrowser();
    const res = await callback(
      victim,
      `?code=attacker-code&state=${attackerState}`,
    );

    expect(res.status).toBe(400);
  });

  test("establishes no session for the victim", async () => {
    const attacker = newBrowser();
    const { state: attackerState } = await startAuth(attacker);

    const victim = newBrowser();
    await callback(victim, `?code=attacker-code&state=${attackerState}`);

    // The whole vulnerability in one assertion: the victim's browser must not
    // come away holding a session for the attacker's user.
    expect(establishSession).not.toHaveBeenCalled();
  });

  test("performs no part of the sign-in for the victim", async () => {
    const attacker = newBrowser();
    const { state: attackerState } = await startAuth(attacker);

    const victim = newBrowser();
    await callback(victim, `?code=attacker-code&state=${attackerState}`);

    expectNoAuthenticationSideEffects();
  });

  test("a victim who never started a flow is refused too", async () => {
    const attacker = newBrowser();
    const { state: attackerState } = await startAuth(attacker);

    // No /gmail/auth: the victim simply follows a link.
    const res = await request(app).get(
      `/gmail/callback?code=attacker-code&state=${attackerState}`,
    );

    expect(res.status).toBe(400);
    expect(establishSession).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Single use and expiry.
 * ------------------------------------------------------------------ */

describe("a state cannot be used twice", () => {
  test("the second callback is refused", async () => {
    const browser = newBrowser();
    const { state } = await startAuth(browser);

    const first = await callback(browser, `?code=auth-code&state=${state}`);
    expect(first.status).toBe(302);

    const second = await callback(browser, `?code=replayed-code&state=${state}`);

    expect(second.status).toBe(400);
  });

  test("the replay establishes no second session", async () => {
    const browser = newBrowser();
    const { state } = await startAuth(browser);

    await callback(browser, `?code=auth-code&state=${state}`);
    (establishSession as jest.Mock).mockClear();

    await callback(browser, `?code=replayed-code&state=${state}`);

    expect(establishSession).not.toHaveBeenCalled();
  });
});

describe("a state expires", () => {
  test("a callback after the state's lifetime is refused", async () => {
    const browser = newBrowser();
    const { state } = await startAuth(browser);

    // Eleven minutes on, past RFC-001 §10.1's ten-minute ceiling. Only
    // `Date.now` is moved, so the session cookie itself (a 7-day idle TTL) is
    // unaffected and the failure can only come from the state's own expiry.
    const elevenMinutes = 11 * 60 * 1000;
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + elevenMinutes);

    const res = await callback(browser, `?code=auth-code&state=${state}`);

    expect(res.status).toBe(400);
    expect(establishSession).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * One answer for every state failure.
 * ------------------------------------------------------------------ */

describe("state failures are indistinguishable from outside", () => {
  test("missing, wrong and replayed states answer identically", async () => {
    const missingBrowser = newBrowser();
    await startAuth(missingBrowser);
    const missing = await callback(missingBrowser, "?code=auth-code");

    const wrongBrowser = newBrowser();
    await startAuth(wrongBrowser);
    const wrong = await callback(wrongBrowser, "?code=auth-code&state=wrong");

    const replayBrowser = newBrowser();
    const { state } = await startAuth(replayBrowser);
    await callback(replayBrowser, `?code=auth-code&state=${state}`);
    const replayed = await callback(replayBrowser, `?code=x&state=${state}`);

    // Telling an attacker which half of their guess was right is a free hint.
    expect(wrong.body).toEqual(missing.body);
    expect(replayed.body).toEqual(missing.body);
  });
});

/* ------------------------------------------------------------------ *
 * PKCE: the code must be redeemed with the verifier this browser generated.
 * ------------------------------------------------------------------ */

describe("the authorization code is redeemed with the browser's own verifier", () => {
  test("the token exchange receives a verifier", async () => {
    const browser = newBrowser();
    const { state } = await startAuth(browser);

    await callback(browser, `?code=auth-code&state=${state}`);

    // More than the code: without the verifier Google cannot bind the exchange
    // to the client that requested the code.
    expect(tokenExchangeStrings().length).toBeGreaterThan(1);
  });

  test("the verifier matches the challenge that was sent to Google", async () => {
    const browser = newBrowser();
    const { state, challenge } = await startAuth(browser);

    await callback(browser, `?code=auth-code&state=${state}`);

    // The cryptographic binding, asserted rather than assumed: one of the
    // values handed to the exchange must hash under S256 to the challenge this
    // browser published. A verifier from another session, a re-generated one,
    // or a placeholder all fail here.
    const verifiers = tokenExchangeStrings().filter(
      (value) => s256(value) === challenge,
    );

    expect(verifiers).toHaveLength(1);
  });

  test("a refused exchange establishes no session", async () => {
    const browser = newBrowser();
    const { state } = await startAuth(browser);

    // What Google answers when the verifier does not match the challenge.
    (getTokens as jest.Mock).mockRejectedValueOnce(
      new Error("invalid_grant: code_verifier does not match"),
    );

    const res = await callback(browser, `?code=auth-code&state=${state}`);

    expect(res.headers.location).not.toBe(process.env.FRONTEND_URL);
    expect(establishSession).not.toHaveBeenCalled();
  });
});
