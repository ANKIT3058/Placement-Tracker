const prismaMock: any = {
  event: {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    update: jest.fn(),
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
