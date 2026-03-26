-- CreateTable
CREATE TABLE "EmailExtraction" (
    "id" SERIAL NOT NULL,
    "company" TEXT,
    "stage" TEXT,
    "date" TIMESTAMP(3),
    "time" TEXT,
    "venue" TEXT,
    "isTimeEstimated" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "status" TEXT,
    "rawText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailExtraction_pkey" PRIMARY KEY ("id")
);
