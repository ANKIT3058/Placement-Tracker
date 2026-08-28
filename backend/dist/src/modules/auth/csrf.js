import { randomBytes } from "node:crypto";
/* Double-submit CSRF (RFC-001 §11.4).
 *
 * `SameSite=Lax` on the session cookie is currently the only thing refusing a
 * cross-site state-changing request, and it lives in the browser rather than in
 * this application: one change to `SameSite=None` — the usual "fix" for a
 * cross-origin problem — would remove the entire defence with no test failing.
 *
 * This adds a control the codebase owns. The server issues a random token in a
 * readable cookie; the frontend echoes it in a header; the server compares the
 * two. An attacker page can cause a request to this API and the browser will
 * attach the cookies, but that page cannot READ the cookie to echo it (it is a
 * different origin) and cannot set the header without a preflight CORS refuses.
 *
 * No server-side storage. That is the defining property of double-submit and
 * the reason this PR touches neither Redis nor Prisma: the cookie IS the
 * expected value, so the comparison is self-contained. The token is therefore
 * deliberately independent of `placement.sid` — it authenticates nothing and
 * identifies no one; it only proves the caller could read a same-origin cookie.
 *
 * Chosen ahead of Origin validation because it is deployment-independent.
 * PR-8A could not establish that `Origin` survives the Vercel → Render rewrite,
 * and a control that fails closed on an unverified assumption would break every
 * state-changing route the moment it deployed. Cookies and headers demonstrably
 * survive that hop — the session cookie already does.
 */
const isProduction = process.env.NODE_ENV === "production";
// The sibling of `placement.sid`. RFC-001 §11.4 specifies the mechanism but not
// a name, and double-submit requires both ends to agree on one; the frontend
// reads this exact string in `client/src/api/http.ts`.
export const CSRF_COOKIE_NAME = "placement.csrf";
// Lower-cased because Node normalises incoming header names, and this is only
// ever used to read one. The frontend sends the conventional `X-CSRF-Token`.
export const CSRF_HEADER_NAME = "x-csrf-token";
// 32 bytes — 256 bits, comfortably above the ≥128 RFC-001 §11.4 requires, and
// the same order as the 192-bit session identifier express-session generates.
// base64url keeps it to 43 characters with no percent-encoding in the cookie.
const CSRF_TOKEN_BYTES = 32;
export const csrfCookieOptions = {
    // FALSE, and that is the mechanism, not an oversight. The frontend must be
    // able to read this value to echo it back; a token the page cannot read
    // cannot be double-submitted. It is safe to expose precisely because it
    // grants nothing on its own — unlike `placement.sid`, which stays HttpOnly.
    httpOnly: false,
    // Production only, so local development over http still works. Matches the
    // session cookie rule rather than inventing a second one.
    secure: isProduction,
    // Lax. The token is worthless to a cross-site attacker who cannot read it, so
    // this is defence in depth rather than the defence itself.
    sameSite: "lax",
    // Site-wide: every protected route lives under a different path prefix.
    path: "/",
};
const generateToken = () => randomBytes(CSRF_TOKEN_BYTES).toString("base64url");
/* Reads one cookie from the request.
 *
 * Hand-rolled rather than adding `cookie-parser`: this needs exactly one value,
 * and the dependency would sit in the request path of every route to provide
 * it. `express-session` parses the Cookie header internally but does not expose
 * the result, so there is nothing already on `req` to reuse.
 *
 * Matching is on the whole name between separators, never a prefix — a naive
 * `startsWith("placement.")` or an unanchored search would also match
 * `placement.sid` and feed a signed session identifier into the comparison
 * below. That is the specific mistake this function exists to make impossible.
 */
export const readCookie = (req, name) => {
    const header = req.headers.cookie;
    if (typeof header !== "string" || header === "") {
        return undefined;
    }
    for (const pair of header.split(";")) {
        const separator = pair.indexOf("=");
        if (separator === -1) {
            continue;
        }
        if (pair.slice(0, separator).trim() !== name) {
            continue;
        }
        const raw = pair.slice(separator + 1).trim();
        try {
            return decodeURIComponent(raw);
        }
        catch {
            // A malformed percent-escape is not a value that can be compared;
            // treating it as absent refuses the request rather than throwing.
            return undefined;
        }
    }
    return undefined;
};
/* ISSUANCE ONLY. Mounted globally, after the session middleware.
 *
 * This never rejects anything and never reads the header. Combining issuance
 * with validation in one global middleware is the obvious shortcut and it
 * breaks two things at once: a signed-out visitor could not obtain a token
 * (there is no other endpoint that hands one out, so the sign-in and logout
 * flows could never send one), and a signed-out POST would answer 403 "bad
 * token" where the honest answer is 401 "sign in". Validation is `requireCsrf`,
 * mounted per route, after authentication.
 *
 * The value is stable: an existing token is re-sent unchanged, never replaced.
 * Rotating per request would race the frontend — a token read from the cookie
 * before one request would already be stale by the next, and two concurrent
 * requests from one page would invalidate each other. Re-sending the same value
 * rather than sending nothing also keeps the cookie alive alongside the session
 * instead of letting it lapse under a still-valid `placement.sid`.
 */
export const ensureCsrfCookie = (req, res, next) => {
    const token = readCookie(req, CSRF_COOKIE_NAME) || generateToken();
    res.cookie(CSRF_COOKIE_NAME, token, csrfCookieOptions);
    return next();
};
// One response for every rejection, mirroring how `requireAuth` refuses
// (RFC-001 §9.4). A missing cookie, a missing header, an empty value on either
// side and a mismatch are externally indistinguishable: reporting which one
// failed tells a caller probing the endpoint how close they are, and echoing
// the submitted value would confirm what the server compared it against.
const refuse = (res) => {
    return res.status(403).json({
        success: false,
        message: "Invalid CSRF token",
    });
};
/* VALIDATION ONLY. Mounted per route, AFTER `requireAuth`.
 *
 * The ordering is load-bearing and pinned by test: authentication answers
 * first, so a signed-out caller still learns they are signed out (401) instead
 * of being told to fix a token they were never going to have. `POST
 * /auth/logout` is the one exception — it deliberately carries no `requireAuth`
 * (PR-7E: "you are now logged out" is true either way), so this runs first
 * there and is the only check the route has.
 *
 * It runs BEFORE the handler, which is the point. A refused request must not
 * reach Prisma, the queue, the sync service, or `destroySession`; a 403 issued
 * after the write has already happened protects nothing.
 */
export const requireCsrf = (req, res, next) => {
    const cookieToken = readCookie(req, CSRF_COOKIE_NAME);
    const headerToken = req.get(CSRF_HEADER_NAME);
    // An empty string is not a token. Without this, a caller presenting neither
    // cookie nor header would compare "" against "" and be let through.
    if (!cookieToken || !headerToken) {
        console.warn("[csrf] Refused a request carrying no double-submit token");
        return refuse(res);
    }
    // Exact equality. The values are compared and never logged: a token in a log
    // line is a token in whatever ships those logs onward.
    if (cookieToken !== headerToken) {
        console.warn("[csrf] Refused a request whose token did not match its cookie");
        return refuse(res);
    }
    return next();
};
//# sourceMappingURL=csrf.js.map