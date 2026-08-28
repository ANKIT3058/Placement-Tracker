import { getUserById } from "../user/user.repository.js";
import { destroySession, isSessionExpired } from "./session.service.js";
import "./auth.types.js";
import "./session.types.js";
// One response for every authentication failure, with no detail about which
// check failed (RFC-001 §9.4).
//
// Distinguishing "no session" from "session expired" from "account disabled"
// tells an unauthenticated caller whether a session id was real and whether an
// account exists behind it. The reason is logged server-side instead, where it
// is useful and not disclosed.
const refuse = (res) => {
    return res.status(401).json({
        success: false,
        message: "Authentication required",
    });
};
// Authentication. Resolves *who is calling* and nothing else.
//
// It does not decide what the caller may reach — that is authorization, and per
// RFC-001 §6.2 P4 the two must not be conflated in one mechanism. Ownership is
// enforced at the persistence boundary by a tenant predicate (AC-5.7, AC-5.9),
// not here and not by a role check.
//
// Nothing is trusted except the server-side session. The cookie carries a signed
// identifier and no claims; every fact about the caller is read from Redis and
// then from PostgreSQL. A `userId` in a header, query string, or body is not an
// input to this function and never will be.
//
// This is the single entry point all future authorization builds on: anything
// that needs to know the caller reads `req.user`, which exists only if every
// check below passed.
export const requireAuth = async (req, res, next) => {
    const userId = req.session?.userId;
    // No session, or a session that was never authenticated. `saveUninitialized:
    // false` means an anonymous visitor has a session object but no `userId`.
    if (typeof userId !== "number") {
        return refuse(res);
    }
    // Absolute lifetime, enforced independently of the rolling idle TTL
    // (RFC-001 §11.1). The idle TTL alone would let an active session live
    // forever; this ceiling is set once at login and never extended, so a stolen
    // session cannot be kept alive indefinitely by using it.
    if (isSessionExpired(req)) {
        console.warn(`[auth] Session past absolute lifetime for user ${userId}`);
        await endSession(req, res);
        return refuse(res);
    }
    let user;
    try {
        user = await getUserById(userId);
    }
    catch (error) {
        // A database failure is not an authentication failure. Answering 401 here
        // would tell a legitimate caller to log in again, which cannot help and
        // discards a valid session over a transient outage.
        console.error("[auth] Failed to load session user", error);
        return res.status(500).json({
            success: false,
            message: "Authentication check failed",
        });
    }
    // Deleted: the row is gone, or soft-deleted. A session outliving its User is
    // the exact case the session stores an id rather than a snapshot to catch.
    if (!user || user.deletedAt !== null) {
        console.warn(`[auth] Session references a deleted user ${userId}`);
        await endSession(req, res);
        return refuse(res);
    }
    // Disabled. Answered 401 rather than 403, per RFC-001 §9.4: 403 would confirm
    // that the presented session was valid and that a real account sits behind it.
    // 403 stays reserved for origin and CSRF rejection (RFC-001 §11.4).
    if (user.status !== "active") {
        console.warn(`[auth] Session user ${userId} is ${user.status}`);
        await endSession(req, res);
        return refuse(res);
    }
    // Activity timestamp. `rolling: true` already re-saves the session on every
    // response, so this rides along on a write that was happening anyway.
    req.session.lastSeenAt = Date.now();
    req.user = {
        id: user.id,
        publicId: user.publicId,
        googleSub: user.googleSub,
        email: user.email,
        name: user.name,
        imageUrl: user.imageUrl,
    };
    return next();
};
// Destroy a session that failed validation, and clear its cookie and index
// entry. A session that will never authenticate again should not be left in
// Redis to expire on its own, and the browser should stop presenting it.
//
// Failure here is logged and swallowed: the request is being refused either way,
// and turning a cleanup failure into a 500 would replace a correct 401 with a
// misleading one.
const endSession = async (req, res) => {
    try {
        await destroySession(req, res);
    }
    catch (error) {
        console.error("[auth] Failed to destroy an invalid session", error);
    }
};
//# sourceMappingURL=auth.middleware.js.map