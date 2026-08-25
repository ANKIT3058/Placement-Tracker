// G-8.2 — the student profile endpoints.
//
// A registration number is optional campus information, not identity: `User.id`
// remains the only thing that says who a caller is and which records are theirs.
// These tests pin the two properties that make that true in practice — the
// profile is addressed by the session alone, and a missing number is an ordinary
// state rather than a broken account — plus the normalization and conflict
// behaviour the service adds.
//
// `requireAuth` is stubbed here so the contract can be exercised as an
// authenticated caller. The boundary ITSELF — that an anonymous caller is
// refused and writes nothing — is proved separately in
// `user.profile.auth.api.test.ts` against the real middleware, the same split
// `email.api.test.ts` and `email.auth.api.test.ts` already use.

// Keeps `import app` from constructing the real BullMQ queue and its ioredis
// connection.
jest.mock("../infrastructure/queue/queues", () => ({
  emailQueue: { add: jest.fn() },
}));

const AUTHENTICATED_USER_ID = 7;
const OTHER_USER_ID = 99;

jest.mock("../modules/auth/auth.middleware", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: AUTHENTICATED_USER_ID, publicId: "pub-7" };
    next();
  },
}));

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
const VALID_NUMERIC = "20231234";

// A Prisma P2002 naming the registrationNumber index, as the driver reports it.
const takenError = Object.assign(new Error("Unique constraint failed"), {
  code: "P2002",
  meta: { target: ["registrationNumber"] },
});

const patch = async (body: unknown) => {
  const { agent, token } = await browserWithToken(app);

  return agent
    .patch("/user/profile")
    .set(CSRF_HEADER, token)
    .send(body as object);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUnique.mockResolvedValue(null);
  mockUpsert.mockImplementation(async ({ create, update }: any) => ({
    id: 1,
    userId: AUTHENTICATED_USER_ID,
    registrationNumber:
      update?.registrationNumber ?? create?.registrationNumber ?? null,
  }));
});

/* ------------------------------------------------------------------ *
 * Reading.
 * ------------------------------------------------------------------ */

describe("GET /user/profile", () => {
  test("a user with no profile row gets null, not 404", async () => {
    mockFindUnique.mockResolvedValue(null);

    const res = await request(app).get("/user/profile");

    // Not having supplied a registration number is a normal state of a fully
    // functional account — off-campus use never requires one. A 404 would tell
    // an ordinary user something is wrong with them.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      profile: { registrationNumber: null },
    });
  });

  test("an existing registration number is returned", async () => {
    mockFindUnique.mockResolvedValue({
      id: 1,
      userId: AUTHENTICATED_USER_ID,
      registrationNumber: VALID,
    });

    const res = await request(app).get("/user/profile");

    expect(res.status).toBe(200);
    expect(res.body.profile).toEqual({ registrationNumber: VALID });
  });

  test("the row is addressed by the session's userId", async () => {
    await request(app).get("/user/profile");

    // THE OWNERSHIP ASSERTION. The WHERE predicate carries the authenticated
    // id and nothing a caller supplied.
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { userId: AUTHENTICATED_USER_ID },
    });
  });

  test("neither the profile id nor the userId is exposed", async () => {
    mockFindUnique.mockResolvedValue({
      id: 4242,
      userId: AUTHENTICATED_USER_ID,
      registrationNumber: VALID,
    });

    const res = await request(app).get("/user/profile");

    // The profile's own id is not an addressing mechanism and must not become
    // one by being handed out. Asserted over the serialized body so it cannot
    // hide under another key.
    expect(Object.keys(res.body.profile)).toEqual(["registrationNumber"]);
    expect(JSON.stringify(res.body)).not.toContain("4242");
  });
});

/* ------------------------------------------------------------------ *
 * Writing — ownership.
 * ------------------------------------------------------------------ */

describe("PATCH /user/profile is always the caller's own row", () => {
  test("the upsert is keyed on the session's userId", async () => {
    await patch({ registrationNumber: VALID });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: AUTHENTICATED_USER_ID } }),
    );
  });

  test.each([
    ["userId", { registrationNumber: VALID, userId: OTHER_USER_ID }],
    ["id", { registrationNumber: VALID, id: 4242 }],
  ])(
    "a %s smuggled into the body is refused, not honoured",
    async (_field, body) => {
      const res = await patch(body);

      // Refused by the allowlist rather than ignored. Silently dropping it
      // would mean a caller cannot tell whether their attempt to address
      // another row failed or succeeded.
      expect(res.status).toBe(400);
      expect(mockUpsert).not.toHaveBeenCalled();
    },
  );

  test("no request can cause a write keyed on another user", async () => {
    await patch({ registrationNumber: VALID });
    await patch({ registrationNumber: VALID_NUMERIC });

    for (const [args] of mockUpsert.mock.calls) {
      expect(args.where).toEqual({ userId: AUTHENTICATED_USER_ID });
      expect(args.create.userId).toBe(AUTHENTICATED_USER_ID);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Writing — normalization and validation.
 * ------------------------------------------------------------------ */

describe("registration number normalization", () => {
  // NO FORMAT RULE. A registration number is whatever shape the issuing
  // institution uses; encoding one college's convention here would refuse a
  // student whose number is perfectly valid.
  test.each([
    VALID,
    VALID_NUMERIC,
    "2023a1B2",
    "ABC-123",
    "BTECH/2023/42",
    "anything",
    "21BCE1234",
  ])(
    "%s is accepted and stored as given",
    async (value) => {
      const res = await patch({ registrationNumber: value });

      expect(res.status).toBe(200);
      expect(res.body.profile.registrationNumber).toBe(value);
    },
  );

  test("surrounding whitespace is stripped", async () => {
    const res = await patch({ registrationNumber: `  ${VALID}  ` });

    expect(res.status).toBe(200);
    expect(mockUpsert.mock.calls[0][0].update.registrationNumber).toBe(VALID);
  });

  test.each([
    ["null", null],
    ["an empty string", ""],
    ["whitespace only", "   "],
  ])("%s clears the number rather than storing a value", async (_l, value) => {
    const res = await patch({ registrationNumber: value });

    // `""` and NULL must not both mean "absent": only NULL is excluded from the
    // unique index, so an empty string would be a value that collides.
    expect(res.status).toBe(200);
    expect(mockUpsert.mock.calls[0][0].update.registrationNumber).toBeNull();
    expect(res.body.profile.registrationNumber).toBeNull();
  });

  // The API field is defined as a string, so a non-string is a contract
  // violation — the one thing still refused, and refused before Prisma so it is
  // a 400 rather than a 500.
  test.each([
    ["a number", 20231234],
    ["a boolean", true],
    ["an object", { value: VALID }],
    ["an array", [VALID]],
  ])("%s is refused with 400 and writes nothing", async (_label, value) => {
    const res = await patch({ registrationNumber: value });

    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Writing — an omitted field changes nothing.
 * ------------------------------------------------------------------ */

describe("PATCH with no registrationNumber field", () => {
  test("leaves the stored value untouched", async () => {
    mockFindUnique.mockResolvedValue({
      id: 1,
      userId: AUTHENTICATED_USER_ID,
      registrationNumber: VALID,
    });

    const res = await patch({});

    // Absent and explicitly null are different instructions. Reading an
    // omission as a clear would let a partial update silently destroy data the
    // caller never mentioned.
    expect(res.status).toBe(200);
    expect(res.body.profile).toEqual({ registrationNumber: VALID });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  test("does not create a profile row for a user who has none", async () => {
    mockFindUnique.mockResolvedValue(null);

    const res = await patch({});

    // An empty PATCH must not be the thing that brings a profile into
    // existence.
    expect(res.status).toBe(200);
    expect(res.body.profile).toEqual({ registrationNumber: null });
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Writing — conflict.
 * ------------------------------------------------------------------ */

describe("a registration number already held by another user", () => {
  test("is refused with 409", async () => {
    mockUpsert.mockRejectedValueOnce(takenError);

    const res = await patch({ registrationNumber: VALID });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test("the refusal does not reveal who holds it", async () => {
    mockUpsert.mockRejectedValueOnce(takenError);

    const res = await patch({ registrationNumber: VALID });

    // Otherwise this endpoint lets anyone test registration numbers against the
    // user base one request at a time and learn which belong to real accounts.
    const body = JSON.stringify(res.body);

    expect(body).not.toContain(String(OTHER_USER_ID));
    expect(body).not.toMatch(/userId/i);
  });

  test("an unrelated P2002 is not reported as a conflict", async () => {
    mockUpsert.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
        meta: { target: ["userId"] },
      }),
    );

    const res = await patch({ registrationNumber: VALID });

    // Matched on the specific constraint, not on any P2002 — a `userId`
    // collision is a different fault and must not read as "that number is
    // taken".
    expect(res.status).toBe(500);
  });
});

/* ------------------------------------------------------------------ *
 * Logging.
 * ------------------------------------------------------------------ */

describe("the registration number never reaches the logs", () => {
  test("a failed write logs the user id and the reason, not the value", async () => {
    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    mockUpsert.mockRejectedValueOnce(new Error("connection terminated"));

    await patch({ registrationNumber: VALID });

    expect(errorSpy).toHaveBeenCalled();

    // A registration number identifies a real student to their institution, so
    // it is personal information under the same rule that removed email
    // subjects from worker logs (RFC-001 §13.2).
    const logged = JSON.stringify(errorSpy.mock.calls);

    expect(logged).not.toContain(VALID);
    expect(logged).toContain("connection terminated");

    errorSpy.mockRestore();
  });

  test("a rejected value is not echoed in the validation message", async () => {
    const secret = "20231234";

    const res = await patch({ registrationNumber: { value: secret } });

    // The message states the expected TYPE instead of quoting what arrived.
    // Error messages reach logs and error trackers as readily as a log line
    // does, and a malformed request can still carry a real number.
    expect(res.status).toBe(400);
    expect(res.body.message).not.toContain(secret);
  });
});
