// G-8.2 — the /user/profile authorization boundary, tested for real.
//
// `user.profile.api.test.ts` stubs `requireAuth` so it can exercise the profile
// contract as an authenticated caller. That is the right call for those tests,
// and it means nothing there proves the boundary itself. This file is the
// missing half — the real middleware, no session, and the facts that must hold.
//
// It matters more here than on most routes. A registration number identifies a
// real student to their institution, and `StudentProfile.registrationNumber` is
// globally unique in this deployment, so an unauthenticated write would let a
// stranger claim a real student's number and an unauthenticated read would
// disclose one. The endpoint's whole addressing model is "you are the row you
// can reach", which is only true if an anonymous caller can reach nothing.
//
// `requireAuth` is deliberately NOT mocked. `sessionMiddleware` runs as it does
// in production; with no cookie, `saveUninitialized: false` leaves the session
// empty, `req.session.userId` is undefined, and the request is refused before
// any store or database lookup.

jest.mock("../infrastructure/queue/queues", () => ({
  emailQueue: { add: jest.fn() },
}));

// The StudentProfile table, so "nothing was read and nothing was written" is an
// observation rather than an inference from the status code.
const mockFindUnique = jest.fn();
const mockUpsert = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    studentProfile: {
      findUnique: mockFindUnique,
      upsert: mockUpsert,
    },
  },
}));

import request from "supertest";
import app from "../app";
import { browserWithToken, CSRF_HEADER } from "./helpers/csrf";

const VALID = "2023ABCD";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /user/profile without a session", () => {
  test("is refused with 401", async () => {
    const res = await request(app).get("/user/profile");

    expect(res.status).toBe(401);
  });

  test("reads no StudentProfile row", async () => {
    await request(app).get("/user/profile");

    // The refusal happens before the handler, so no query is issued at all —
    // there is no id an anonymous caller could have supplied anyway, which is
    // the property this endpoint's design rests on.
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  test("discloses no registration number", async () => {
    mockFindUnique.mockResolvedValue({
      id: 1,
      userId: 7,
      registrationNumber: VALID,
    });

    const res = await request(app).get("/user/profile");

    expect(JSON.stringify(res.body)).not.toContain(VALID);
  });
});

describe("PATCH /user/profile without a session", () => {
  test("is refused with 401, not 403", async () => {
    // `requireAuth` precedes `requireCsrf` on this router, and that ordering is
    // the assertion: a signed-out caller must be told they are signed out
    // (RFC-001 §11.4). A 403 here would mean CSRF ran first and the auth
    // boundary is behind it.
    const { agent, token } = await browserWithToken(app);

    const res = await agent
      .patch("/user/profile")
      .set(CSRF_HEADER, token)
      .send({ registrationNumber: VALID });

    expect(res.status).toBe(401);
  });

  test("writes no StudentProfile row", async () => {
    const { agent, token } = await browserWithToken(app);

    await agent
      .patch("/user/profile")
      .set(CSRF_HEADER, token)
      .send({ registrationNumber: VALID });

    // The decisive one. `registrationNumber` is globally unique here, so an
    // anonymous write would let a stranger take a real student's number and
    // permanently deny it to them.
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  test("a body carrying a userId cannot create a profile for that user", async () => {
    const { agent, token } = await browserWithToken(app);

    await agent
      .patch("/user/profile")
      .set(CSRF_HEADER, token)
      .send({ registrationNumber: VALID, userId: 7 });

    // A `userId` in a request body is not an input to authentication and never
    // will be (auth.middleware). Asserted as an absence of any write, because
    // the outcome alone cannot distinguish "correctly refused" from "considered
    // and happened to fail".
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("PATCH /user/profile without a CSRF token", () => {
  test("is refused and writes nothing", async () => {
    // No cookie jar, no header — the shape a cross-site form submission has.
    const res = await request(app)
      .patch("/user/profile")
      .send({ registrationNumber: VALID });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
