import { prisma } from "../../lib/prisma.js";

interface CreateExtractionInput {
  emailId: number;

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

export const getExtractionsForEmail = async (emailId: number) => {
  return prisma.emailExtraction.findMany({
    where: {
      emailId,
    },
  });
};
