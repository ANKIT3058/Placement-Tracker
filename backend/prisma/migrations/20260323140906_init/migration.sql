-- CreateTable
CREATE TABLE "Event" (
    "id" SERIAL NOT NULL,
    "company" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "eventKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Event_eventKey_key" ON "Event"("eventKey");
