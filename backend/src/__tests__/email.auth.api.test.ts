// PR-7C — the POST /email authorization boundary, tested for real.
//
// `email.api.test.ts` stubs `requireAuth` so it can exercise the ingestion
// contract without a session. That is the right call for those tests, but it
// means nothing in the suite currently proves the boundary itself: every
// assertion there runs as an already-authenticated caller. This file is the
// missing half — the real middleware, no session, and the two facts that must
// hold.
//
// It exists because PR-7C hides the manual-email form from signed-out users,
// and hiding a control is presentation, not authorization. If the server ever
// stopped refusing an anonymous POST, the UI change would be the only thing
// standing between a stranger and the ingestion pipeline — which is no defence
// at all. These assertions are what make the UI change merely cosmetic.
//
// `requireAuth` is deliberately NOT mocked. `sessionMiddleware` runs as it does
// in production; with no cookie, `saveUninitialized: false` leaves the session
// empty, `req.session.userId` is undefined, and the request is refused before
// any store or database lookup.

// Keeps `import app` from constructing the real BullMQ queue and its ioredis
// connection.
jest.mock("../infrastructure/queue/queues", () => ({
  emailQueue: { add: jest.fn() },
}));

// The Email table, so "no row was written" is an observation rather than an
// inference from the status code.
jest.mock("../lib/prisma", () => ({
  prisma: {
    email: { create: jest.fn() },
  },
}));

import request from "supertest";
import app from "../app";
import { prisma } from "../lib/prisma";

const VALID_BODY = {
  subject: "Amazon OA",
  body: "Amazon OA on 20th Aug",
  sender: "tpo@college.edu",
};

describe("POST /email without a session", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("is refused with 401", async () => {
    const res = await request(app).post("/email").send(VALID_BODY);

    expect(res.status).toBe(401);
  });

  test("writes no Email row", async () => {
    await request(app).post("/email").send(VALID_BODY);

    // `Email.userId` is NOT NULL: an anonymous caller has no owner to attribute
    // a row to, which is why this route cannot be opened up rather than merely
    // should not be.
    expect(prisma.email.create).not.toHaveBeenCalled();
  });

  test("does not disclose why the request was refused", async () => {
    const res = await request(app).post("/email").send(VALID_BODY);

    // One answer for every authentication failure (RFC-001 §9.4) — no session,
    // expired session and disabled account are indistinguishable from outside.
    expect(res.body).toMatchObject({
      success: false,
      message: "Authentication required",
    });
  });

  test("refuses before validating the payload", async () => {
    const res = await request(app).post("/email").send({});

    // A malformed anonymous request must still answer 401, not 400: telling an
    // unauthenticated caller which fields are missing describes an endpoint
    // they may not use.
    expect(res.status).toBe(401);
    expect(prisma.email.create).not.toHaveBeenCalled();
  });
});
