import { upsertUserFromGoogleIdentity, getStudentProfileByUserId, upsertStudentProfileRegistrationNumber, } from "./user.repository.js";
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
    constructor(status) {
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
export const resolveUserFromGoogleIdentity = async (identity) => {
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
// Raised when a registration number is already held by a different user.
//
// Distinguishable from a validation failure so the controller can answer 409
// rather than 400: the value is well-formed, it simply is not available. Carries
// no information about WHO holds it — see the controller.
export class RegistrationNumberTakenError extends Error {
    constructor() {
        super("Registration number is already in use");
        this.name = "RegistrationNumberTakenError";
    }
}
/* Normalize a supplied registration number (G-8.2).
 *
 * Returns the discriminated union the controllers already use for request
 * parsing, so a rejection becomes a 400 with a specific message rather than a
 * PrismaClientValidationError surfacing as a 500.
 *
 * THERE IS DELIBERATELY NO FORMAT VALIDATION. A registration number is issued
 * by an institution, in whatever shape that institution uses — "20231234",
 * "ABC-123" and "BTECH/2023/42" are all real answers to the same question. A
 * format rule here would encode one college's convention as a correctness
 * property and silently refuse a student whose number is perfectly valid. The
 * only thing this layer asserts is the API's own contract: the field is a
 * string, or null.
 *
 * WHAT NORMALIZATION MEANS HERE, and what it deliberately does not.
 *
 * Surrounding whitespace is stripped, because it is invisible in a form field
 * and would otherwise produce two "different" numbers that read identically.
 * An empty string — including a string that was only whitespace — is NOT a
 * value: it is how a form submits a cleared field, so it collapses to `null`.
 * Storing `""` would let both `""` and NULL mean "absent", and only one of them
 * would be excluded from the unique index.
 *
 * Case is NOT folded, and there is no normalized twin column. The stored value
 * is exactly what the user typed, minus the surrounding whitespace, which is
 * what the schema's own note commits to.
 */
export const normalizeRegistrationNumber = (supplied) => {
    // `null` is the explicit "clear it" instruction, and is always valid.
    if (supplied === null) {
        return { ok: true, value: null };
    }
    if (typeof supplied !== "string") {
        return {
            ok: false,
            message: "registrationNumber must be a string or null",
        };
    }
    const trimmed = supplied.trim();
    if (trimmed.length === 0) {
        return { ok: true, value: null };
    }
    return { ok: true, value: trimmed };
};
// Read the caller's profile.
//
// A user with no profile row gets `{ registrationNumber: null }` rather than a
// 404. Not having supplied a registration number is a normal state, not a
// missing resource — answering 404 would tell a perfectly ordinary account that
// something is wrong with it.
export const getStudentProfileService = async (context) => {
    const profile = await getStudentProfileByUserId(context.userId);
    return {
        registrationNumber: profile?.registrationNumber ?? null,
    };
};
// Set or clear the caller's registration number.
//
// `context.userId` is the only thing that decides which row is written; the
// value is the only thing the caller supplies. There is no path from a request
// to another user's profile.
export const updateStudentProfileService = async (context, registrationNumber) => {
    try {
        const profile = await upsertStudentProfileRegistrationNumber(context.userId, registrationNumber);
        return {
            registrationNumber: profile.registrationNumber,
        };
    }
    catch (error) {
        // Recovered from the CONSTRAINT rather than pre-checked with a read, and
        // matched on the specific constraint rather than on any P2002 — the same
        // rule `event.repository`'s conflict handling follows. A `findFirst` before
        // the write would be two statements with a window between them.
        if (isRegistrationNumberConflict(error)) {
            throw new RegistrationNumberTakenError();
        }
        throw error;
    }
};
// A P2002 naming the `registrationNumber` unique index specifically, as opposed
// to the `userId` one the same upsert could in principle report. Modelled as an
// array-of-field-names check because that is the shape Prisma reports for these
// constraints elsewhere in this codebase.
const isRegistrationNumberConflict = (error) => {
    if (typeof error !== "object" ||
        error === null ||
        error.code !== "P2002") {
        return false;
    }
    const target = error.meta?.target;
    return Array.isArray(target) && target.includes("registrationNumber");
};
//# sourceMappingURL=user.service.js.map