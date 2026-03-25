-- CreateTable
CREATE TABLE "EventUpdate" (
    "id" SERIAL NOT NULL,
    "eventId" INTEGER NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT NOT NULL,
    "newValue" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventUpdate_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "EventUpdate" ADD CONSTRAINT "EventUpdate_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
