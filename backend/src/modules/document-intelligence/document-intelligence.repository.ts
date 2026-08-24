import { prisma } from "../../lib/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { OwnershipContext } from "../auth/tenant-context.js";
import type { DocumentInsights } from "./document-insights.types.js";

// Coerce an optional DocumentInsights slice into a Prisma JSON input.
//
// An absent slice is written as SQL NULL (`DbNull`), never as a JSON `null`
// literal and never as `undefined`. The same helper, for the same reason, as
// `toJsonInput` in attachment.repository: NULL is how this schema says "nothing
// of this kind was understood", and it must be written explicitly — see the
// note on the update branch below for why `undefined` would be a defect here.
const toJsonInput = (
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  value === undefined || value === null
    ? Prisma.DbNull
    : (value as Prisma.InputJsonValue);

// Write the Document Intelligence understanding of one attachment, exactly once.
//
// An upsert resolved on `@@unique([attachmentId, userId])`, not a `findFirst`
// followed by a conditional `create`. Those are two statements with a window
// between them, and attachment processing is genuinely replayed: the job caries
// `attempts: 3`, BullMQ's stalled checker returns an abandoned job to `wait`,
// and DocumentProcessingService's already-completed guard sits BEFORE the parse
// step — so this write is reachable more than once for a single attachment. The
// database constraint is the concurrency authority; the upsert is how a replay
// converges on one row instead of appending a second.
//
// LATEST WINS, deliberately, rather than first-write-wins. Classification and
// both extractors are non-deterministic model calls, so a replay can legitimately
// produce a different answer; the row should describe the attempt that actually
// completed, not the one that crashed part-way through. This is the same
// convention, and the same reasoning, as `createExtraction`.
//
// `update` therefore sends explicit values for every mutable field, including
// `DbNull` for an absent slice. Prisma reads `undefined` as "leave this column
// alone", which would let a replay that understood LESS — a provider outage
// degrading classification to `unknown` with no extraction — silently retain the
// previous attempt's `eventInformation` and leave the row describing neither run.
//
// `attachmentId` and `userId` are absent from `update` on purpose: they are the
// row's identity and the selector already fixes them. `createdAt` is absent for
// the same class of reason — it records when the attachment was first
// understood, and a replay is not a new understanding. `extractedAt` moves
// forward on every successful write, which is what distinguishes the two.
//
// Database errors are deliberately NOT caught. A failed write is a real failure
// and the caller decides what it means; swallowing it here would report a
// successful understanding that was never persisted. (The fail-soft policy for
// G-6 lives at the call site, which does not exist yet.)
export const saveDocumentIntelligence = async (
  owner: OwnershipContext,
  attachmentId: number,
  insights: DocumentInsights,
  extractedAt: Date,
) => {
  const fields = {
    classification: insights.classification,
    classificationConfidence: insights.confidence,
    summary: insights.summary,
    eventInformation: toJsonInput(insights.eventInformation),
    participantInformation: toJsonInput(insights.participantInformation),
    extractedAt,
  };

  return prisma.documentIntelligence.upsert({
    where: {
      attachmentId_userId: {
        attachmentId,
        userId: owner.userId,
      },
    },

    create: {
      attachmentId,
      userId: owner.userId,
      ...fields,
    },

    update: fields,
  });
};
