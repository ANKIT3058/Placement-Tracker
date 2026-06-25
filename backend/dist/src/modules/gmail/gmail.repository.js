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
// Single-account model for now: pick whichever account is connected.
export const getFirstGmailAccount = async () => {
    return prisma.gmailAccount.findFirst();
};
// Used by the background scheduler to sync every connected account.
export const getAllGmailAccounts = async () => {
    return prisma.gmailAccount.findMany();
};
export const getLatestConnectedGmailAccount = async () => {
    return prisma.gmailAccount.findFirst({
        orderBy: {
            connectedAt: "desc",
        },
    });
};
export const updateHistoryId = async (email, historyId) => {
    return prisma.gmailAccount.update({
        where: {
            email,
        },
        data: {
            historyId,
        },
    });
};
//# sourceMappingURL=gmail.repository.js.map