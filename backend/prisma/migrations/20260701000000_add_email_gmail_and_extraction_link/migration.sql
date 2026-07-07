-- Baseline-gap migration.
--
-- The Email, GmailAccount tables and the EmailExtraction.emailId link were
-- originally created with `prisma db push`, so no migration ever recorded them.
-- This migration reproduces that state so the migration history replays cleanly
-- from scratch (required for the shadow database) and so `20260702000000_add_attachments`
-- has an "Email" table to reference.

-- CreateTable
CREATE TABLE "GmailAccount" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "historyId" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GmailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GmailAccount_email_key" ON "GmailAccount"("email");

-- CreateTable
CREATE TABLE "Email" (
    "id" SERIAL NOT NULL,
    "gmailMessageId" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingStatus" TEXT NOT NULL DEFAULT 'pending',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Email_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Email_gmailMessageId_key" ON "Email"("gmailMessageId");

-- AlterTable
ALTER TABLE "EmailExtraction" ADD COLUMN "emailId" INTEGER NOT NULL;

-- AddForeignKey
ALTER TABLE "EmailExtraction" ADD CONSTRAINT "EmailExtraction_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE CASCADE ON UPDATE CASCADE;
