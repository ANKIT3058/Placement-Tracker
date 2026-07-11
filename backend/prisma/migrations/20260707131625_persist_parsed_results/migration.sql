-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "parsedAt" TIMESTAMP(3),
ADD COLUMN     "parsedData" JSONB,
ADD COLUMN     "parsedMetadata" JSONB,
ADD COLUMN     "parsingError" TEXT,
ADD COLUMN     "text" TEXT;
