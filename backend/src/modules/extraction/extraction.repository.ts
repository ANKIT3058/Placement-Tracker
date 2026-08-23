import { prisma } from "../../lib/prisma.js";
import type { OwnershipContext } from "../auth/tenant-context.js";

interface CreateExtractionInput {
  emailId: number;

  // Owner, copied from the Email this extraction was derived from. They must
  // agree, and as of AC-5.9 a composite foreign key to Email(id, userId)
  // rejects the write outright if they do not (RFC-001 §12.3).
  userId: number;

  company?: string;
  stage?: string;
  date?: Date;
  time?: string;
  venue?: string | null;

  isTimeEstimated?: boolean;
  status?: string;

  confidence: number;

  rawText?: string;
}

// Write the extraction for an email, exactly once (PR-9G).
//
// An upsert rather than a create, resolved on `@@unique([emailId, userId])`. The
// email-processing job is replayed whenever the worker dies holding its BullMQ
// lock, and this is the only write in that path that was not already
// retry-safe — every other write is either idempotent, constraint-protected, or
// guarded by a state comparison.
//
// LATEST WINS, deliberately, rather than first-write-wins. With `USE_AI=true`
// extraction is nondeterministic, so a replay can legitimately produce a
// different answer; the row should describe the attempt that actually completed,
// not the one that crashed part-way through.
//
// `update` therefore sends explicit nulls instead of the input's `undefined`.
// Prisma reads `undefined` as "leave this column alone", which would let a
// replay that extracted *less* keep a stale value from the previous attempt and
// leave the row describing neither run. Every one of these columns is nullable,
// so `?? null` is representable for all of them.
//
// `emailId` and `userId` are absent from `update` on purpose: they are the
// row's identity and the selector already fixes them. `createdAt` is absent for
// the same class of reason — it records when the extraction first appeared, and
// a replay is not a new extraction.
export const createExtraction = async (data: CreateExtractionInput) => {
  const { emailId, userId, ...fields } = data;

  return prisma.emailExtraction.upsert({
    where: {
      emailId_userId: {
        emailId,
        userId,
      },
    },

    create: data,

    update: {
      company: fields.company ?? null,
      stage: fields.stage ?? null,
      date: fields.date ?? null,
      time: fields.time ?? null,
      venue: fields.venue ?? null,
      isTimeEstimated: fields.isTimeEstimated ?? null,
      status: fields.status ?? null,
      confidence: fields.confidence,
      rawText: fields.rawText ?? null,
    },
  });
};

// Currently uncalled. Scoped on both `emailId` and owner rather than `emailId`
// alone: an id from a request is caller-supplied, and a lookup keyed only on it
// reads another tenant's extractions for anyone who guesses a number.
export const getExtractionsForEmail = async (
  owner: OwnershipContext,
  emailId: number,
) => {
  return prisma.emailExtraction.findMany({
    where: {
      emailId,
      userId: owner.userId,
    },
  });
};
