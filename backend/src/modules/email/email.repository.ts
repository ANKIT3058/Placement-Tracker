import { prisma } from "../../lib/prisma.js";
import type { EmailInput } from "./email.types.js";
import type { OwnershipContext } from "../auth/tenant-context.js";

export const createEmail = async (email: EmailInput) => {
  const attachments = email.attachments ?? [];

  // Nested create runs the Email insert and all Attachment inserts inside a
  // single implicit Prisma transaction — either the email and its attachment
  // metadata all persist, or none do. Duplicate emails are guarded upstream in
  // the sync flow (existing gmailMessageId short-circuits before create), so
  // attachment metadata is never inserted twice.
  // Ownership reaches the Attachment rows without being written here. The
  // composite foreign key on Attachment(emailId, userId) -> Email(id, userId)
  // (RFC-001 §12.3) makes both columns relation scalars of the `email`
  // relation, so Prisma omits them from the nested create input and populates
  // them from the parent row it just inserted. Passing `userId` explicitly is
  // now rejected as an unknown argument — and would be redundant anyway, since
  // the constraint already makes disagreement unrepresentable.
  const userId = email.userId;

  return prisma.email.create({
    data: {
      gmailMessageId: email.gmailMessageId,
      gmailAccountId: email.gmailAccountId,
      userId,
      subject: email.subject,
      body: email.body,
      sender: email.sender,
      attachments: attachments.length
        ? {
            create: attachments.map((attachment) => ({
              gmailAttachmentId: attachment.gmailAttachmentId,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              size: attachment.size,
            })),
          }
        : undefined,
    },
  });
};

export const getEmailByGmailMessageId = async (gmailMessageId: string) => {
  return prisma.email.findUnique({
    where: {
      gmailMessageId,
    },
  });
};

// THE OWNERSHIP DERIVATION ROOT — deliberately unscoped.
//
// This is where the pipeline learns who owns a unit of work (RFC-001 §9.5): the
// worker reads the Email and takes `userId` off it. Requiring an owner here
// would be circular — the caller would have to already know the answer this
// call exists to provide, and the only place it could come from is the queue
// payload, which is exactly the untrusted input the derivation replaces.
//
// It is safe because it is not reachable from a request. Its two callers are
// the email worker and the processor beneath it, both keyed by an id that came
// from a job the system enqueued itself.
export const getEmailById = async (id: number) => {
  return prisma.email.findUnique({
    where: {
      id,
    },
  });
};

// Status writes are scoped even though their callers derived the owner from the
// same row moments earlier. The predicate is not there to catch today's callers;
// it is there so that a future caller that has *not* derived the owner cannot
// write across tenants. A refused write returns `count: 0` rather than throwing,
// so it is observable.
export const updateEmailStatus = async (
  owner: OwnershipContext,
  id: number,
  status: string,
) => {
  const result = await prisma.email.updateMany({
    where: {
      id,
      userId: owner.userId,
    },

    data: {
      processingStatus: status,
    },
  });

  if (result.count === 0) {
    // Unreachable while the owner is derived from this same row. If it fires,
    // an ownership invariant has broken rather than a status update failing.
    console.warn(
      `[email] Status update on email ${id} matched no row for owner ${owner.userId}`,
    );
  }

  return result;
};

export const markEmailFailed = async (
  owner: OwnershipContext,
  id: number,
  reason: string,
) => {
  return prisma.email.updateMany({
    where: {
      id,
      userId: owner.userId,
    },

    data: {
      processingStatus: "failed",
      failureReason: reason,
    },
  });
};

// Both currently uncalled. Kept ownership-aware rather than global so that
// whoever builds the retry or backlog view on top of them inherits the tenant
// predicate instead of having to remember it.
export const getFailedEmails = async (owner: OwnershipContext) => {
  return prisma.email.findMany({
    where: {
      userId: owner.userId,
      processingStatus: "failed",
    },
  });
};

export const getPendingEmails = async (owner: OwnershipContext) => {
  return prisma.email.findMany({
    where: {
      userId: owner.userId,
      processingStatus: "pending",
    },
  });
};
