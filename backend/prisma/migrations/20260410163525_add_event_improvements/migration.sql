/*
  Warnings:

  - You are about to drop the column `company` on the `EmailExtraction` table. All the data in the column will be lost.
  - You are about to drop the column `isTimeEstimated` on the `EmailExtraction` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `EmailExtraction` table. All the data in the column will be lost.
  - You are about to drop the column `venue` on the `EmailExtraction` table. All the data in the column will be lost.
  - Made the column `confidence` on table `EmailExtraction` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `updatedAt` to the `Event` table without a default value. This is not possible if the table is not empty.
  - Made the column `confidence` on table `Event` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "EventUpdate" DROP CONSTRAINT "EventUpdate_eventId_fkey";

-- AlterTable
ALTER TABLE "EmailExtraction" DROP COLUMN "company",
DROP COLUMN "isTimeEstimated",
DROP COLUMN "status",
DROP COLUMN "venue",
ADD COLUMN     "companyName" TEXT,
ALTER COLUMN "confidence" SET NOT NULL,
ALTER COLUMN "rawText" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "isTimeEstimated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewReason" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "confidence" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "EventUpdate" ADD CONSTRAINT "EventUpdate_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
