import { prisma } from "../../lib/prisma.js";
export const createExtraction = async (data) => {
    return prisma.emailExtraction.create({
        data,
    });
};
export const getExtractionsForEmail = async (emailId) => {
    return prisma.emailExtraction.findMany({
        where: {
            emailId,
        },
    });
};
//# sourceMappingURL=extraction.repository.js.map