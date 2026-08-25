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

// Attachments whose durable state says the pipeline is unfinished, for the
// background reconciler (G-7.3).
//
// Global, deliberately, and for the same reason `getStalePendingEmails` is:
// this runs as background work with no caller to derive a tenant from. Tenant
// safety is not weakened by that, because the queue payload stays
// `{ attachmentId }` and the worker derives the owner from the row it loads —
// so ownership travels with the row rather than with a fabricated context.
//
// SEPARATE FROM `getPendingAttachmentsByEmailId`, never a widening of it. That
// one serves the normal enqueue path and must keep its `not: completed` filter;
// this one must select `completed` rows, which is precisely the case that one
// excludes.
//
// THE PREDICATE, and why each branch is there:
//
//   pending    — persisted but the enqueue may never have run, or Redis lost
//                the job. The email-reconciler case.
//   processing — a worker claimed it and no longer exists.
//   completed AND parsedAt IS NULL AND parsingError IS NULL
//              — the G-7.1 crash window: the download committed, the parse never
//                did. Nothing else can reach this row, because the normal
//                enqueue filter excludes `completed`.
//
// `failed` is deliberately ABSENT. Those rows always have a job, and
// `removeOnFail: false` retains its hash permanently, so `add` is a silent
// no-op — selecting them would be a loop that looks like work and accomplishes
// nothing. This is the same reasoning that keeps `failed` out of the email
// sweep.
//
// A DELIBERATE SUPERSET. The third branch also matches a healthy job that is
// mid-parse right now, and a completed download whose MIME type has no parser.
// Neither is filtered here: the first is absorbed by the deterministic job id,
// and the second is removed by the parser registry in the reconciler, because
// the registry is the only thing allowed to decide MIME-to-parser routing — a
// MIME list in this query would be a second authority on that.
//
// `createdAt` is the cutoff column because it is immutable: no code writes it
// after insert, so an orphan can never age out of this result by having its
// timestamp refreshed. `Attachment` does carry an `@updatedAt`, which would be
// more precise, but it can be moved by any future writer — the same trade-off
// `getStalePendingEmails` resolves the same way.
//
// Ordered oldest-first and bounded by `take`, so a standing backlog is drained
// in a stable order across sweeps rather than re-scanning the same head.
export const getStaleUnfinishedAttachments = async (
  olderThan: Date,
  take: number,
) => {
  return prisma.attachment.findMany({
    where: {
      createdAt: { lt: olderThan },
      OR: [
        {
          processingStatus: {
            in: [ATTACHMENT_STATUS.PENDING, ATTACHMENT_STATUS.PROCESSING],
          },
        },
        {
          processingStatus: ATTACHMENT_STATUS.COMPLETED,
          parsedAt: null,
          parsingError: null,
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take,
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
