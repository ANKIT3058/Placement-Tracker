/* The one place a non-2xx response becomes an error.

   Every call in this folder used to end in `res.json()` with no look at
   `res.ok`, so a 401 body — `{ success: false, message: "Authentication
   required" }` — came back looking exactly like data. The Dashboard then
   rendered "No events yet", telling a signed-out user their account was empty.

   `status` is carried on the error because it is the smallest thing that keeps
   the three outcomes apart: 401 means sign in, any other failure means
   something broke, and a 2xx with an empty list means the account really is
   empty. A caller that cannot tell those apart cannot say anything true. */

export class ApiError extends Error {
  status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

/* The server's explanation for a failure, when it sent one.

   Every client-facing error in this backend answers with a `message` — and
   `message` alone is read. Reaching for whatever other fields happen to be
   present would turn the contract into "display any string the server sent",
   which is a much larger promise than the one the backend makes.

   Every failure to READ the body is swallowed. An error response may be empty,
   plain text, or malformed JSON, and in each case the HTTP failure is still the
   truth: a SyntaxError surfacing where a 500 belongs would be strictly worse
   than having no message at all. Reading why a request failed must never be
   able to replace the fact that it did. */
const serverMessage = async (res: Response): Promise<string | undefined> => {
  try {
    const body: unknown = await res.json();

    if (typeof body === "object" && body !== null) {
      const message = (body as { message?: unknown }).message;

      if (typeof message === "string" && message.trim() !== "") {
        return message;
      }
    }
  } catch {
    // Unreadable body — the status is all we can report.
  }

  return undefined;
};

/* ------------------------------------------------------------------ *
 * Double-submit CSRF (RFC-001 §11.4) — the client half.
 *
 * The server issues `placement.csrf` in a deliberately readable cookie and
 * refuses any state-changing request whose `X-CSRF-Token` header does not match
 * it. A cross-origin attacker can cause a request and the browser will attach
 * the cookies, but the attacker cannot READ the cookie to echo it and cannot
 * set the header without a preflight CORS refuses.
 *
 * Attached HERE and nowhere else. `requestJson` is the only function in the
 * client that reaches `fetch`, so `getEvents`, `updateEvent`, `processEmail`
 * and `logout` all inherit the header without a line changing in any of them.
 * A per-caller scheme would be four edits today and a forgotten one later —
 * and a forgotten one fails as a 403 with no obvious cause.
 * ------------------------------------------------------------------ */

const CSRF_COOKIE = "placement.csrf";
const CSRF_HEADER = "X-CSRF-Token";

/* Methods that cannot change server state, and therefore need no token.

   The server exempts these too. Sending the header anyway would widen where the
   token appears — proxy logs, referrer-adjacent tooling — for no gain. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/* Reads one cookie by exact name.

   Never a prefix match. `placement.sid` shares the `placement.` prefix, is the
   session identifier, and is HttpOnly in production precisely so that script
   cannot reach it — a loose match here would try to send it in a header, which
   is the classic way to turn a CSRF fix into a session leak. */
const readCookie = (name: string): string | undefined => {
  if (typeof document === "undefined") {
    return undefined;
  }

  for (const pair of document.cookie.split(";")) {
    const separator = pair.indexOf("=");

    if (separator === -1) {
      continue;
    }

    if (pair.slice(0, separator).trim() !== name) {
      continue;
    }

    return decodeURIComponent(pair.slice(separator + 1).trim());
  }

  return undefined;
};

/* Builds the outgoing headers: the caller's own, plus the canonical token.

   The cookie is the ONLY source of the token, and it always wins. Any
   caller-supplied `X-CSRF-Token` is stripped first, in whatever casing it
   arrived in — HTTP header names are case-insensitive, so leaving
   `x-csrf-token` in place while setting `X-CSRF-Token` would send two values
   and let the wrong one through. A caller that could substitute its own token
   would silently opt out of the protection, deliberately or by copying an
   example, and the request would simply 403 with nothing to point at.

   When there is no cookie, no header is sent. The client must not invent a
   value: the server refusing with 403 is the correct outcome, and a fabricated
   token would only turn a clear failure into a confusing one. */
const withCsrfToken = (headers: HeadersInit | undefined): HeadersInit => {
  const merged = new Headers(headers);

  // `Headers` matches names case-insensitively, so this removes the caller's
  // value however it was spelled.
  merged.delete(CSRF_HEADER);

  const token = readCookie(CSRF_COOKIE);

  if (token) {
    merged.set(CSRF_HEADER, token);
  }

  return merged;
};

/* Performs the request and returns the parsed body, or throws.

   A network failure (no response at all) propagates untouched: `fetch` already
   rejects with a TypeError, there is no status to attach, and wrapping it would
   only obscure the cause. */
export const requestJson = async <T>(
  url: string,
  init?: RequestInit,
): Promise<T> => {
  // `fetch` defaults to GET when no method is given, so the same default
  // decides this — `getEvents()` passes no init at all.
  const method = (init?.method ?? "GET").toUpperCase();

  const request: RequestInit | undefined = SAFE_METHODS.has(method)
    ? init
    : { ...init, headers: withCsrfToken(init?.headers) };

  const res = await fetch(url, request);

  if (!res.ok) {
    throw new ApiError(res.status, await serverMessage(res));
  }

  return (await res.json()) as T;
};
