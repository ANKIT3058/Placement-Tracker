/*
  Warnings:

  - You are about to drop the column `downloadError` on the `Attachment` table. All the data in the column will be lost.
  - You are about to drop the column `downloadStatus` on the `Attachment` table. All the data in the column will be lost.
  - You are about to drop the column `downloadedAt` on the `Attachment` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Attachment" DROP COLUMN "downloadError",
DROP COLUMN "downloadStatus",
DROP COLUMN "downloadedAt",
ADD COLUMN     "processedAt" TIMESTAMP(3),
ADD COLUMN     "processingError" TEXT,
ADD COLUMN     "processingStatus" TEXT NOT NULL DEFAULT 'pending';

-- AlterTable
ALTER TABLE "Email" ADD COLUMN     "gmailAccountId" INTEGER;

-- CreateIndex
CREATE INDEX "Email_gmailAccountId_idx" ON "Email"("gmailAccountId");

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_gmailAccountId_fkey" FOREIGN KEY ("gmailAccountId") REFERENCES "GmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
