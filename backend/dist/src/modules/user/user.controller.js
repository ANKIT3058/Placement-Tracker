import { requireTenantContext } from "../auth/tenant-context.js";
import { getShortlistParticipationService } from "./student-participation.service.js";
import { getStudentProfileService, updateStudentProfileService, normalizeRegistrationNumber, RegistrationNumberTakenError, } from "./user.service.js";
// The caller's own student profile (G-8.2).
//
// THE PROFILE IS ADDRESSED BY THE SESSION, NOT BY A PATH PARAMETER. Neither
// handler reads an id from the URL, the query string or the body: the only
// input to "whose profile" is `requireTenantContext(req)`, which derives it from
// `req.user` and throws if the route was mounted without `requireAuth`. There is
// therefore no id a caller could substitute to reach someone else's row, and the
// profile's own `id` is never returned — offering it would create a second way
// to name a record that has exactly one legitimate address.
//
// REGISTRATION NUMBERS ARE NEVER LOGGED. A registration number identifies a real
// student to their institution, so it is personal information under the same
// rule that removed email subjects from worker logs and reduced Gmail errors to
// an allowlist (RFC-001 §13.2). The catch blocks below log the failure and the
// caller's internal id; the value that failed is deliberately absent, including
// from validation messages, which state the expected shape instead of echoing
// what was rejected.
// The one field this endpoint accepts. Stated as an allowlist so an unexpected
// field is refused rather than silently ignored — the same parse-before-Prisma
// convention `parseManualEventUpdate` follows.
const ALLOWED_FIELDS = ["registrationNumber"];
const parseProfileUpdate = (body) => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return { ok: false, message: "Request body must be an object" };
    }
    const received = body;
    const unsupported = Object.keys(received).filter((key) => !ALLOWED_FIELDS.includes(key));
    if (unsupported.length > 0) {
        return {
            ok: false,
            message: `Unsupported field(s): ${unsupported.join(", ")}. Only ${ALLOWED_FIELDS.join(", ")} can be edited.`,
        };
    }
    // ABSENT AND EXPLICITLY NULL ARE DIFFERENT INSTRUCTIONS, and this is where
    // PATCH earns its verb. `null` says "clear it"; omitting the field says
    // nothing about it at all, so the stored value is left exactly as it was.
    // Reading an omission as a clear would let a partial update silently destroy
    // data the caller never mentioned.
    if (!("registrationNumber" in received)) {
        return { ok: true, update: null };
    }
    const normalized = normalizeRegistrationNumber(received.registrationNumber);
    if (!normalized.ok) {
        return { ok: false, message: normalized.message };
    }
    return { ok: true, update: { registrationNumber: normalized.value } };
};
// GET /user/profile
//
// A user who has never supplied a registration number is answered 200 with
// `null`, not 404: having no profile row is an ordinary state of a perfectly
// functional account, and off-campus use never requires one.
export const getStudentProfileController = async (req, res) => {
    try {
        const context = requireTenantContext(req);
        const profile = await getStudentProfileService(context);
        return res.json({
            success: true,
            profile,
        });
    }
    catch (error) {
        console.error("[user] Failed to read student profile", {
            userId: req.user?.id,
            reason: error instanceof Error ? error.message : "Unknown error",
        });
        return res.status(500).json({
            success: false,
            message: "Failed to read student profile",
        });
    }
};
// PATCH /user/profile
export const updateStudentProfileController = async (req, res) => {
    try {
        const context = requireTenantContext(req);
        const parsed = parseProfileUpdate(req.body);
        if (!parsed.ok) {
            return res.status(400).json({
                success: false,
                message: parsed.message,
            });
        }
        // A request that names no change performs no write. Reading the current
        // profile instead keeps the response shape identical while leaving the row
        // — and, for a user who has none, its absence — exactly as it was: an empty
        // PATCH must not be what creates a profile.
        const profile = parsed.update === null
            ? await getStudentProfileService(context)
            : await updateStudentProfileService(context, parsed.update.registrationNumber);
        return res.json({
            success: true,
            profile,
        });
    }
    catch (error) {
        // 409, and deliberately vague. The number is well-formed but held by
        // another account, and saying so is unavoidable — the caller must be told
        // their write did not happen. What must NOT leak is who holds it: this
        // endpoint would otherwise let anyone test registration numbers against the
        // user base one request at a time.
        if (error instanceof RegistrationNumberTakenError) {
            return res.status(409).json({
                success: false,
                message: "That registration number is already in use",
            });
        }
        console.error("[user] Failed to update student profile", {
            userId: req.user?.id,
            reason: error instanceof Error ? error.message : "Unknown error",
        });
        return res.status(500).json({
            success: false,
            message: "Failed to update student profile",
        });
    }
};
// GET /user/shortlists
//
// Which of the caller's own shortlists list their registration number (G-8.4).
//
// A READ, and only a read. It writes nothing, mutates no Event and changes no
// extraction — it reports on facts two earlier milestones already persisted.
//
// A caller who has set no registration number is answered 200 with an empty
// result, not 404 and not an error: having no number is an ordinary state, and
// this feature is exactly as optional as the field it reads.
//
// The response carries attachment ids the caller already owns and nothing else.
// A shortlist names other students; no participant attribute — not even the
// caller's own — is included, so there is nothing here to leak.
export const getShortlistParticipationController = async (req, res) => {
    try {
        const context = requireTenantContext(req);
        const participation = await getShortlistParticipationService(context);
        return res.json({
            success: true,
            participation,
        });
    }
    catch (error) {
        console.error("[user] Failed to read shortlist participation", {
            userId: req.user?.id,
            reason: error instanceof Error ? error.message : "Unknown error",
        });
        return res.status(500).json({
            success: false,
            message: "Failed to read shortlist participation",
        });
    }
};
//# sourceMappingURL=user.controller.js.map