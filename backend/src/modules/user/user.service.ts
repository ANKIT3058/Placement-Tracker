import { upsertUserFromGoogleIdentity } from "./user.repository.js";
import type { GoogleIdentity } from "./user.types.js";

// Distinguishable failures, so the controller can answer "we refuse this
// identity" (403) separately from "something broke" (500). Both are refusals of
// a well-formed, correctly signed token, which is why neither is an Error the
// caller should retry.
export class UnverifiedGoogleIdentityError extends Error {
  constructor() {
    super("Google identity has an unverified email address");
    this.name = "UnverifiedGoogleIdentityError";
  }
}

export class InactiveUserError extends Error {
  constructor(status: string) {
    super(`User is not active (status: ${status})`);
    this.name = "InactiveUserError";
  }
}

// Resolve a verified Google identity to the User that owns it, creating that
// User on first sight.
//
// This is identity resolution only. It establishes *who* the caller is; it does
// not make them authenticated, because no session exists yet (AC-5.4). Nothing
// downstream may treat the returned User as an authenticated principal.
export const resolveUserFromGoogleIdentity = async (
  identity: GoogleIdentity,
) => {
  // An unverified address is refused before any write. Accepting one would let
  // an identity be created around an address the holder has not proven they
  // control, and a later verified login for the same address could not safely
  // be merged into it (RFC-001 §8.1).
  if (!identity.emailVerified) {
    throw new UnverifiedGoogleIdentityError();
  }

  const user = await upsertUserFromGoogleIdentity(identity);

  // Checked after the upsert rather than before: the write is idempotent and
  // harmless, and reading first would add a round trip to every login to guard
  // a state that is not self-service reachable (RFC-001 §8.3).
  if (user.status !== "active") {
    throw new InactiveUserError(user.status);
  }

  return user;
};
