import { prisma } from "../../lib/prisma.js";
export const saveExtraction = async (payload) => {
    return prisma.emailExtraction.create({
        data: payload,
    });
};
//# sourceMappingURL=extraction.repository.js.map