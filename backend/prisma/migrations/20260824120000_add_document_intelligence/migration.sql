-- G-6.1 — persistence for the Document Intelligence layer.
--
-- Purely additive. One new table, one new unique index on an existing table,
-- one foreign key. No column is dropped, renamed or made NOT NULL, no existing
-- constraint is replaced, and there is no backfill. Nothing in the application
-- reads or writes this table yet — Document Intelligence is still unwired
-- (G-6) — so applying or reverting this is behaviour-neutral.
--
-- WHY THE Attachment INDEX.
--
-- `DocumentIntelligence` references its parent as (attachmentId, userId) rather
-- than by attachmentId alone, so that a row whose owner disagrees with its
-- Attachment's owner is unrepresentable rather than merely incorrect
-- (RFC-001 §12.3). A composite foreign key requires a matching unique
-- constraint on the referenced side, and Attachment did not have one — Email,
-- Event and GmailAccount all gained theirs in 20260802030000_require_ownership
-- because they had children; Attachment did not until now.
--
-- It cannot fail on existing data: `id` is already the primary key, so
-- (id, userId) is unique by construction for every row that exists.
--
-- WHY THE COMPOSITE UNIQUE ON DocumentIntelligence.
--
-- Attachment processing is replayed whenever the worker dies holding its BullMQ
-- lock (attempts: 3, plus the stalled-job checker), and the existing
-- already-completed guard in DocumentProcessingService sits BEFORE the parse
-- step — so the intelligence write is reachable more than once for one
-- attachment. The write is therefore an upsert resolved on this key, and this
-- constraint is what makes a replay converge on one row instead of appending a
-- second. The same guarantee EmailExtraction gets from
-- `@@unique([emailId, userId])`, for the same reason.
--
-- Composite with `userId` rather than keyed on `attachmentId` alone: the parent
-- relation is composite, and keyed on the attachment alone one tenant's replay
-- could address another tenant's row.

-- CreateTable
CREATE TABLE "DocumentIntelligence" (
    "id" SERIAL NOT NULL,
    "attachmentId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "classification" TEXT NOT NULL,
    "classificationConfidence" DOUBLE PRECISION NOT NULL,
    "summary" TEXT NOT NULL,
    "eventInformation" JSONB,
    "participantInformation" JSONB,
    "extractedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentIntelligence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_id_userId_key" ON "Attachment"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIntelligence_attachmentId_userId_key" ON "DocumentIntelligence"("attachmentId", "userId");

-- AddForeignKey
ALTER TABLE "DocumentIntelligence" ADD CONSTRAINT "DocumentIntelligence_attachmentId_userId_fkey" FOREIGN KEY ("attachmentId", "userId") REFERENCES "Attachment"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
