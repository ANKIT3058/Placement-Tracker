const prismaMock: any = {
  event: {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    // AC-5.8. Tenant-scoped reads use `findFirst` rather than `findUnique`,
    // because the predicate is (id, userId) and only `id` is unique until
    // AC-5.11. Defaults to a bare owned row so ownership checks pass; a test
    // that cares about the refusal path overrides it with null.
    findFirst: jest.fn().mockResolvedValue({ id: 1 }),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  eventUpdate: {
    create: jest.fn(),
  },
  emailExtraction: {
    create: jest.fn(),
  },
};

// Interactive transaction mock: invoke the callback with this same mock as the
// transaction client (tx), so code under test can call tx.event.update /
// tx.eventUpdate.create and have them resolve against the mocked methods.
// Assigned after the object literal to avoid a circular self-reference in the
// initializer (which TypeScript flags as implicit any).
prismaMock.$transaction = jest.fn((callback: (tx: typeof prismaMock) => unknown) =>
  callback(prismaMock),
);

export const prisma = prismaMock;
