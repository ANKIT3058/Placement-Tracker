/*
  Warnings:

  - You are about to drop the column `companyName` on the `EmailExtraction` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "EmailExtraction" DROP COLUMN "companyName",
ADD COLUMN     "company" TEXT;
