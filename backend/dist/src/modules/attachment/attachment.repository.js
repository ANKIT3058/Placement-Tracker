import { prisma } from "../../lib/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { ATTACHMENT_STATUS } from "./attachment.types.js";
// Coerce optional parser output into a Prisma JSON input. Absent values are
// written as SQL NULL (DbNull) rather than a JSON `null` literal. The cast
// bridges our typed interfaces to Prisma's structural InputJsonValue.
const toJsonInput = (value) => value === undefined || value === null
    ? Prisma.DbNull
    : value;
// Load an attachment with its originating email AND that email's Gmail account
// in a single query, so the worker can resolve the correct refreshToken via
// Attachment -> Email -> GmailAccount without extra round trips.
export const getAttachmentById = async (id) => {
    return prisma.attachment.findUnique({
        where: { id },
        include: { email: { include: { gmailAccount: true } } },
    });
};
// Attachments belonging to an email that have not been successfully processed
// yet. Used when enqueueing processing jobs so completed files are never
// re-fetched.
export const getPendingAttachmentsByEmailId = async (emailId) => {
    return prisma.attachment.findMany({
        where: {
            emailId,
            processingStatus: { not: ATTACHMENT_STATUS.COMPLETED },
        },
    });
};
export const markAttachmentProcessing = async (id) => {
    return prisma.attachment.update({
        where: { id },
        data: {
            processingStatus: ATTACHMENT_STATUS.PROCESSING,
            processingError: null,
        },
    });
};
export const markAttachmentCompleted = async (id, storagePath, processedAt) => {
    return prisma.attachment.update({
        where: { id },
        data: {
            processingStatus: ATTACHMENT_STATUS.COMPLETED,
            storagePath,
            processedAt,
            processingError: null,
        },
    });
};
export const markAttachmentFailed = async (id, reason) => {
    return prisma.attachment.update({
        where: { id },
        data: {
            processingStatus: ATTACHMENT_STATUS.FAILED,
            processingError: reason,
        },
    });
};
// Persist a successful parse result. Only the parsing columns are written —
// processingStatus (the download lifecycle) is intentionally left untouched, so
// this composes with markAttachmentCompleted rather than replacing it.
export const updateParsedResult = async (id, parsed, parsedAt) => {
    return prisma.attachment.update({
        where: { id },
        data: {
            text: parsed.text,
            parsedData: toJsonInput(parsed.structuredData),
            parsedMetadata: toJsonInput(parsed.metadata),
            parsedAt,
            parsingError: null,
        },
    });
};
// Record a parse failure without touching the download lifecycle: the file was
// downloaded successfully, only parsing failed. processingStatus stays as-is.
export const markParsingFailed = async (id, reason) => {
    return prisma.attachment.update({
        where: { id },
        data: {
            parsingError: reason,
        },
    });
};
//# sourceMappingURL=attachment.repository.js.map