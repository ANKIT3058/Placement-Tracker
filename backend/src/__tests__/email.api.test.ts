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
