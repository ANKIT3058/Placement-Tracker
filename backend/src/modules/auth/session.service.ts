import type { Request, Response } from "express";
import { sessionRedis } from "../../infrastructure/redis/session-redis.js";
import {
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "./session.config.js";
import "./session.types.js";

// Per-user index of live session ids (RFC-001 §11.1). Its purpose is bulk
// revocation: "log out everywhere", and disabling or deleting a User, both need
// to enumerate sessions, which the `sess:*` keyspace cannot answer without a
// scan.
//
// Members can go stale — a session that expires by TTL is removed from the store
// but not from this Set — so any consumer must treat a member as a candidate and
// tolerate a missing session key. The Set itself is given an expiry so it cannot
// outlive the longest session it could contain.
const sessionIndexKey = (userId: number) => `user_sessions:${userId}`;

const indexSession = async (userId: number, sessionId: string) => {
  const key = sessionIndexKey(userId);

  await sessionRedis
    .multi()
    .sadd(key, sessionId)
    .pexpire(key, SESSION_ABSOLUTE_LIFETIME_MS)
    .exec();
};

const unindexSession = async (userId: number, sessionId: string) => {
  await sessionRedis.srem(sessionIndexKey(userId), sessionId);
};

// Has this session passed its absolute ceiling? True also for a session with no
// ceiling recorded, which can only be a record written before this field
// existed — treated as expired rather than trusted.
//
// AC-5.4 records the ceiling and provides this check. Enforcing it on every
// request belongs to `requireAuth` in AC-5.5, which is the first thing to read a
// session back. Until that lands, the ceiling is stored but not acted on.
export const isSessionExpired = (req: Request): boolean => {
  const expiresAt = req.session?.absoluteExpiresAt;

  if (typeof expiresAt !== "number") {
    return true;
  }

  return Date.now() >= expiresAt;
};

// Establish an authenticated session for a resolved User.
//
// `regenerate` first, always. It issues a new session identifier and discards
// the pre-authentication one, which is what closes session fixation: an
// attacker who plants a known identifier on a victim's browser before login
// holds an identifier that stops existing the moment the victim authenticates
// (RFC-001 §10.1).
//
// `save` before returning, so the record is durable in Redis before the response
// carrying its cookie is sent. Without it the browser can present a cookie whose
// session has not been written yet.
export const establishSession = (
  req: Request,
  user: { id: number; googleSub: string },
): Promise<void> => {
  return new Promise((resolve, reject) => {
    req.session.regenerate((regenerateError) => {
      if (regenerateError) {
        return reject(regenerateError);
      }

      const now = Date.now();

      req.session.userId = user.id;
      req.session.googleSub = user.googleSub;
      req.session.createdAt = now;
      req.session.lastSeenAt = now;
      req.session.absoluteExpiresAt = now + SESSION_ABSOLUTE_LIFETIME_MS;
      req.session.ip = req.ip;
      req.session.userAgent = req.get("user-agent");

      req.session.save((saveError) => {
        if (saveError) {
          return reject(saveError);
        }

        // Index after the session is durable. A failure here leaves a live
        // session that bulk revocation cannot see, which is worse than a
        // failed login, so it rejects rather than resolving quietly.
        indexSession(user.id, req.sessionID).then(resolve, reject);
      });
    });
  });
};

// Destroy the current session and clear its cookie.
//
// Order matters: the session id and owner are captured before `destroy`, which
// empties `req.session`. The cookie is cleared with the same attributes it was
// set with, because a browser ignores a clear whose attributes do not match
// (RFC-001 §10.3).
//
// Google grants are deliberately untouched. Mailbox connections survive logout;
// revoking them is bound to disconnection and account deletion.
export const destroySession = (req: Request, res: Response): Promise<void> => {
  const sessionId = req.sessionID;
  const userId = req.session?.userId;

  return new Promise((resolve, reject) => {
    if (!req.session) {
      return resolve();
    }

    req.session.destroy((destroyError) => {
      if (destroyError) {
        return reject(destroyError);
      }

      res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions);

      if (typeof userId !== "number") {
        return resolve();
      }

      // A failed de-index leaves a stale member behind, which consumers already
      // tolerate. The session itself is gone, so the logout succeeded.
      unindexSession(userId, sessionId).then(resolve, (error) => {
        console.warn("[session] Failed to de-index destroyed session", error);
        resolve();
      });
    });
  });
};
