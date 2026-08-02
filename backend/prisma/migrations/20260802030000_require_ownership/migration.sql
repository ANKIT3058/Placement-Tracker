-- AC-5.9 — Ownership enforcement (RFC-001 §19 Phase 4).
--
-- Depends on 20260802020000_backfill_ownership having succeeded. That migration
-- aborts rather than leaving a partial result, so if it ran, every row here
-- already satisfies every constraint below.
--
-- What changes:
--   * `userId` becomes NOT NULL on all six tenant-scoped tables.
--   * (id, userId) anchors are added so children can reference a parent and its
--     owner together.
--   * Child relations become composite foreign keys on (parentId, userId),
--     which makes a child disagreeing with its parent's owner unrepresentable
--     rather than merely incorrect (RFC-001 §12.3).
--   * `Event.eventKey` stops being globally unique and becomes unique per owner
--     (RFC-001 §7.4). Global uniqueness would mean two students receiving the
--     same placement broadcast could not both hold an Event for it — the
--     second would silently resolve to the first's record.
--
-- What deliberately does NOT change:
--   * `Email.gmailMessageId` keeps its global unique constraint. Replacing it
--     with (gmailAccountId, gmailMessageId) requires `gmailAccountId` to be
--     reliably populated, and rows predating account tracking have NULL there.
--     Scoping the dedupe lookup before those rows are resolved would re-ingest
--     them. It moves together with the manual ingestion route, in AC-5.13.
--
-- `Email.gmailAccountId` remains nullable, so its composite foreign key is
-- MATCH SIMPLE: a NULL mailbox leaves that row's constraint unchecked, which is
-- the intended behaviour for emails that never came from a mailbox.


-- DropForeignKey
ALTER TABLE "Event" DROP CONSTRAINT "Event_userId_fkey";

-- DropForeignKey
ALTER TABLE "EventUpdate" DROP CONSTRAINT "EventUpdate_userId_fkey";

-- DropForeignKey
ALTER TABLE "EventUpdate" DROP CONSTRAINT "EventUpdate_eventId_fkey";

-- DropForeignKey
ALTER TABLE "Email" DROP CONSTRAINT "Email_userId_fkey";

-- DropForeignKey
ALTER TABLE "Email" DROP CONSTRAINT "Email_gmailAccountId_fkey";

-- DropForeignKey
ALTER TABLE "Attachment" DROP CONSTRAINT "Attachment_emailId_fkey";

-- DropForeignKey
ALTER TABLE "EmailExtraction" DROP CONSTRAINT "EmailExtraction_emailId_fkey";

-- DropIndex
DROP INDEX "Event_eventKey_key";

-- AlterTable
ALTER TABLE "Event" ALTER COLUMN "userId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EventUpdate" ALTER COLUMN "userId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Email" ALTER COLUMN "userId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Attachment" ALTER COLUMN "userId" SET NOT NULL;

-- AlterTable
ALTER TABLE "EmailExtraction" ALTER COLUMN "userId" SET NOT NULL;

-- AlterTable
ALTER TABLE "GmailAccount" ALTER COLUMN "userId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Event_userId_eventKey_key" ON "Event"("userId", "eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "Event_id_userId_key" ON "Event"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Email_id_userId_key" ON "Email"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "GmailAccount_id_userId_key" ON "GmailAccount"("id", "userId");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventUpdate" ADD CONSTRAINT "EventUpdate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventUpdate" ADD CONSTRAINT "EventUpdate_eventId_userId_fkey" FOREIGN KEY ("eventId", "userId") REFERENCES "Event"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_gmailAccountId_userId_fkey" FOREIGN KEY ("gmailAccountId", "userId") REFERENCES "GmailAccount"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_emailId_userId_fkey" FOREIGN KEY ("emailId", "userId") REFERENCES "Email"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailExtraction" ADD CONSTRAINT "EmailExtraction_emailId_userId_fkey" FOREIGN KEY ("emailId", "userId") REFERENCES "Email"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

