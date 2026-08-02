import { prisma } from "../../lib/prisma.js";
import type { OwnershipContext } from "../auth/tenant-context.js";

interface CreateExtractionInput {
  emailId: number;

  // Owner, copied from the Email this extraction was derived from. They must
  // agree — AC-5.11 enforces that with a composite foreign key to
  // Email(id, userId) (RFC-001 §12.3).
  userId: number | null;

  company?: string;
  stage?: string;
  date?: Date;
  time?: string;
  venue?: string | null;

  isTimeEstimated?: boolean;
  status?: string;

  confidence: number;

  rawText?: string;
}

export const createExtraction = async (data: CreateExtractionInput) => {
  return prisma.emailExtraction.create({
    data,
  });
};

// Currently uncalled. Scoped on both `emailId` and owner rather than `emailId`
// alone: an id from a request is caller-supplied, and a lookup keyed only on it
// reads another tenant's extractions for anyone who guesses a number.
export const getExtractionsForEmail = async (
  owner: OwnershipContext,
  emailId: number,
) => {
  return prisma.emailExtraction.findMany({
    where: {
      emailId,
      userId: owner.userId,
    },
  });
};
