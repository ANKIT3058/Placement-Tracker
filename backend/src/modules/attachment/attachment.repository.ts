import { prisma } from "../../lib/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { ATTACHMENT_STATUS } from "./attachment.types.js";
import type { ParsedAttachment } from "./parsers/parsed-attachment.types.js";
import type { OwnershipContext } from "../auth/tenant-context.js";

// Coerce optional parser output into a Prisma JSON input. Absent values are
// written as SQL NULL (DbNull) rather than a JSON `null` literal. The cast
// bridges our typed interfaces to Prisma's structural InputJsonValue.
const toJsonInput = (
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  value === undefined || value === null
    ? Prisma.DbNull
    : (value as Prisma.InputJsonValue);

// THE OWNERSHIP DERIVATION ROOT — deliberately unscoped, mirroring
// `getEmailById` in email.repository.
//
// The attachment queue payload is `{ attachmentId }` and stays that way, so
// this is where the pipeline LEARNS who owns the work: the worker reads the row
// and takes `userId` off it. Requiring an owner here would be circular — the
// caller would have to already know the answer this call exists to provide, and
// the only place it could come from is the queue payload, which is exactly the
// untrusted input the derivation replaces (RFC-001 §9.5).
//
// Load an attachment with its originating email AND that email's Gmail account
// in a single query, so the worker can resolve the correct refreshToken via
// Attachment -> Email -> GmailAccount without extra round trips.
export const getAttachmentById = async (id: number) => {
  return prisma.attachment.findUnique({
    where: { id },
    include: { email: { include: { gmailAccount: true } } },
  });
};

// Attachments belonging to an email that have not been successfully processed
// yet. Used when enqueueing processing jobs so completed files are never
// re-fetched.
export const getPendingAttachmentsByEmailId = async (emailId: number) => {
  return prisma.attachment.findMany({
    where: {
      emailId,
      processingStatus: { not: ATTACHMENT_STATUS.COMPLETED },
    },
  });
};

// Every mutation below is tenant-scoped, the same way email.repository scopes
// its status writes: `updateMany WHERE { id, userId }`.
//
// `updateMany` rather than `update` because the tenant predicate has to reach
// the query, and Prisma's `update` only accepts a unique selector — the schema
// has no `@@unique([id, userId])`, so `update` could not carry `userId` in its
// WHERE without a schema change. A refused write therefore resolves with
// `count: 0` instead of throwing, which is both observable and consistent with
// `updateEmailStatus`.
//
// The predicate is not there to catch today's caller, which derived the owner
// from this very row moments earlier; it is there so a future caller that has
// NOT derived the owner cannot write across tenants.
export const markAttachmentProcessing = async (
  owner: OwnershipContext,
  id: number,
) => {
  return prisma.attachment.updateMany({
    where: { id, userId: owner.userId },
    data: {
      processingStatus: ATTACHMENT_STATUS.PROCESSING,
      processingError: null,
    },
  });
};

export const markAttachmentCompleted = async (
  owner: OwnershipContext,
  id: number,
  storagePath: string,
  processedAt: Date,
) => {
  return prisma.attachment.updateMany({
    where: { id, userId: owner.userId },
    data: {
      processingStatus: ATTACHMENT_STATUS.COMPLETED,
      storagePath,
      processedAt,
      processingError: null,
    },
  });
};

export const markAttachmentFailed = async (
  owner: OwnershipContext,
  id: number,
  reason: string,
) => {
  return prisma.attachment.updateMany({
    where: { id, userId: owner.userId },
    data: {
      processingStatus: ATTACHMENT_STATUS.FAILED,
      processingError: reason,
    },
  });
};

// Persist a successful parse result. Only the parsing columns are written —
// processingStatus (the download lifecycle) is intentionally left untouched, so
// this composes with markAttachmentCompleted rather than replacing it.
export const updateParsedResult = async (
  owner: OwnershipContext,
  id: number,
  parsed: ParsedAttachment,
  parsedAt: Date,
) => {
  return prisma.attachment.updateMany({
    where: { id, userId: owner.userId },
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
export const markParsingFailed = async (
  owner: OwnershipContext,
  id: number,
  reason: string,
) => {
  return prisma.attachment.updateMany({
    where: { id, userId: owner.userId },
    data: {
      parsingError: reason,
    },
  });
};
