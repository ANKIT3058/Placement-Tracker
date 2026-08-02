-- AC-5.1 — User Domain Foundation (RFC-001 §12.1, migration Phase 1 "Expand").
--
-- Additive only. Creates one new table and its indexes. No existing table is
-- altered, no column is dropped, renamed or made NOT NULL, and no existing
-- unique constraint is replaced. Nothing in the application reads or writes
-- this table yet, so applying or reverting it is behaviour-neutral.
--
-- `publicId` and `googleSub` are UNIQUE; `email` is deliberately only indexed,
-- never unique — identity is keyed on the immutable Google subject, and email
-- is a mutable, reassignable attribute (RFC-001 §8.1).

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "publicId" TEXT NOT NULL,
    "googleSub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "imageUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_publicId_key" ON "User"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");
