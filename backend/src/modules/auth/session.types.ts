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

    // PRE-AUTHENTICATION OAUTH FIELDS (RFC-001 §10.1).
    //
    // Written on an anonymous session at /gmail/auth and consumed at the
    // callback. They are what binds an authorization response to the browser
    // that asked for it: without them the callback cannot tell a response to
    // its own request from one an attacker obtained and induced a victim to
    // visit.
    //
    // All three are optional because they exist only for the minutes between
    // starting a flow and completing it, and `establishSession`'s regenerate
    // discards whatever remains.
    //
    // The verifier is a credential and never leaves the backend — only its
    // SHA-256 challenge is published to Google. That is the one exception to
    // the note above about sessions holding no credentials, and it holds for
    // one flow rather than for a session's lifetime.
    oauthState?: string;
    oauthStateExpiresAt?: number;
    oauthCodeVerifier?: string;
  }
}
