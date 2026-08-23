// PR-9G RED — one extraction per (emailId, userId), enforced by the database.
//
// PR-9E traced every crash point in the email-processing path and found that all
// of them converge on the same single symptom: a duplicate EmailExtraction row.
// `createExtraction` was an unconditional INSERT with no unique constraint, no
// upsert, no pre-check and no transaction spanning it and the Event writes, so
// any replay — and a replay is what BullMQ does after a stalled job — appended a
// second row for the same email.
//
// PR-9F confirmed production is currently clean (117 rows, 117 distinct pairs,
// 0 duplicates), which is what makes the constraint addable without a
// de-duplication step. It proved nothing about the code.
//
// WHY THE MOCK ENFORCES THE KEY.
//
// A test that only asserted "upsert was called" would pass against an
// implementation that upserted on the wrong key, and would keep passing if the
// database constraint were dropped. The guarantee being pinned here is
// *database-enforced uniqueness*, so the fake store below actually enforces it:
// `create` rejects a second row for a key that already exists, exactly as the
// unique index does, and `upsert` resolves on the composite selector.
//
// That is what makes this file fail against the old implementation for the right
// reason — the second `create` is refused — rather than because a spy counted
// wrong.
//
// There is deliberately no database here. The repository has no local Postgres
// (no Docker, no psql) and `backend/.env` points at PRODUCTION, so an
// integration test would have to be pointed at the live database. Modelling the
// constraint is the honest substitute; the constraint itself is verified by
// inspecting the generated migration SQL.

type Row = {
  id: number;
  emailId: number;
  userId: number;
  company: string | null;
  stage: string | null;
  date: Date | null;
  time: string | null;
  venue: string | null;
  isTimeEstimated: boolean | null;
  status: string | null;
  confidence: number;
  rawText: string | null;
  createdAt: Date;
};

const rows: Row[] = [];

const keyOf = (emailId: number, userId: number) => `${emailId}|${userId}`;

const find = (emailId: number, userId: number) =>
  rows.find((row) => keyOf(row.emailId, row.userId) === keyOf(emailId, userId));

// Shaped like the error Prisma raises on a unique-constraint violation, so the
// failure mode under test is the database's, not the mock's.
const uniqueViolation = () => {
  const error = new Error(
    "Unique constraint failed on the fields: (`emailId`,`userId`)",
  ) as Error & { code: string; meta: { target: string[] } };

  error.code = "P2002";
  error.meta = { target: ["emailId", "userId"] };

  return error;
};

const materialise = (data: Record<string, unknown>): Row => ({
  id: rows.length + 1,
  emailId: data.emailId as number,
  userId: data.userId as number,
  company: (data.company as string) ?? null,
  stage: (data.stage as string) ?? null,
  date: (data.date as Date) ?? null,
  time: (data.time as string) ?? null,
  venue: (data.venue as string) ?? null,
  isTimeEstimated: (data.isTimeEstimated as boolean) ?? null,
  status: (data.status as string) ?? null,
  confidence: data.confidence as number,
  rawText: (data.rawText as string) ?? null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

const upsertSpy = jest.fn();

jest.mock("../../../lib/prisma", () => ({
  prisma: {
    emailExtraction: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (find(data.emailId as number, data.userId as number)) {
          throw uniqueViolation();
        }

        const row = materialise(data);
        rows.push(row);

        return row;
      }),

      upsert: jest.fn(
        async (args: {
          where: { emailId_userId?: { emailId: number; userId: number } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          upsertSpy(args);

          const selector = args.where.emailId_userId;

          // A selector that is not the composite key cannot address the row the
          // constraint protects. Failing loudly here stops a wrong-key upsert
          // from looking like a passing test.
          if (!selector) {
            throw new Error(
              "upsert must resolve on the composite emailId_userId selector",
            );
          }

          const existing = find(selector.emailId, selector.userId);

          if (!existing) {
            const row = materialise(args.create);
            rows.push(row);

            return row;
          }

          // `undefined` means "leave unchanged" in Prisma, so the repository is
          // expected to send explicit nulls. Applying the payload verbatim is
          // what lets a test catch it if it does not.
          Object.assign(existing, args.update);

          return existing;
        },
      ),
    },
  },
}));

import { createExtraction } from "../extraction.repository";

const EMAIL = 42;
const USER = 7;

const base = {
  emailId: EMAIL,
  userId: USER,
  company: "Amazon",
  stage: "oa",
  confidence: 0.9,
};

describe("an email has exactly one extraction, whatever the worker does", () => {
  beforeEach(() => {
    rows.length = 0;
    jest.clearAllMocks();
  });

  test("the first execution creates one row", async () => {
    await createExtraction(base);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ emailId: EMAIL, userId: USER });
  });

  test("a replay does not create a second row", async () => {
    // The BullMQ replay: identical job, same email, run again after the first
    // attempt died before the job was acknowledged.
    await createExtraction(base);
    await createExtraction(base);

    expect(rows).toHaveLength(1);
  });

  test("a replay updates the row to the latest extraction result", async () => {
    await createExtraction(base);

    // Not a hypothetical. With USE_AI=true the extractor is nondeterministic, so
    // a replay can legitimately return a different answer — and the row must end
    // up representing the attempt that actually completed, not the one that
    // crashed.
    await createExtraction({
      ...base,
      company: "Amazon India",
      stage: "interview",
      confidence: 0.95,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      company: "Amazon India",
      stage: "interview",
      confidence: 0.95,
    });
  });

  test("a replay that extracts less clears the stale field rather than keeping it", async () => {
    await createExtraction({ ...base, venue: "LT-1" });

    // `undefined` is Prisma's "leave unchanged", so an implementation that
    // forwards the payload as-is would silently retain "LT-1" and leave the row
    // describing neither attempt.
    await createExtraction({ ...base, venue: undefined });

    expect(rows).toHaveLength(1);
    expect(rows[0].venue).toBeNull();
  });

  test("different emails keep separate extractions", async () => {
    await createExtraction(base);
    await createExtraction({ ...base, emailId: 43 });

    expect(rows).toHaveLength(2);
  });

  test("the same email id under a different owner does not collide", async () => {
    await createExtraction(base);
    await createExtraction({ ...base, userId: 8 });

    // Proves the key is composite. Keyed on emailId alone, the second write
    // would overwrite another tenant's extraction.
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.userId).sort()).toEqual([7, 8]);
  });

  test("the write resolves on the composite emailId_userId selector", async () => {
    await createExtraction(base);

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0].where).toEqual({
      emailId_userId: { emailId: EMAIL, userId: USER },
    });
  });

  test("identity columns are never rewritten by the update branch", async () => {
    await createExtraction(base);
    await createExtraction(base);

    const update = upsertSpy.mock.calls[1][0].update;

    expect(update).not.toHaveProperty("emailId");
    expect(update).not.toHaveProperty("userId");
    expect(update).not.toHaveProperty("id");
  });
});
