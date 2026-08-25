-- G-8.1 — the optional StudentProfile table.
--
-- Purely additive. One new table, two unique indexes on it, one foreign key to
-- User. No existing table is altered, no column is dropped, renamed or made NOT
-- NULL, no existing constraint is replaced, and there is no backfill. Nothing in
-- the application reads or writes this table yet, so applying or reverting it is
-- behaviour-neutral.
--
-- WHY EXISTING USERS STAY VALID.
--
-- The relationship is optional in the direction that matters: StudentProfile
-- requires a User, User requires nothing. Every existing row in "User" is
-- therefore already correct under this schema with no profile row at all, which
-- is why there is no INSERT here and no default profile is manufactured. A user
-- without a registration number is a normal account, not an incomplete one —
-- off-campus opportunities carry no registration number and must remain fully
-- usable without one.
--
-- WHY "registrationNumber" IS NULLABLE AND UNIQUE AT THE SAME TIME.
--
-- These do not conflict in Postgres: a unique index treats NULLs as distinct, so
-- any number of profiles may hold NULL simultaneously and the constraint binds
-- only real values. That is exactly the intent — a profile may exist before its
-- number is known, and may never acquire one.
--
-- The uniqueness itself is a property of THIS DEPLOYMENT, not of the domain.
-- The product currently serves a single college, where a registration number
-- identifies exactly one student. It would not survive a second institution;
-- widening it is a deliberate future change, and this migration deliberately
-- introduces no College/Institution/Campus table to anticipate one.
--
-- WHY ON DELETE CASCADE.
--
-- Matches "GmailAccount", the other child hanging directly off "User": a profile
-- describes a user and has no meaning once that user is gone. "Event" and
-- "EventUpdate" use RESTRICT instead, because they are records a deletion must
-- not silently take with it. A profile carries no such history.
--
-- WHAT THIS IS NOT.
--
-- "registrationNumber" is not an identity, not an ownership key and not a tenant
-- key. "User"."id" remains the sole internal identity and the only ownership
-- boundary. This table is referenced by no other table and references none but
-- "User", so no query for Events, Emails, Attachments or extractions can be made
-- to depend on it.

-- CreateTable
CREATE TABLE "StudentProfile" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "registrationNumber" TEXT,

    CONSTRAINT "StudentProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StudentProfile_userId_key" ON "StudentProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentProfile_registrationNumber_key" ON "StudentProfile"("registrationNumber");

-- AddForeignKey
ALTER TABLE "StudentProfile" ADD CONSTRAINT "StudentProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
