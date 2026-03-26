import { prisma } from "../../lib/prisma";

export const saveExtraction = async (payload: any) => {
  return prisma.emailExtraction.create({
    data: payload,
  });
};
