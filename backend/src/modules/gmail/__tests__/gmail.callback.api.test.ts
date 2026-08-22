// PR-7B RED — where the browser lands after signing in.
//
// `GET /gmail/callback` is not an API call. Google sends the BROWSER there as a
// top-level navigation, so whatever the handler returns is what the user sees.
// It currently answers `res.json({ success: true, email })`, which leaves a
// person who has just signed in looking at a page of raw JSON on the API
// origin, with no link back to the application. The session is established
// correctly — the failure is purely in where the browser is left.
//
// The destination is not invented here: `FRONTEND_URL` already exists in the
// configuration (`.env.example:57`, and the CORS origin in app.ts reads it), so
// the repository has already named where the frontend lives.
//
// Everything the handler depends on is mocked at its module boundary — the same
// approach `email.api.test.ts` uses — so this asserts the response contract and
// nothing about how the OAuth exchange is implemented. The success path's other
// guarantees (session established before responding, ownership refusals
// answering 403) are asserted alongside it so a redirect cannot be added by
// dropping them.

process.env.FRONTEND_URL = "https://placement-tracker.example";

// Keeps `import app` from constructing the real BullMQ queue and its ioredis
// connection.
jest.mock("../../../infrastructure/queue/queues", () => ({
  emailQueue: { add: jest.fn() },
}));

jest.mock("../../../lib/prisma", () => ({
  prisma: { event: {}, email: {}, user: {} },
}));

// The OAuth exchange itself. Mocked wholesale: this suite is about the response
// the browser receives, not about token handling.
jest.mock("../gmail.service", () => ({
  generateAuthUrl: jest.fn(() => "https://accounts.google.com/o/oauth2/auth"),
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

import request from "supertest";
import app from "../../../app";
import { establishSession } from "../../auth/session.service";

describe("GET /gmail/callback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("redirects the browser back to the application", async () => {
    const res = await request(app).get("/gmail/callback?code=auth-code");

    // A person, not a client, is at the other end of this response.
    expect(res.status).toBe(302);
  });

  test("sends the browser to the configured frontend origin", async () => {
    const res = await request(app).get("/gmail/callback?code=auth-code");

    expect(res.headers.location).toBe(process.env.FRONTEND_URL);
  });

  test("establishes the session before responding", async () => {
    await request(app).get("/gmail/callback?code=auth-code");

    // The redirect must not arrive ahead of the cookie that makes it useful.
    expect(establishSession).toHaveBeenCalledTimes(1);
  });

  test("still refuses a request with no authorization code", async () => {
    const res = await request(app).get("/gmail/callback");

    expect(res.status).toBe(400);
    expect(establishSession).not.toHaveBeenCalled();
  });
});
