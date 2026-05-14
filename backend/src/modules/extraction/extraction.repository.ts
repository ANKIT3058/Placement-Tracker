import { prisma } from "../../lib/prisma.js";

export const saveExtraction = async (payload: any) => {
  return prisma.emailExtraction.create({
    data: payload,
  });
};
