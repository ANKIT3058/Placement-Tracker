import "express-session";

// The authenticated session record (RFC-001 §11.1).
//
// It stores `userId`, never a snapshot of the User. Authorization decisions must
// reflect current state: a User disabled or deleted after their session was
// created has to be rejected on their next request, not on their next login. A
// cached copy of the row would defeat that.
//
// It never stores anything derived from Google's tokens. Refresh tokens live on
// GmailAccount and never leave the backend (RFC-001 §13.2); a session is an
// identity record, not a credential store.
declare module "express-session" {
  interface SessionData {
    userId: number;
    googleSub: string;

    // Epoch milliseconds.
    createdAt: number;
    lastSeenAt: number;

    // Hard ceiling, set once at login and never extended. Enforced
    // independently of the rolling idle TTL — without it a rolling session is
    // effectively permanent and revocation has no natural expiry to fall back
    // on (RFC-001 §11.1).
    absoluteExpiresAt: number;

    // Recorded for forensics and future anomaly detection. Never used as an
    // authorization input: both are client-controlled, and binding a session to
    // them breaks legitimate users on mobile networks and browser upgrades.
    ip?: string;
    userAgent?: string;
  }
}
