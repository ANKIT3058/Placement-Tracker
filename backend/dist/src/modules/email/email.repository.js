import { prisma } from "../../lib/prisma.js";
export const createEmail = async (email) => {
    return prisma.email.create({
        data: {
            gmailMessageId: email.gmailMessageId,
            subject: email.subject,
            body: email.body,
            sender: email.sender,
        },
    });
};
export const getEmailByGmailMessageId = async (gmailMessageId) => {
    return prisma.email.findUnique({
        where: {
            gmailMessageId,
        },
    });
};
export const getEmailById = async (id) => {
    return prisma.email.findUnique({
        where: {
            id,
        },
    });
};
export const updateEmailStatus = async (id, status) => {
    return prisma.email.update({
        where: {
            id,
        },
        data: {
            processingStatus: status,
        },
    });
};
export const markEmailFailed = async (id, reason) => {
    return prisma.email.update({
        where: {
            id,
        },
        data: {
            processingStatus: "failed",
            failureReason: reason,
        },
    });
};
export const getFailedEmails = async () => {
    return prisma.email.findMany({
        where: {
            processingStatus: "failed",
        },
    });
};
export const getPendingEmails = async () => {
    return prisma.email.findMany({
        where: {
            processingStatus: "pending",
        },
    });
};
//# sourceMappingURL=email.repository.js.map