// How the cleanup reacts to concurrent activity.
//
// `transaction-safety.ts` imports nothing, so the classification can be driven
// from synthetic errors shaped exactly like the ones Prisma and node-postgres
// raise. That is the practical way to demonstrate this behaviour: provoking a
// real 40001 needs two live connections racing on production rows, which is the
// one thing this work is not allowed to do.
//
// The property under test is narrow and important: every concurrency signal
// must be RECOGNISED and REPORTED, and none of them may lead to a retry. There
// is no retry path in the module at all — `classifyTransactionFailure` returns a
// label and `failureGuidance` returns text, and neither can re-run anything.

import {
  classifyTransactionFailure,
  failureGuidance,
  PRISMA_UNIQUE_VIOLATION,
  PRISMA_WRITE_CONFLICT,
} from "../transaction-safety";

/** Shaped like `PrismaClientKnownRequestError`: an Error carrying a `code`. */
const prismaError = (code: string, message: string): Error => {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
};

/** Shaped like a `pg` DatabaseError, which carries the raw SQLSTATE. */
const pgError = (code: string, message: string): Error => prismaError(code, message);

describe("serialization failures are recognised", () => {
  // The hazard the isolation level exists for: another transaction updated a row
  // this one had already validated, between the revalidation and the write.
  test("Prisma's write-conflict code (P2034)", () => {
    const failure = classifyTransactionFailure(
      prismaError(
        PRISMA_WRITE_CONFLICT,
        "Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
      ),
    );

    expect(failure.kind).toBe("serialization");
  });

  test.each([
    [
      "concurrent update — first-updater-wins under snapshot isolation",
      "could not serialize access due to concurrent update",
    ],
    [
      "SSI read/write dependency cycle",
      "could not serialize access due to read/write dependencies among transactions",
    ],
    ["deadlock", "deadlock detected"],
  ])("the raw Postgres message for %s", (_label, message) => {
    expect(classifyTransactionFailure(new Error(message)).kind).toBe("serialization");
  });

  test.each([["40001"], ["40P01"]])(
    "the raw SQLSTATE %s arriving from the driver adapter",
    (code) => {
      const failure = classifyTransactionFailure(
        pgError(code, "could not serialize access"),
      );

      expect(failure.kind).toBe("serialization");
    },
  );

  test("the SQLSTATE is matched case-insensitively in a message", () => {
    expect(
      classifyTransactionFailure(new Error("SQLSTATE 40P01 raised by the server")).kind,
    ).toBe("serialization");
  });
});

describe("a concurrent INSERT surfaces as a unique violation", () => {
  // SSI only monitors transactions that are THEMSELVES serializable, and every
  // other writer in this system runs at the default. A colliding insert from one
  // of those is caught by the non-deferrable UNIQUE(userId, eventKey) index
  // instead — which is a concurrency signal, not a planning bug, and must be
  // reported as such.
  test("P2002 is classified as a collision, not as an unknown error", () => {
    const failure = classifyTransactionFailure(
      prismaError(
        PRISMA_UNIQUE_VIOLATION,
        "Unique constraint failed on the fields: (`userId`,`eventKey`)",
      ),
    );

    expect(failure.kind).toBe("unique-violation");
    expect(failure.detail).toContain("eventKey");
  });

  test("its guidance points at concurrent writers, not at the plan", () => {
    const advice = failureGuidance({ kind: "unique-violation", detail: "" }).join(" ");

    expect(advice).toContain("IDENTITY COLLISION");
    expect(advice).toContain("concurrently");
  });
});

describe("everything else stays an ordinary failure", () => {
  test("an unrelated error is not dressed up as a concurrency conflict", () => {
    const failure = classifyTransactionFailure(new Error("connection terminated"));

    expect(failure.kind).toBe("other");
    expect(failure.detail).toBe("connection terminated");
  });

  test("a non-Error value is still classified rather than thrown on", () => {
    expect(classifyTransactionFailure("something went wrong")).toEqual({
      kind: "other",
      detail: "something went wrong",
    });
    expect(classifyTransactionFailure(undefined).kind).toBe("other");
  });

  test("a foreign-key code is not mistaken for a write conflict", () => {
    expect(classifyTransactionFailure(prismaError("P2003", "FK failed")).kind).toBe(
      "other",
    );
  });
});

describe("a serialization failure is reported, never retried", () => {
  test("the guidance says so explicitly and tells the operator what to do", () => {
    const advice = failureGuidance({ kind: "serialization", detail: "" });
    const text = advice.join(" ");

    expect(text).toContain("CONCURRENT ACTIVITY DETECTED");
    expect(text).toContain("rolled back");
    expect(text).toContain("NOT retried");
    expect(text).toContain("dry run");
  });

  test.each([
    ["serialization" as const],
    ["unique-violation" as const],
    ["precondition" as const],
    ["other" as const],
  ])("the %s guidance never promises a retry", (kind) => {
    const text = failureGuidance({ kind, detail: "" }).join(" ").toLowerCase();

    expect(text).not.toMatch(/retrying|will retry|attempt \d+|re-?attempting/);
  });

  test("every kind produces guidance, so no failure is reported bare", () => {
    for (const kind of ["serialization", "unique-violation", "precondition", "other"] as const) {
      expect(failureGuidance({ kind, detail: "" }).length).toBeGreaterThan(0);
    }
  });
});
