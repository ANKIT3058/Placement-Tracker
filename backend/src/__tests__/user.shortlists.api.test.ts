// G-8.4 — GET /user/shortlists.
//
// The first consumer of two capabilities that were stored and read by nothing:
// the registration number from G-8.2, and `participantInformation` from G-6.
// It joins them to answer one question — "am I on this shortlist?" — and the
// assertions here are about the boundaries of that answer.
//
// TWO PROPERTIES CARRY THIS FILE, and both are stated as absences.
//
// 1. OWNERSHIP IS `User.id`, NOT THE REGISTRATION NUMBER. The set of documents
//    considered is decided by a tenant-scoped query; the number only decides
//    which of those the caller appears in. A user with a number matching
//    someone else's document must still see nothing, because that document was
//    never in scope.
//
// 2. NO OTHER PARTICIPANT LEAVES THE ENDPOINT. A shortlist lists real students
//    by name and roll number. The response carries attachment ids the caller
//    already owns and nothing else — not another student's row, and not even
//    the caller's own attributes.

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

const mockProfileFindUnique = jest.fn();
const mockIntelligenceFindMany = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    studentProfile: {
      findUnique: mockProfileFindUnique,
      upsert: jest.fn(),
    },
    documentIntelligence: {
      findMany: mockIntelligenceFindMany,
    },
  },
}));

import request from "supertest";
import app from "../app";

const MINE = "20231234";

// A shortlist that lists real students, one of whom is the caller. The other
// rows exist so "nothing about them is returned" is an observation rather than
// an assumption.
const shortlist = (attachmentId: number, numbers: string[]) => ({
  attachmentId,
  participantInformation: {
    participants: numbers.map((roll_no, index) => ({
      attributes: { roll_no, name: `Student ${index}`, seat: `A${index}` },
    })),
  },
});

const get = () => request(app).get("/user/shortlists");

beforeEach(() => {
  jest.clearAllMocks();
  mockProfileFindUnique.mockResolvedValue({
    id: 1,
    userId: AUTHENTICATED_USER_ID,
    registrationNumber: MINE,
  });
  mockIntelligenceFindMany.mockResolvedValue([]);
});

describe("finding the caller on their own shortlists", () => {
  test("reports the shortlists that list their number", async () => {
    mockIntelligenceFindMany.mockResolvedValue([
      shortlist(11, ["20230001", MINE, "20230002"]),
      shortlist(12, ["20230003"]),
    ]);

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.participation.appearsOn).toEqual([{ attachmentId: 11 }]);
  });

  test("reports how many were checked, so an empty answer is honest", async () => {
    mockIntelligenceFindMany.mockResolvedValue([
      shortlist(11, ["20230001"]),
      shortlist(12, ["20230002"]),
    ]);

    const res = await get();

    // "You appear on none of 2" and "there were none to check" are different
    // answers, and a bare empty list conflates them.
    expect(res.body.participation).toMatchObject({
      shortlistsChecked: 2,
      appearsOn: [],
    });
  });

  test("a malformed participantInformation yields no match rather than a 500", async () => {
    mockIntelligenceFindMany.mockResolvedValue([
      { attachmentId: 11, participantInformation: null },
      { attachmentId: 12, participantInformation: { participants: "nope" } },
      { attachmentId: 13, participantInformation: {} },
      shortlist(14, [MINE]),
    ]);

    const res = await get();

    // The column is model-written JSON and may be absent or shaped differently
    // by an older run. A bad document must not take down the request.
    expect(res.status).toBe(200);
    expect(res.body.participation.appearsOn).toEqual([{ attachmentId: 14 }]);
  });
});

describe("ownership is User.id, never the registration number", () => {
  test("the query is scoped to the caller and to shortlists", async () => {
    await get();

    // THE OWNERSHIP ASSERTION. Scoping happens in the query, so another
    // tenant's participant data never enters this process at all.
    expect(mockIntelligenceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: AUTHENTICATED_USER_ID,
          classification: "shortlist",
        },
      }),
    );
  });

  test("the profile is read for the authenticated user", async () => {
    await get();

    expect(mockProfileFindUnique).toHaveBeenCalledWith({
      where: { userId: AUTHENTICATED_USER_ID },
    });
  });

  test("a matching number in another user's document is never reachable", async () => {
    // The repository returns only the caller's rows, so a document belonging to
    // OTHER_USER_ID cannot appear here however well its contents match. Asserted
    // by giving the caller nothing and confirming the answer is empty.
    mockIntelligenceFindMany.mockResolvedValue([]);

    const res = await get();

    expect(res.body.participation.appearsOn).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(String(OTHER_USER_ID));
  });

  test("the summary is never selected", async () => {
    await get();

    const select = mockIntelligenceFindMany.mock.calls[0][0].select;

    // A generated synopsis of a document that lists other students is exactly
    // the field that could carry their names into a response meant to contain
    // none. Asserted as the exact selection so a future addition is deliberate.
    expect(select).toEqual({ attachmentId: true, participantInformation: true });
  });
});

describe("no other participant is exposed", () => {
  test("the response carries attachment ids and nothing else", async () => {
    mockIntelligenceFindMany.mockResolvedValue([
      shortlist(11, ["20230001", MINE, "20230002"]),
    ]);

    const res = await get();

    expect(res.body.participation.appearsOn).toEqual([{ attachmentId: 11 }]);
    expect(Object.keys(res.body.participation.appearsOn[0])).toEqual([
      "attachmentId",
    ]);
  });

  test("no other student's number, name or seat appears anywhere", async () => {
    mockIntelligenceFindMany.mockResolvedValue([
      shortlist(11, ["20230001", MINE, "20230002"]),
    ]);

    const res = await get();
    const body = JSON.stringify(res.body);

    // Asserted over the serialized response so nothing can hide under a key
    // this test did not think to name.
    for (const leaked of ["20230001", "20230002", "Student 0", "A0", "seat"]) {
      expect(body).not.toContain(leaked);
    }
  });
});

describe("a caller with no registration number", () => {
  test.each([
    ["no profile row", null],
    ["a profile with no number", { registrationNumber: null }],
    ["a blank number", { registrationNumber: "   " }],
  ])("%s is answered 200 with an empty result", async (_label, profile) => {
    mockProfileFindUnique.mockResolvedValue(profile);
    mockIntelligenceFindMany.mockResolvedValue([shortlist(11, [MINE])]);

    const res = await get();

    // Having no number is an ordinary state, and this feature is exactly as
    // optional as the field it reads. Not a 404 and not an error.
    expect(res.status).toBe(200);
    expect(res.body.participation.appearsOn).toEqual([]);
  });

  test("the shortlists are not read at all", async () => {
    mockProfileFindUnique.mockResolvedValue({ registrationNumber: null });

    await get();

    // A student who has not supplied a number has not asked to be looked up.
    expect(mockIntelligenceFindMany).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  test("a database failure is a 500, not a partial answer", async () => {
    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    mockIntelligenceFindMany.mockRejectedValue(new Error("connection lost"));

    const res = await get();

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);

    // The registration number is personal information and stays out of the
    // logs, as it does everywhere else in this module (RFC-001 §13.2).
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(MINE);

    errorSpy.mockRestore();
  });
});
