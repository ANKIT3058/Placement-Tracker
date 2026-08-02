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
