-- AC-5.2 — Nullable ownership columns and relations (RFC-001 §12.2, §19 Phase 1 "Expand").
--
-- Additive only. Adds one enum type, seven columns, six indexes and four foreign
-- keys. No column is dropped, renamed or made NOT NULL; no existing unique
-- constraint is replaced. `Event.eventKey` and `Email.gmailMessageId` keep their
-- current global uniqueness — replacing those is AC-5.10.
--
-- Every `userId` is nullable and every existing row will hold NULL. No code
-- reads or writes these columns yet, so behaviour is unchanged. AC-5.10
-- backfills them, makes them NOT NULL, and attaches the composite foreign keys
-- that make tenant divergence unrepresentable (RFC-001 §12.3).
--
-- `GmailAccount.provider` is NOT NULL with a DEFAULT, which is deliberate: the
-- default is what lets this migration add the column without a backfill
-- (RFC-001 §12.2). On PostgreSQL 11+ this does not rewrite the table.
--
-- Note on CREATE INDEX: RFC-001 §19 Phase 1 asks for CONCURRENTLY. Prisma
-- executes each migration inside a transaction and CONCURRENTLY cannot run in
-- one, so these are plain CREATE INDEX. The tables are small and the lock is
-- brief. Where it matters — the unique indexes AC-5.10 adds to populated tables
-- — that migration needs an out-of-band step.

-- CreateEnum
CREATE TYPE "MailProvider" AS ENUM ('GOOGLE');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "userId" INTEGER;

-- AlterTable
ALTER TABLE "EventUpdate" ADD COLUMN     "userId" INTEGER;

-- AlterTable
ALTER TABLE "Email" ADD COLUMN     "userId" INTEGER;

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "userId" INTEGER;

-- AlterTable
ALTER TABLE "EmailExtraction" ADD COLUMN     "userId" INTEGER;

-- AlterTable
ALTER TABLE "GmailAccount" ADD COLUMN     "provider" "MailProvider" NOT NULL DEFAULT 'GOOGLE',
ADD COLUMN     "userId" INTEGER;

-- CreateIndex
CREATE INDEX "Event_userId_date_idx" ON "Event"("userId", "date");

-- CreateIndex
CREATE INDEX "Event_userId_status_idx" ON "Event"("userId", "status");

-- CreateIndex
CREATE INDEX "EventUpdate_userId_eventId_idx" ON "EventUpdate"("userId", "eventId");

-- CreateIndex
CREATE INDEX "Email_userId_receivedAt_idx" ON "Email"("userId", "receivedAt");

-- CreateIndex
CREATE INDEX "Email_userId_processingStatus_idx" ON "Email"("userId", "processingStatus");

-- CreateIndex
CREATE INDEX "GmailAccount_userId_idx" ON "GmailAccount"("userId");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventUpdate" ADD CONSTRAINT "EventUpdate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GmailAccount" ADD CONSTRAINT "GmailAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
