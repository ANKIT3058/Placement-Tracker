import session from "express-session";
import { RedisStore } from "connect-redis";
import type { CookieOptions } from "express";
import { sessionRedis } from "../../infrastructure/redis/session-redis.js";
import "./session.types.js";

const isProduction = process.env.NODE_ENV === "production";

// Idle timeout, refreshed on every request (`rolling`). connect-redis derives
// the Redis key TTL from this, so an idle session expires in the store as well
// as in the browser (RFC-001 §11.1).
export const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Hard ceiling on a session's life regardless of activity (RFC-001 §11.1).
export const SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Set only when the API and the frontend sit on different hosts under one
// registrable domain — `.example.com` for `app.example.com` + `api.example.com`
// (RFC-001 §11.3). Left unset for single-host and local development.
const cookieDomain = process.env.SESSION_COOKIE_DOMAIN;

// `__Host-` binds the cookie to the exact origin and to `Path=/`, and browsers
// reject it if `Secure` is absent or `Domain` is set. So it applies only when
// both hold: production (Secure) and no Domain attribute. RFC-001 §11.2 asks
// for the prefix "where the Domain attribute is not required" — this is that
// condition, expressed.
export const SESSION_COOKIE_NAME =
  isProduction && !cookieDomain ? "__Host-placement.sid" : "placement.sid";

// Shared by the session middleware and by `res.clearCookie` on logout. A cookie
// is only cleared when the attributes match the ones it was set with, so these
// must come from one place (RFC-001 §10.3).
export const sessionCookieOptions: CookieOptions = {
  // Always. Removes the cookie from the reach of any script, which is the whole
  // reason a session identifier is preferable to a token in web storage.
  httpOnly: true,

  // Production only, so local development over http still works.
  secure: isProduction,

  // Lax, not Strict: the OAuth callback is a cross-site top-level navigation
  // back from Google, and Strict would withhold the cookie on that first
  // request. Lax is also why RFC-001 §11.4 forbids state-changing GET routes —
  // it permits cross-site top-level GETs.
  sameSite: "lax",

  path: "/",

  ...(cookieDomain ? { domain: cookieDomain } : {}),
};

// Signing secret(s). A comma-separated list supports rotation: express-session
// signs with the first and accepts any of them on verification, so a new secret
// can be prepended and the old one retired once every session signed with it
// has expired (RFC-001 §16.2).
const parseSessionSecrets = (): string[] => {
  const raw = process.env.SESSION_SECRET;

  const secrets = (raw ?? "")
    .split(",")
    .map((secret) => secret.trim())
    .filter(Boolean);

  if (secrets.length > 0) {
    return secrets;
  }

  // A missing secret must never degrade to a default: an attacker-known signing
  // key forges session cookies, and the failure is silent (RFC-001 §16.2).
  if (isProduction) {
    throw new Error("SESSION_SECRET is required in production");
  }

  console.warn(
    "[session] SESSION_SECRET is unset — using an insecure development default",
  );

  return ["insecure-development-session-secret"];
};

export const sessionMiddleware = session({
  name: SESSION_COOKIE_NAME,

  secret: parseSessionSecrets(),

  // The session identifier is express-session's default: 24 CSPRNG bytes via
  // uid-safe, i.e. 192 bits — above the ≥128 RFC-001 §11.1 requires. Not
  // overridden, because a hand-rolled generator here could only be worse.

  store: new RedisStore({
    client: sessionRedis,
    // Matches the `sess:{sessionId}` key layout in RFC-001 §11.1, and keeps
    // session keys visibly distinct from BullMQ's `bull:` namespace.
    prefix: "sess:",
  }),

  // Never write a session for a request that did not create one. Without this,
  // every unauthenticated request — including health checks and crawlers —
  // allocates a Redis key and a Set-Cookie header.
  saveUninitialized: false,

  // The store is the source of truth and is written explicitly at login, so
  // re-saving an unmodified session on every request is pure write amplification.
  resave: false,

  // Refresh the cookie and the store TTL on each response, which is what makes
  // the idle timeout idle rather than absolute.
  rolling: true,

  cookie: {
    ...sessionCookieOptions,
    maxAge: SESSION_IDLE_TTL_MS,
  },
});
