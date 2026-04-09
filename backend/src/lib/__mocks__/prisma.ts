export const prisma = {
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