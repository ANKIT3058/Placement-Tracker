// PR-7E — logout, tested against the real session machinery.
//
// The backend already implements logout correctly, and nothing tested it: the
// auth module had no test directory at all. That gap matters more than it
// sounds, because logout's whole value is a server-side guarantee. A client
// that merely forgot its cookie would look identical in the UI while the
// session stayed live in Redis for up to seven days — so the property worth
// pinning is not "the endpoint answers 200", it is "the session that cookie
// names is gone".
//
// These run the genuine flow end to end: sign in through the OAuth callback
// (with state and PKCE, as of PR-7F), read a protected route, log out, and read
// the protected route again with the same cookie jar. `establishSession`,
// `destroySession`, `requireAuth` and the session middleware are all real. Only
// the Google round trips, Redis, and Prisma are replaced.
//
// They are expected to PASS: they are regression guards for behaviour that is
// already right, added because a security property with no test is one edit
// away from being wrong.

// express-session's in-memory store, so a session survives across requests
// without a live Redis.
jest.mock("connect-redis", () => ({
  RedisStore: jest.requireActual("express-session").MemoryStore,
}));

// The per-user session index (`user_sessions:{id}`) is plain Redis Set work.
// Stubbed at the client so `establishSession`/`destroySession` themselves stay
// real — the index is not what these tests are about.
jest.mock("../../../infrastructure/redis/session-redis", () => {
  const chain = {
    sAdd: () => chain,
    pExpire: () => chain,
    exec: async () => [],
  };

  return {
    sessionRedis: {
      multi: () => chain,
      sRem: async () => 1,
    },
  };
});

jest.mock("../../../infrastructure/queue/queues", () => ({
  emailQueue: { add: jest.fn() },
}));

const ACTIVE_USER = {
  id: 1,
  publicId: "user-1",
  googleSub: "sub-1",
  email: "student@college.edu",
  name: "Student",
  imageUrl: null,
  status: "active",
  deletedAt: null,
};

jest.mock("../../../lib/prisma", () => ({
  prisma: {
    user: { findUnique: jest.fn(async () => ACTIVE_USER) },
    event: { findMany: jest.fn(async () => []) },
    gmailAccount: { delete: jest.fn(), deleteMany: jest.fn(), update: jest.fn() },
  },
}));

// The Google round trips only. `generateAuthUrl` stays real so the flow carries
// a genuine state and PKCE challenge.
jest.mock("../../gmail/gmail.service", () => ({
  ...jest.requireActual("../../gmail/gmail.service"),
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

jest.mock("../../gmail/gmail.repository", () => ({
  connectGmailAccount: jest.fn(async () => ({ id: 3 })),
}));

jest.mock("../../gmail/gmail.sync.service", () => ({
  syncUserMailboxes: jest.fn(),
}));

jest.mock("../../user/user.service", () => {
  class UnverifiedGoogleIdentityError extends Error {}
  class InactiveUserError extends Error {}

  return {
    resolveUserFromGoogleIdentity: jest.fn(async () => ACTIVE_USER),
    UnverifiedGoogleIdentityError,
    InactiveUserError,
  };
});

import request from "supertest";

import app from "../../../app";
import { prisma } from "../../../lib/prisma";
import { csrfTokenOf, CSRF_HEADER } from "../../../__tests__/helpers/csrf";

type Agent = ReturnType<typeof request.agent>;

/* Signs a browser in the way a browser does: start the flow, then complete the
   callback with the state it was issued. */
const signIn = async (): Promise<Agent> => {
  const agent = request.agent(app);

  const start = await agent.get("/gmail/auth");
  const state = new URL(start.headers.location as string).searchParams.get(
    "state",
  );

  const callback = await agent.get(
    `/gmail/callback?code=auth-code&state=${state}`,
  );

  expect(callback.status).toBe(302);

  return agent;
};

/* PR-8B. `POST /auth/logout` is behind `requireCsrf` — the one route where the
   check stands alone, since logout deliberately has no `requireAuth`. A forced
   logout is a real cross-site attack: a page that can end a session denies the
   victim the application.

   So every logout below is sent the way the frontend sends it, with the token
   the browser was issued echoed back. Nothing here weakens the check; a request
   without the token is refused, and that refusal is asserted in
   `csrf.api.test.ts`. */
const logout = async (agent: Agent) => {
  // Read the token BEFORE building the request. Superagent attaches an agent
  // jar cookies when the request object is created, not when it is sent, so
  // inlining the await as an argument would build the POST while the jar was
  // still empty and send it with no cookie at all.
  const token = await csrfTokenOf(agent);

  return agent.post("/auth/logout").set(CSRF_HEADER, token);
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /auth/logout ends the session on the server", () => {
  test("an authenticated caller can reach a protected route beforehand", async () => {
    const browser = await signIn();

    const res = await browser.get("/event");

    // The control: without this, a 401 after logout proves nothing.
    expect(res.status).toBe(200);
  });

  test("logout answers 200", async () => {
    const browser = await signIn();

    const res = await logout(browser);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  test("the same cookie no longer authenticates afterwards", async () => {
    const browser = await signIn();

    await browser.get("/event");
    await logout(browser);

    const after = await browser.get("/event");

    // THE security property. A client-side cookie clear would leave the Redis
    // session live and this would still answer 200.
    expect(after.status).toBe(401);
  });

  test("clears the session cookie with attributes that match how it was set", async () => {
    const browser = await signIn();

    const res = await logout(browser);

    // A browser ignores a clear whose attributes differ from the original
    // (RFC-001 §10.3), so the cookie would silently survive.
    const cleared = String(res.headers["set-cookie"] ?? "");

    expect(cleared).toMatch(/placement\.sid=/);
    expect(cleared).toMatch(/Path=\//);
  });
});

describe("logout is idempotent", () => {
  test("a caller with no session is told they are logged out", async () => {
    // The route is deliberately not behind `requireAuth`: "you are now logged
    // out" is true either way, and answering 401 would report whether the
    // presented cookie was valid.
    // A browser with no session, but with the CSRF token any browser is
    // issued on an ordinary read — which is exactly what a signed-out visitor
    // holds when they click "log out".
    const res = await logout(request.agent(app));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  test("logging out twice is safe", async () => {
    const browser = await signIn();

    const first = await logout(browser);
    const second = await logout(browser);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});

describe("logout ends the application session and nothing else", () => {
  test("the Gmail connection is left intact", async () => {
    const browser = await signIn();

    await logout(browser);

    // Mailbox connections survive logout by design (RFC-001 §10.3): grant
    // revocation belongs to disconnection and account deletion, so a user who
    // signs back in reuses the connection rather than re-consenting.
    expect(prisma.gmailAccount.delete).not.toHaveBeenCalled();
    expect(prisma.gmailAccount.deleteMany).not.toHaveBeenCalled();
    expect(prisma.gmailAccount.update).not.toHaveBeenCalled();
  });

  test("signing in again works after logging out", async () => {
    const first = await signIn();
    await logout(first);

    const second = await signIn();
    const res = await second.get("/event");

    expect(res.status).toBe(200);
  });
});
