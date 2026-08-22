// PR-7F RED — the authorization request must bind the flow to this browser.
//
// `gmailAuthController` is three lines today: build a Google URL, redirect.
// Nothing random is generated, nothing is stored, and the session is never
// touched — so the callback that eventually arrives has no way to tell whether
// it answers a request THIS browser made. That is the login-CSRF hole
// `gmail.controller.ts:36` names, and it is now reachable from the deployed
// sign-in link.
//
// Two values close it, and both belong to the pre-authentication session:
//
//   state          proves the authorization response answers this browser's
//                  request (RFC-001 §10.1)
//   PKCE verifier  proves the code is redeemed by the client that requested it,
//                  with `code_challenge_method=S256`
//
// These tests read the ACTUAL authorization URL the route redirects to, not a
// mock of the builder: what protects the user is what Google receives, and a
// test that asserts "generateAuthUrl was called with an object" would pass
// against a builder that silently dropped the parameter.
//
// `gmail.service` is deliberately NOT mocked here for that reason.

// The session store, replaced with express-session's in-memory store. These
// tests need a session that actually persists across two requests, and the real
// store needs a live Redis (`disableOfflineQueue: true` fails commands fast
// while disconnected). Everything else about session handling — regenerate,
// save, the cookie — is the real middleware.
jest.mock("connect-redis", () => ({
  RedisStore: jest.requireActual("express-session").MemoryStore,
}));

// Keeps `import app` from constructing the real BullMQ queue and its ioredis
// connection.
jest.mock("../../../infrastructure/queue/queues", () => ({
  emailQueue: { add: jest.fn() },
}));

jest.mock("../../../lib/prisma", () => ({
  prisma: { event: {}, email: {}, user: {} },
}));

import request from "supertest";
import app from "../../../app";

/* The parameters Google actually receives. */
const authorizationUrl = async (
  agent: ReturnType<typeof request.agent> = request.agent(app),
) => {
  const res = await agent.get("/gmail/auth");
  const url = new URL(res.headers.location as string);

  return {
    res,
    params: url.searchParams,
    state: url.searchParams.get("state"),
    challenge: url.searchParams.get("code_challenge"),
    method: url.searchParams.get("code_challenge_method"),
  };
};

describe("GET /gmail/auth carries a state parameter", () => {
  test("redirects to Google", async () => {
    const { res } = await authorizationUrl();

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("accounts.google.com");
  });

  test("includes a non-empty state", async () => {
    const { state } = await authorizationUrl();

    expect(state).toBeTruthy();
  });

  test("the state is long enough to be unguessable", async () => {
    const { state } = await authorizationUrl();

    // RFC-001 §10.1 requires ≥128 bits from a CSPRNG. 22 characters is the
    // base64url length of 16 bytes, so this is the floor rather than the
    // recommendation (32 bytes / 256 bits). Encoding is left to the
    // implementation; what is pinned is that guessing is not feasible.
    expect((state ?? "").length).toBeGreaterThanOrEqual(22);
  });

  test("the state is not a fixed value", async () => {
    const first = await authorizationUrl();
    const second = await authorizationUrl();

    expect(first.state).not.toBe(second.state);
  });
});

describe("the state belongs to the browser that asked for it", () => {
  test("two independent browsers receive different states", async () => {
    // Separate agents are separate cookie jars — the attacker/victim
    // distinction, expressed in the only way that matters here.
    const attacker = await authorizationUrl(request.agent(app));
    const victim = await authorizationUrl(request.agent(app));

    expect(attacker.state).not.toBe(victim.state);
  });

  test("the pre-authentication session is persisted before the redirect", async () => {
    const { res } = await authorizationUrl();

    // `saveUninitialized: false` means an anonymous session is NOT written
    // unless the handler saves it explicitly. No Set-Cookie here means the
    // state was put on `req.session` and then thrown away when the browser
    // left for Google — the flow would fail closed on every login, and this is
    // the single most likely way to get the implementation wrong.
    const cookies = res.headers["set-cookie"];

    expect(cookies).toBeDefined();
    expect(String(cookies)).toMatch(/placement\.sid/);
  });
});

describe("GET /gmail/auth carries a PKCE challenge", () => {
  test("includes a code_challenge", async () => {
    const { challenge } = await authorizationUrl();

    expect(challenge).toBeTruthy();
  });

  test("uses S256, never plain", async () => {
    const { method } = await authorizationUrl();

    // `plain` sends the verifier itself, which defends nothing against an
    // attacker who can read the authorization request.
    expect(method).toBe("S256");
  });

  test("the challenge is not a fixed value", async () => {
    const first = await authorizationUrl();
    const second = await authorizationUrl();

    expect(first.challenge).not.toBe(second.challenge);
  });

  test("the challenge is distinct from the state", async () => {
    const { state, challenge } = await authorizationUrl();

    // Two independent secrets serving two different purposes; deriving one
    // from the other would collapse them into one.
    expect(challenge).not.toBe(state);
  });
});
