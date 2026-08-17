// Tenant scoping at the attachment persistence boundary.
//
// The attachment worker derives the authoritative owner from the persisted
// Attachment (see document-processing.service.test.ts). Once that owner is
// known, every mutation must carry it into the Prisma WHERE predicate, so that
// holding a valid attachment id is not by itself sufficient to write to the
// row — the same guarantee `email.repository` already provides via
// `updateMany WHERE { id, userId }`.
//
// The Prisma mock below is backed by a small in-memory table rather than bare
// `jest.fn()`s. Cross-tenant safety is a statement about what the database ends
// up holding, and an unscoped `update WHERE { id }` is indistinguishable from a
// scoped `updateMany WHERE { id, userId }` if you only inspect call arguments —
// both are "called with the right id". Applying the WHERE predicate for real is
// what makes "the other tenant's row did not change" an observation instead of
// an assumption.
// The generated Prisma client is ESM-only (it uses `import.meta`), which the
// CommonJS ts-jest transform cannot parse. The repository imports it solely for
// the `Prisma.DbNull` sentinel that `toJsonInput` returns for absent parser
// output, so a stub of exactly that is enough — and keeps this suite from
// dragging the real client into the test runtime.
jest.mock("../../../../generated/prisma/client", () => ({
  Prisma: { DbNull: { __sentinel: "DbNull" } },
}));

jest.mock("../../../lib/prisma", () => {
  type Row = Record<string, unknown> & { id: number; userId: number };

  const rows: Row[] = [];

  // Honours the subset of Prisma filter syntax this repository actually uses:
  // scalar equality, plus the `{ not: x }` shape.
  const matches = (row: Row, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (value !== null && typeof value === "object" && "not" in value) {
        return row[key] !== (value as { not: unknown }).not;
      }
      return row[key] === value;
    });

  return {
    prisma: {
      // Test-only handle on the backing table.
      __rows: rows,
      attachment: {
        findUnique: jest.fn(
          async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
        ),
        findMany: jest.fn(async ({ where }: any) =>
          rows.filter((r) => matches(r, where)),
        ),
        // Mirrors Prisma's real behaviour: a non-matching `update` throws P2025.
        update: jest.fn(async ({ where, data }: any) => {
          const row = rows.find((r) => matches(r, where));
          if (!row) {
            const error: any = new Error(
              "An operation failed because it depends on one or more records that were required but not found.",
            );
            error.code = "P2025";
            throw error;
          }
          Object.assign(row, data);
          return row;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const matched = rows.filter((r) => matches(r, where));
          matched.forEach((row) => Object.assign(row, data));
          return { count: matched.length };
        }),
      },
    },
  };
});

import * as repo from "../attachment.repository";
import { prisma } from "../../../lib/prisma";
import type { OwnershipContext } from "../../auth/tenant-context";

// The scoped signatures do not exist yet — that is what this RED phase is
// establishing. Calls therefore go through a loosely-typed alias so the suite
// compiles against today's unscoped signatures AND tomorrow's scoped ones.
// Without it these tests would fail to COMPILE, which would prove nothing about
// whether a cross-tenant write actually lands; with it, they fail on the
// assertion, which is exactly the behaviour under test.
const call = repo as unknown as Record<
  string,
  (...args: any[]) => Promise<any>
>;

type Row = Record<string, unknown> & { id: number; userId: number };

const table = (prisma as any).__rows as Row[];

const OWNER_USER_ID = 7;
const INTRUDER_USER_ID = 99;

// Ownership crosses this boundary the way it already crosses every other scoped
// repository boundary in the codebase: as an `OwnershipContext` in the FIRST
// argument position, mirroring `updateEmailStatus(owner, id, status)` and
// `markEmailFailed(owner, id, reason)` in `email.repository`. A bare `userId`
// scalar would work equally well at runtime, but it would make the attachment
// repository the only scoped repository with its own calling convention — and
// a scalar in an argument list is far easier to transpose with the id beside it
// than a named context object is.
const OWNER: OwnershipContext = { userId: OWNER_USER_ID };
const INTRUDER: OwnershipContext = { userId: INTRUDER_USER_ID };

const OWNED_ID = 1;
const INTRUDER_OWN_ID = 2;

const PROCESSED_AT = new Date("2026-08-20T10:00:00.000Z");
const PARSED_AT = new Date("2026-08-20T10:05:00.000Z");
const PARSED = {
  text: "placement drive details",
  structuredData: { rows: [] },
  metadata: { pageCount: 3 },
};

const seed = () => {
  table.length = 0;
  table.push(
    {
      id: OWNED_ID,
      userId: OWNER_USER_ID,
      emailId: 10,
      gmailAttachmentId: "gmail-att-1",
      filename: "drive.pdf",
      mimeType: "application/pdf",
      storagePath: null,
      processingStatus: "pending",
      processingError: null,
      processedAt: null,
      text: null,
      parsedData: null,
      parsedMetadata: null,
      parsedAt: null,
      parsingError: null,
    },
    {
      id: INTRUDER_OWN_ID,
      userId: INTRUDER_USER_ID,
      emailId: 20,
      gmailAttachmentId: "gmail-att-2",
      filename: "other.pdf",
      mimeType: "application/pdf",
      storagePath: null,
      processingStatus: "pending",
      processingError: null,
      processedAt: null,
      text: null,
      parsedData: null,
      parsedMetadata: null,
      parsedAt: null,
      parsingError: null,
    },
  );
};

const row = (id: number): Row => table.find((r) => r.id === id)!;
const snapshot = (id: number): Row => ({ ...row(id) });

// A refused scoped write may either resolve with `count: 0` (updateMany, the
// shape `email.repository` uses) or reject with P2025 (update). Both are
// acceptable refusals; what must hold either way is that the row is untouched.
const attempt = async (fn: () => Promise<unknown>) => {
  try {
    return { rejected: false as const, value: await fn() };
  } catch (error) {
    return { rejected: true as const, error };
  }
};

// The WHERE predicate of the most recent write, whichever Prisma verb was used.
const lastWriteWhere = (): Record<string, unknown> | undefined => {
  const updateCalls = (prisma.attachment.update as jest.Mock).mock.calls;
  const updateManyCalls = (prisma.attachment.updateMany as jest.Mock).mock.calls;
  const last = [...updateCalls, ...updateManyCalls].pop();
  return last?.[0]?.where;
};

// Every mutating method the worker uses, with the change each is supposed to
// apply for its legitimate owner.
const MUTATIONS: {
  name: string;
  invoke: (owner: OwnershipContext, id: number) => Promise<unknown>;
  ownerEffect: Record<string, unknown>;
}[] = [
  {
    name: "markAttachmentProcessing",
    invoke: (owner, id) => call.markAttachmentProcessing(owner, id),
    ownerEffect: { processingStatus: "processing", processingError: null },
  },
  {
    name: "markAttachmentCompleted",
    invoke: (owner, id) =>
      call.markAttachmentCompleted(owner, id, "/storage/abc.pdf", PROCESSED_AT),
    ownerEffect: {
      processingStatus: "completed",
      storagePath: "/storage/abc.pdf",
      processedAt: PROCESSED_AT,
      processingError: null,
    },
  },
  {
    name: "markAttachmentFailed",
    invoke: (owner, id) =>
      call.markAttachmentFailed(owner, id, "download exploded"),
    ownerEffect: {
      processingStatus: "failed",
      processingError: "download exploded",
    },
  },
  {
    name: "updateParsedResult",
    invoke: (owner, id) =>
      call.updateParsedResult(owner, id, PARSED, PARSED_AT),
    ownerEffect: {
      text: PARSED.text,
      parsedAt: PARSED_AT,
      parsingError: null,
    },
  },
  {
    name: "markParsingFailed",
    invoke: (owner, id) => call.markParsingFailed(owner, id, "bad pdf"),
    ownerEffect: { parsingError: "bad pdf" },
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  seed();
});

// ---------------------------------------------------------------------------
// 1. The legitimate owner keeps working exactly as before.
// ---------------------------------------------------------------------------

describe("the owner can perform every attachment mutation", () => {
  test.each(MUTATIONS)("$name applies its change", async ({ invoke, ownerEffect }) => {
    await invoke(OWNER, OWNED_ID);

    expect(row(OWNED_ID)).toMatchObject(ownerEffect);
  });

  test.each(MUTATIONS)("$name leaves the owner's identity columns alone", async ({ invoke }) => {
    await invoke(OWNER, OWNED_ID);

    expect(row(OWNED_ID).userId).toBe(OWNER_USER_ID);
    expect(row(OWNED_ID).emailId).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. A different user cannot mutate the attachment, and the attempt leaves
// the target row byte-identical.
// ---------------------------------------------------------------------------

describe("a non-owner cannot mutate another tenant's attachment", () => {
  test.each(MUTATIONS)("$name does not modify the target row", async ({ invoke }) => {
    const before = snapshot(OWNED_ID);

    await attempt(() => invoke(INTRUDER, OWNED_ID));

    expect(row(OWNED_ID)).toEqual(before);
  });

  test.each(MUTATIONS)("$name refuses rather than succeeding silently", async ({ invoke }) => {
    const result = await attempt(() => invoke(INTRUDER, OWNED_ID));

    // Either shape of refusal is fine; a resolved `count: 0` must not be a
    // disguised success.
    if (!result.rejected && result.value && typeof result.value === "object") {
      expect(result.value).toMatchObject({ count: 0 });
    }
  });

  test.each(MUTATIONS)("$name does not touch the intruder's own attachment either", async ({ invoke }) => {
    const before = snapshot(INTRUDER_OWN_ID);

    await attempt(() => invoke(INTRUDER, OWNED_ID));

    expect(row(INTRUDER_OWN_ID)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// The persistence-boundary requirement itself: the tenant predicate must reach
// the query. This is what makes the boundary hold for callers that have NOT
// derived the owner — the ones that do not exist yet.
// ---------------------------------------------------------------------------

describe("every mutation scopes its write by userId", () => {
  test.each(MUTATIONS)("$name includes userId in its WHERE predicate", async ({ invoke }) => {
    await invoke(OWNER, OWNED_ID);

    expect(lastWriteWhere()).toEqual(
      expect.objectContaining({ id: OWNED_ID, userId: OWNER_USER_ID }),
    );
  });

  // The predicate must carry the owner the CALLER supplied, not a value baked
  // into the repository. Running the same mutation for three different owners
  // is what distinguishes "reads owner.userId" from "happens to equal 7".
  test.each([7, 42, 1234])(
    "the tenant predicate tracks the caller's owner (userId %i)",
    async (userId) => {
      table.length = 0;
      table.push({
        id: OWNED_ID,
        userId,
        emailId: 10,
        processingStatus: "pending",
        storagePath: null,
        processedAt: null,
        processingError: null,
      });

      await call.markAttachmentCompleted(
        { userId } satisfies OwnershipContext,
        OWNED_ID,
        "/storage/abc.pdf",
        PROCESSED_AT,
      );

      expect(lastWriteWhere()).toEqual(
        expect.objectContaining({ id: OWNED_ID, userId }),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// The ownership root stays unscoped ON PURPOSE.
//
// `getAttachmentById` is where the worker LEARNS the owner. Requiring a userId
// here would be circular: the caller would have to already know the answer the
// call exists to provide, and the only other place it could come from is the
// queue payload — which is precisely the untrusted input this derivation
// replaces (RFC-001 §9.5).
// ---------------------------------------------------------------------------

describe("getAttachmentById remains the unscoped ownership root", () => {
  test("resolves an attachment from its id alone", async () => {
    const found = await repo.getAttachmentById(OWNED_ID);

    expect(found).toMatchObject({ id: OWNED_ID, userId: OWNER_USER_ID });
  });

  test("exposes the persisted userId so the worker can derive the owner", async () => {
    const found = await repo.getAttachmentById(OWNED_ID);

    expect(found?.userId).toBe(OWNER_USER_ID);
  });

  test("queries by id only — no tenant predicate", async () => {
    await repo.getAttachmentById(OWNED_ID);

    expect(prisma.attachment.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OWNED_ID } }),
    );
  });
});
