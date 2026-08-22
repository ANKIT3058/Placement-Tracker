// Mock prisma: the controller path hits prisma.email.create via createEmail.
jest.mock("../lib/prisma", () => ({
  prisma: {
    email: {
      create: jest.fn().mockResolvedValue({ id: 1 }),
    },
  },
}));
// Mock the queue layer so importing `app` does not pull in the real BullMQ
// Queue / ioredis connection (queues.ts → redis.ts), which auto-connects on
// construction and leaks an open TCP socket that prevents Jest from exiting.
jest.mock("../infrastructure/queue/queues", () => ({ emailQueue: { add: jest.fn() } }));
// AC-5.9. POST /email is authenticated now, because `Email.userId` is NOT NULL
// and an anonymous caller has no owner to attribute the row to. This suite is
// about the ingestion contract, not about authentication, so `requireAuth` is
// replaced with a stub that supplies a caller. Whether the real middleware
// admits or refuses a request is exercised where that behaviour lives.
jest.mock("../modules/auth/auth.middleware", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 1, publicId: "test-user", googleSub: "sub-1", email: "test@example.com", name: null, imageUrl: null };
    next();
  },
}));
import app from "../app";
import { browserWithToken, CSRF_HEADER } from "./helpers/csrf";

// PR-8B. `POST /email` is behind `requireCsrf` now, so a request with no cookie
// jar and no `X-CSRF-Token` is refused before the controller runs. These two
// requests are built the way the browser builds them — an ordinary read first,
// then the token it was issued echoed back — which leaves the ingestion
// contract below exactly as it was. The check itself is exercised in
// `modules/auth/__tests__/csrf.api.test.ts`, not here.
describe("POST /email", () => {
  test("accepts a valid email and queues it for processing", async () => {
    const { agent, token } = await browserWithToken(app);

    const res = await agent.post("/email").set(CSRF_HEADER, token).send({
      subject: "Amazon OA",
      body: "Amazon OA on 20th Aug venue: PFA seating plan",
      sender: "tpo@college.edu",
    });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      success: true,
      message: "Email queued for processing",
    });
  });

  test("rejects an email missing required fields", async () => {
    const { agent, token } = await browserWithToken(app);

    const res = await agent.post("/email").set(CSRF_HEADER, token).send({
      body: "Amazon OA on 20th Aug",
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
