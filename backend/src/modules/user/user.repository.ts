import { prisma } from "../../lib/prisma.js";
import type { GoogleIdentity } from "./user.types.js";

// Read the current state of a User by internal id.
//
// Called on every authenticated request, deliberately. The session stores a
// `userId`, not a snapshot, precisely so that disabling or deleting a User takes
// effect on their next request rather than on their next login (RFC-001 §11.1).
// Caching this would reintroduce exactly the staleness the session shape avoids.
export const getUserById = async (id: number) => {
  return prisma.user.findUnique({
    where: {
      id,
    },
  });
};

// Find-or-create keyed on `googleSub`, expressed as a single upsert rather than
// a read followed by a conditional write. Two concurrent callbacks for the same
// identity — a double-clicked consent screen is enough — would both miss on the
// read and both attempt an insert, and the second would fail on the unique
// constraint. The upsert resolves that in one statement.
//
// The profile fields are refreshed on every pass because Google is the source of
// truth for them and they drift (renamed accounts, changed avatars). `status` is
// deliberately not written: it is operational state owned by this system, and a
// login must never resurrect a disabled User.
export const upsertUserFromGoogleIdentity = async (identity: GoogleIdentity) => {
  const profile = {
    email: identity.email,
    emailVerified: identity.emailVerified,
    name: identity.name,
    imageUrl: identity.imageUrl,
    lastLoginAt: new Date(),
  };

  return prisma.user.upsert({
    where: {
      googleSub: identity.googleSub,
    },
    create: {
      googleSub: identity.googleSub,
      ...profile,
    },
    update: profile,
  });
};

// The caller's StudentProfile, addressed by the owner's internal id (G-8.2).
//
// Keyed on `userId`, never on `StudentProfile.id`. The profile row's own id is
// not an addressing mechanism and is never accepted from a request: the only way
// to reach a profile is to already be the user it belongs to. `userId` is unique,
// so this returns at most one row.
//
// A user with no profile row is a normal account, so `null` here is an ordinary
// outcome and not an error.
export const getStudentProfileByUserId = async (userId: number) => {
  return prisma.studentProfile.findUnique({
    where: {
      userId,
    },
  });
};

// Set or clear the caller's registration number, creating the profile row on
// first use (G-8.2).
//
// An upsert rather than a read followed by a conditional write, matching
// `upsertUserFromGoogleIdentity` above and for the same reason: two concurrent
// requests would both miss on the read and the second insert would fail on the
// unique constraint. One statement resolves that.
//
// `userId` is supplied by the caller's session, never by the request body, so
// the WHERE predicate here is the ownership boundary — there is no id a caller
// could substitute to address someone else's row.
//
// A P2002 on `registrationNumber` propagates deliberately. It means the number
// belongs to another user, which the service turns into a refusal; swallowing it
// here would silently drop the write.
export const upsertStudentProfileRegistrationNumber = async (
  userId: number,
  registrationNumber: string | null,
) => {
  return prisma.studentProfile.upsert({
    where: {
      userId,
    },
    create: {
      userId,
      registrationNumber,
    },
    update: {
      registrationNumber,
    },
  });
};
