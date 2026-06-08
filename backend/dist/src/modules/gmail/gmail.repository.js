import { prisma } from "../../lib/prisma.js";
export const createGmailAccount = async (email, refreshToken) => {
    return prisma.gmailAccount.upsert({
        where: {
            email,
        },
        update: {
            refreshToken,
        },
        create: {
            email,
            refreshToken,
        },
    });
};
export const getGmailAccount = async (email) => {
    return prisma.gmailAccount.findUnique({
        where: {
            email,
        },
    });
};
//# sourceMappingURL=gmail.repository.js.map