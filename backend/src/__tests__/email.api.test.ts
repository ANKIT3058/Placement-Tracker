jest.mock("../lib/prisma");
import request from "supertest";
import app from "../app";

describe("POST /email", () => {
  test("invalid venue should NOT crash", async () => {
    const res = await request(app).post("/email").send({
      body: "Amazon OA on 20th Aug venue: PFA seating plan",
    });

    expect(res.status).toBe(201);
    expect(res.body.venue).toBe(null);
  });
});