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
import request from "supertest";
import app from "../app";

describe("POST /email", () => {
  test("accepts a valid email and queues it for processing", async () => {
    const res = await request(app).post("/email").send({
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
    const res = await request(app).post("/email").send({
      body: "Amazon OA on 20th Aug",
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
