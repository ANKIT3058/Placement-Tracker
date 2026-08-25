import { prisma } from "../../lib/prisma.js";
import { DOCUMENT_TYPE } from "./document-type.js";
import type { OwnershipContext } from "../auth/tenant-context.js";

/* Reading shortlist understandings, for the participation lookup (G-8.4).
 *
 * A SEPARATE FILE FROM `document-intelligence.repository`, and the separation is
 * load-bearing rather than tidiness.
 *
 * That module imports the GENERATED Prisma client directly, for the
 * `Prisma.DbNull` sentinel its write path needs. The generated client is
 * ESM-only — it uses `import.meta` — which the CommonJS transform ts-jest
 * applies cannot parse. Adding this read there would put that import on the
 * module graph reachable from `app.ts`, and every API suite in the codebase
 * would stop being able to load the app: not because of anything they do, but
 * because a route they never call reaches a file they cannot compile.
 *
 * This is the same class of failure CONTRIBUTING records for the `ai/` cycle —
 * harmless in production, fatal under the test transform, and surfacing in
 * suites that have nothing to do with the change. Keeping the read here means it
 * imports `lib/prisma` (which every test already mocks) and nothing else.
 *
 * Read-only. G-8.4 writes nothing to this table; the write path stays exactly
 * where it was.
 */

/* The caller's own shortlist understandings.
 *
 * TENANT-SCOPED IN THE QUERY, not after it. `DocumentIntelligence.userId` is the
 * tenant key, and the composite foreign key to `Attachment(id, userId)` is what
 * makes it unable to disagree with the owning attachment's owner — so this
 * reaches exactly the documents derived from this user's own attachments.
 * Reading globally and filtering in memory would put another tenant's
 * participant data in this process for no reason.
 *
 * `classification` narrows to shortlists because that is the only question
 * G-8.4 answers. Seating arrangements and result sheets also carry
 * participants, and both are deliberately out of scope.
 *
 * SELECTS THE MINIMUM. `participantInformation` answers the question and
 * `attachmentId` says which document answered it. `summary` is deliberately
 * absent: it is a generated synopsis of a document that lists other students, so
 * it is exactly the field that could carry their names into a response meant to
 * contain none.
 */
export const getShortlistIntelligenceForUser = async (
  owner: OwnershipContext,
) => {
  return prisma.documentIntelligence.findMany({
    where: {
      userId: owner.userId,
      classification: DOCUMENT_TYPE.SHORTLIST,
    },
    select: {
      attachmentId: true,
      participantInformation: true,
    },
  });
};
