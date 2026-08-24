// PR-8B RED — double-submit CSRF token (RFC-001 §11.4 item 2).
//
// `SameSite=Lax` currently blocks every cross-site attack the PR-8A
// investigation could construct, and it is the ONLY thing doing so. That is the
// gap: the whole defence lives in the browser rather than in this application,
// and one change — `SameSite=None` to "fix" a cross-origin problem — would
// remove it everywhere at once with no test failing.
//
// Double-submit adds a control this codebase owns. The server issues a random
// token in a readable cookie; the frontend echoes it in a header; the server
// compares. A cross-origin attacker can cause a request but cannot read the
// cookie to echo it, and cannot set the header without a preflight CORS will
// refuse.
//
// Chosen over Origin validation first because it is deployment-independent:
// PR-8A's precheck could not establish that `Origin` survives the Vercel →
// Render rewrite, and a control that fails closed on an unverified assumption
// would break every state-changing route on deploy. Cookies and headers
// demonstrably survive that hop — the session cookie already does.
//
// NAMING. RFC-001 §11.4 specifies the mechanism but not a cookie name, and
// double-submit requires both ends to agree on one, so it is pinned here:
// `placement.csrf`, the sibling of `placement.sid`.

// express-session's in-memory store — these tests need sessions that survive
// across requests without a live Redis.
jest.mock("connect-redis", () => ({
  RedisStore: jest.requireActual("express-session").MemoryStore,
}));

// The per-user session index is plain Redis Set work; stubbed at the client so
// establishSession/destroySession themselves stay real.
jest.mock("../../../infrastructure/redis/session-redis", () => {
  const chain = { sAdd: () => chain, pExpire: () => chain, exec: async () => [] };
  return { sessionRedis: { multi: () => chain, sRem: async () => 1 } };
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
    // `GET /health` runs this; without it the read used to obtain a token 500s.
    $queryRaw: jest.fn(async () => [{ "?column?": 1 }]),
    user: { findUnique: jest.fn(async () => ACTIVE_USER) },
    event: {
      findMany: jest.fn(async () => []),
      // Two callers, two answers — and since the race-safe fix they reach the
      // client through two different methods.
      //
      // `createEvent` dedupes through the composite `(userId, eventKey)` unique
      // index, so it calls `findUnique` with a `userId_eventKey` selector. It
      // must MISS: a hit makes it return the existing Event early, `create`
      // never runs, and the POST /event tests would pass for the wrong reason.
      //
      // The manual-update path looks a row up by id with `findFirst` and must
      // FIND one, or PATCH answers 404. Its `where` carries no `eventKey`, so
      // the discriminator below already returns the row for it.
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async ({ where }: any) =>
        where?.eventKey ? null : { id: 10, userId: 1 },
      ),
      create: jest.fn(async () => ({ id: 10 })),
      update: jest.fn(async () => ({ id: 10 })),
    },
    email: { create: jest.fn(async () => ({ id: 5, userId: 1 })) },
  },
}));

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
  syncUserMailboxes: jest.fn(async () => ({ synced: 0 })),
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
import { syncUserMailboxes } from "../../gmail/gmail.sync.service";

type Agent = ReturnType<typeof request.agent>;

const CSRF_COOKIE = "placement.csrf";
const CSRF_HEADER = "x-csrf-token";

const cookiesOf = (res: request.Response): string[] =>
  ([] as string[]).concat((res.headers["set-cookie"] as unknown as string[]) ?? []);

const cookieNamed = (res: request.Response, name: string): string | undefined =>
  cookiesOf(res).find((cookie) => cookie.startsWith(`${name}=`));

const valueOf = (cookie: string | undefined): string =>
  cookie ? decodeURIComponent(cookie.split("=")[1]!.split(";")[0]!) : "";

/* A browser that has loaded the app: it has made an ordinary read and therefore
   holds whatever cookies that response set. This is the shape every legitimate
   request has, and the shape the existing API suites will need to adopt. */
const browserWithToken = async (): Promise<{ agent: Agent; token: string }> => {
  const agent = request.agent(app);
  const res = await agent.get("/health");

  return { agent, token: valueOf(cookieNamed(res, CSRF_COOKIE)) };
};

/* Signs in through the real OAuth flow (state + PKCE, per PR-7F). */
const signedIn = async (): Promise<{ agent: Agent; token: string }> => {
  const { agent } = await browserWithToken();

  const start = await agent.get("/gmail/auth");
  const state = new URL(start.headers.location as string).searchParams.get("state");
  await agent.get(`/gmail/callback?code=auth-code&state=${state}`);

  // Re-read: `establishSession` regenerates the session id, so take the token
  // as it stands afterwards.
  const res = await agent.get("/event");

  return {
    agent,
    token: valueOf(cookieNamed(res, CSRF_COOKIE)) || (await tokenFromJar(agent)),
  };
};

/* The token as the browser currently holds it, when a response did not re-send
   it (a cookie is only re-sent when it changes). */
const tokenFromJar = async (agent: Agent): Promise<string> => {
  const res = await agent.get("/health");
  return valueOf(cookieNamed(res, CSRF_COOKIE));
};

/* Every route the token must guard, with the side effect that must not happen
   when a request is refused. */
const PROTECTED_ROUTES = [
  {
    name: "POST /event",
    send: (agent: Agent) =>
      agent.post("/event").send({ company: "amazon", stage: "OA", date: "2026-09-01" }),
    expectNoEffect: async () => {
      expect(prisma.event.create).not.toHaveBeenCalled();
    },
  },
  {
    name: "PATCH /event/:id",
    send: (agent: Agent) => agent.patch("/event/10").send({ company: "Amazon India" }),
    expectNoEffect: async () => {
      expect(prisma.event.update).not.toHaveBeenCalled();
    },
  },
  {
    name: "POST /email",
    send: (agent: Agent) =>
      agent.post("/email").send({
        subject: "Amazon OA",
        body: "Amazon OA on 20th Aug",
        sender: "tpo@college.edu",
      }),
    expectNoEffect: async () => {
      expect(prisma.email.create).not.toHaveBeenCalled();
    },
  },
  {
    name: "POST /gmail/sync",
    send: (agent: Agent) => agent.post("/gmail/sync").send({}),
    expectNoEffect: async () => {
      expect(syncUserMailboxes).not.toHaveBeenCalled();
    },
  },
  {
    name: "POST /auth/logout",
    send: (agent: Agent) => agent.post("/auth/logout").send({}),
    expectNoEffect: async (agent: Agent) => {
      // The session must survive a refused logout.
      expect((await agent.get("/event")).status).toBe(200);
    },
  },
];

beforeEach(() => {
  jest.clearAllMocks();
});

/* ------------------------------------------------------------------ *
 * Issuance. The token must reach a browser that has done nothing but load
 * the app — no login, no new endpoint.
 * ------------------------------------------------------------------ */

describe("the CSRF token is issued to any browser", () => {
  test("an ordinary read sets the token cookie", async () => {
    const res = await request(app).get("/health");

    expect(cookieNamed(res, CSRF_COOKIE)).toBeDefined();
  });

  test("no authentication is required to obtain it", async () => {
    // A signed-out visitor must be able to obtain a token, or the sign-in and
    // logout flows could never send one.
    const res = await request(app).get("/health");

    expect(valueOf(cookieNamed(res, CSRF_COOKIE))).not.toBe("");
  });

  test("the token is long enough to be unguessable", async () => {
    const { token } = await browserWithToken();

    // ≥128 bits. 22 characters is the base64url length of 16 bytes; encoding is
    // left to the implementation.
    expect(token.length).toBeGreaterThanOrEqual(22);
  });

  test("two browsers receive different tokens", async () => {
    const first = await browserWithToken();
    const second = await browserWithToken();

    expect(first.token).not.toBe(second.token);
  });

  test("the token is not derived from the session id", async () => {
    // Signed in first, deliberately. `saveUninitialized: false` means an
    // anonymous visitor is never issued a `placement.sid` at all, so reading
    // one from a bare `GET /health` yields an empty string and every
    // comparison against it is vacuous. The independence being asserted only
    // has content when a real session id exists to be independent OF.
    const { agent } = await signedIn();

    const res = await agent.get("/health");

    const csrf = valueOf(cookieNamed(res, CSRF_COOKIE));
    const session = valueOf(cookieNamed(res, "placement.sid"));

    // Both cookies must actually be present, or the inequality below would
    // pass on two absent values.
    expect(session).not.toBe("");
    expect(csrf).not.toBe("");

    // The whole point: the CSRF token is generated independently and carries
    // no part of the session identifier.
    expect(csrf).not.toBe(session);
  });

  test("the token is stable across requests", async () => {
    const { agent, token } = await browserWithToken();

    await agent.get("/event");
    const again = await tokenFromJar(agent);

    // Rotating per request would race the frontend: a token read before one
    // request would already be stale for the next.
    expect(again).toBe(token);
  });
});

/* ------------------------------------------------------------------ *
 * Cookie attributes. The whole mechanism depends on the frontend being able
 * to read this cookie — and on the session cookie remaining unreadable.
 * ------------------------------------------------------------------ */

describe("the CSRF cookie is readable and the session cookie is not", () => {
  test("the CSRF cookie is not HttpOnly", async () => {
    const cookie = cookieNamed(await request(app).get("/health"), CSRF_COOKIE);

    // Asserted to exist first so the absence of the cookie reads as a missing
    // cookie rather than as a matcher type error.
    expect(cookie).toBeDefined();
    // If it were HttpOnly, `requestJson` could not read it and the scheme
    // cannot work at all.
    expect(cookie).not.toMatch(/HttpOnly/i);
  });

  test("the CSRF cookie is scoped to the whole site", async () => {
    const cookie = cookieNamed(await request(app).get("/health"), CSRF_COOKIE);

    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/Path=\//i);
  });

  test("the CSRF cookie declares SameSite", async () => {
    const cookie = cookieNamed(await request(app).get("/health"), CSRF_COOKIE);

    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/SameSite=/i);
  });

  test("the session cookie is still HttpOnly", async () => {
    const { agent } = await browserWithToken();

    const start = await agent.get("/gmail/auth");

    // Regression: PR-8B must not touch how the session cookie is set.
    expect(cookieNamed(start, "placement.sid")).toMatch(/HttpOnly/i);
  });
});

/* ------------------------------------------------------------------ *
 * A legitimate request still works, end to end, on every protected route.
 * ------------------------------------------------------------------ */

describe("a request carrying the matching token is allowed through", () => {
  test("POST /event creates the Event", async () => {
    const { agent, token } = await signedIn();

    await agent
      .post("/event")
      .set(CSRF_HEADER, token)
      .send({ company: "amazon", stage: "OA", date: "2026-09-01" });

    expect(prisma.event.create).toHaveBeenCalled();
  });

  test("PATCH /event/:id updates the Event", async () => {
    const { agent, token } = await signedIn();

    await agent
      .patch("/event/10")
      .set(CSRF_HEADER, token)
      .send({ company: "Amazon India" });

    expect(prisma.event.update).toHaveBeenCalled();
  });

  test("POST /email ingests the email", async () => {
    const { agent, token } = await signedIn();

    await agent.post("/email").set(CSRF_HEADER, token).send({
      subject: "Amazon OA",
      body: "Amazon OA on 20th Aug",
      sender: "tpo@college.edu",
    });

    expect(prisma.email.create).toHaveBeenCalled();
  });

  test("POST /gmail/sync runs the sync", async () => {
    const { agent, token } = await signedIn();

    await agent.post("/gmail/sync").set(CSRF_HEADER, token).send({});

    expect(syncUserMailboxes).toHaveBeenCalled();
  });

  test("POST /auth/logout ends the session", async () => {
    const { agent, token } = await signedIn();

    await agent.post("/auth/logout").set(CSRF_HEADER, token).send({});

    expect((await agent.get("/event")).status).toBe(401);
  });
});

/* ------------------------------------------------------------------ *
 * Refusals. Status alone is not the assertion — nothing may happen.
 * ------------------------------------------------------------------ */

describe("a request with no token header is refused", () => {
  test.each(PROTECTED_ROUTES)("$name answers 403", async ({ send }) => {
    const { agent } = await signedIn();

    const res = await send(agent);

    expect(res.status).toBe(403);
  });

  test.each(PROTECTED_ROUTES)(
    "$name changes nothing",
    async ({ send, expectNoEffect }) => {
      const { agent } = await signedIn();

      await send(agent);

      await expectNoEffect(agent);
    },
  );
});

describe("a request whose token does not match the cookie is refused", () => {
  test.each(PROTECTED_ROUTES)("$name answers 403", async ({ send }) => {
    const { agent } = await signedIn();

    const res = await send(agent).set(CSRF_HEADER, "a-different-token");

    expect(res.status).toBe(403);
  });

  test.each(PROTECTED_ROUTES)(
    "$name changes nothing",
    async ({ send, expectNoEffect }) => {
      const { agent } = await signedIn();

      await send(agent).set(CSRF_HEADER, "a-different-token");

      await expectNoEffect(agent);
    },
  );
});

describe("an empty token is not a token", () => {
  test.each(PROTECTED_ROUTES)("$name answers 403", async ({ send }) => {
    const { agent } = await signedIn();

    const res = await send(agent).set(CSRF_HEADER, "");

    expect(res.status).toBe(403);
  });
});

describe("a caller with no CSRF cookie is refused", () => {
  test("a header alone does not satisfy the check", async () => {
    // A cross-origin attacker can guess a header value but cannot read the
    // victim's cookie, so the two can never agree.
    const { agent, token } = await signedIn();

    // Built as a bare request rather than on the agent, deliberately.
    // `.set("Cookie", ...)` does not REPLACE an agent's jar — superagent
    // re-attaches the stored cookies on the way out — so a request made
    // through `agent` would carry `placement.csrf` whatever this header said,
    // and would be answered 201 for the wrong reason. A genuine session with
    // no CSRF cookie is precisely the attacker position this test is about,
    // and only a hand-built Cookie header expresses it.
    const sessionCookie = cookiesOf(await agent.get("/event"))
      .find((cookie) => cookie.startsWith("placement.sid="))!
      .split(";")[0]!;

    const res = await request(app)
      .post("/event")
      .set("Cookie", sessionCookie)
      .set(CSRF_HEADER, token)
      .send({ company: "amazon", stage: "OA", date: "2026-09-01" });

    expect(res.status).not.toBe(201);
    expect(prisma.event.create).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * THE POINT OF THE WHOLE MECHANISM.
 * ------------------------------------------------------------------ */

describe("an authenticated victim is protected", () => {
  test("a valid session with an invalid token is refused", async () => {
    const { agent } = await signedIn();

    // Exactly the CSRF situation: the session is genuine, the user is genuine,
    // and the request was not made by the application. Authentication and
    // ownership checks both pass here — only this check can refuse it.
    const res = await agent
      .patch("/event/10")
      .set(CSRF_HEADER, "forged")
      .send({ company: "Attacker Inc" });

    expect(res.status).toBe(403);
    expect(prisma.event.update).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Ordering: authentication decides first, so a signed-out caller still
 * learns they are signed out.
 * ------------------------------------------------------------------ */

describe("authentication is still answered before CSRF", () => {
  test("an unauthenticated request answers 401, not 403", async () => {
    const agent = request.agent(app);
    await agent.get("/health");

    const res = await agent.post("/email").send({
      subject: "Amazon OA",
      body: "Amazon OA on 20th Aug",
      sender: "tpo@college.edu",
    });

    // Turning this into a 403 would tell a signed-out user to fix their token
    // when what they need is to sign in.
    expect(res.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ *
 * Exemptions.
 * ------------------------------------------------------------------ */

describe("reads never require a token", () => {
  test("GET /health", async () => {
    expect((await request(app).get("/health")).status).toBe(200);
  });

  test("GET /event", async () => {
    const { agent } = await signedIn();

    expect((await agent.get("/event")).status).toBe(200);
  });

  test("GET /event/:id", async () => {
    const { agent } = await signedIn();

    expect((await agent.get("/event/10")).status).not.toBe(403);
  });
});

describe("the OAuth flow carries its own protection", () => {
  test("GET /gmail/auth needs no application token", async () => {
    const { agent } = await browserWithToken();

    expect((await agent.get("/gmail/auth")).status).toBe(302);
  });

  test("GET /gmail/callback needs no application token", async () => {
    const { agent } = await browserWithToken();

    const start = await agent.get("/gmail/auth");
    const state = new URL(start.headers.location as string).searchParams.get("state");

    // PR-7F's state and PKCE bind this request already, and the browser arrives
    // from Google with no opportunity to carry an application token.
    const res = await agent.get(`/gmail/callback?code=auth-code&state=${state}`);

    expect(res.status).toBe(302);
  });
});

/* ------------------------------------------------------------------ *
 * One answer for every refusal.
 * ------------------------------------------------------------------ */

describe("refusals are indistinguishable from outside", () => {
  test("missing and mismatched tokens answer identically", async () => {
    const missing = await signedIn();
    const missingRes = await missing.agent
      .post("/event")
      .send({ company: "amazon", stage: "OA", date: "2026-09-01" });

    const wrong = await signedIn();
    const wrongRes = await wrong.agent
      .post("/event")
      .set(CSRF_HEADER, "forged")
      .send({ company: "amazon", stage: "OA", date: "2026-09-01" });

    expect(wrongRes.status).toBe(missingRes.status);
    expect(wrongRes.body).toEqual(missingRes.body);
  });

  test("the refusal does not echo the token", async () => {
    const { agent } = await signedIn();

    const res = await agent
      .post("/event")
      .set(CSRF_HEADER, "forged-token-value")
      .send({ company: "amazon", stage: "OA", date: "2026-09-01" });

    // Reflecting the submitted value would let an attacker confirm what the
    // server compared against.
    expect(JSON.stringify(res.body)).not.toContain("forged-token-value");
  });
});
