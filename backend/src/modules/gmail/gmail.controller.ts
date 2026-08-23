import { Request, Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthUrl,
  getTokens,
  getGmailAddress,
  verifyGoogleIdToken,
} from "./gmail.service.js";
import { connectGmailAccount } from "./gmail.repository.js";
import {
  resolveUserFromGoogleIdentity,
  UnverifiedGoogleIdentityError,
  InactiveUserError,
} from "../user/user.service.js";
import { establishSession } from "../auth/session.service.js";
import { requireTenantContext } from "../auth/tenant-context.js";
import { syncUserMailboxes } from "./gmail.sync.service.js";
import { describeGmailError } from "./gmail.errors.js";

// How long an authorization flow may stay open (RFC-001 §10.1). Independent of
// the session's own TTL: the session may live for days, this must not.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// One answer for every state failure — missing, mismatched, expired, replayed.
// Naming which one would tell an attacker which half of their guess was right;
// the reason is logged server-side instead.
const OAUTH_STATE_ERROR = {
  success: false,
  message: "Invalid or expired authorization request",
} as const;

// `req.session.save` is callback-based. Promisified here rather than in
// session.service because it is plumbing for this flow, not part of the
// session contract.
const saveSession = (req: Request): Promise<void> =>
  new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });

// Begin an authorization flow.
//
// The two secrets are generated here and remembered on the anonymous session,
// which is what lets the callback recognise its own request later. Google
// receives the state and the challenge; the verifier stays on this server.
export const gmailAuthController = async (req: Request, res: Response) => {
  try {
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    req.session.oauthState = state;
    req.session.oauthStateExpiresAt = Date.now() + OAUTH_STATE_TTL_MS;
    req.session.oauthCodeVerifier = codeVerifier;

    // Before the redirect, not after. `saveUninitialized: false` means an
    // anonymous session is not written unless it is saved explicitly, so
    // redirecting first would send the browser to Google carrying no cookie
    // and leave the callback with nothing to compare against — every login
    // would fail closed.
    await saveSession(req);

    return res.redirect(generateAuthUrl(state, codeChallenge));
  } catch (error) {
    console.error("[gmail-auth] Failed to start the authorization flow", error);

    return res.status(500).json({
      success: false,
      message: "Failed to start sign-in",
    });
  }
};

// Validate the authorization response against what this browser asked for.
//
// Returns the PKCE verifier on success and null on any failure — the caller
// cannot tell the failures apart, and neither can the client.
const readPendingOAuth = (req: Request): { codeVerifier: string } | null => {
  const provided = req.query.state;
  const expected = req.session.oauthState;
  const expiresAt = req.session.oauthStateExpiresAt;
  const codeVerifier = req.session.oauthCodeVerifier;

  if (typeof provided !== "string" || !provided) {
    console.warn("[gmail-callback] Authorization response carried no state");
    return null;
  }

  // Absent because this browser never started a flow, or because it already
  // completed one — the replay case.
  if (!expected || !codeVerifier) {
    console.warn("[gmail-callback] No authorization flow is open for this session");
    return null;
  }

  if (typeof expiresAt !== "number" || Date.now() >= expiresAt) {
    console.warn("[gmail-callback] Authorization flow expired");
    return null;
  }

  if (provided !== expected) {
    // The login-CSRF case: a genuine authorization response, for a flow this
    // browser did not start.
    console.warn("[gmail-callback] Authorization state did not match the session");
    return null;
  }

  return { codeVerifier };
};

// Consume the flow, so a state cannot be presented twice. Persisted before the
// token exchange rather than after, because a replay arriving mid-exchange
// would otherwise still find the state live.
const consumeOAuthState = async (req: Request): Promise<void> => {
  delete req.session.oauthState;
  delete req.session.oauthStateExpiresAt;
  delete req.session.oauthCodeVerifier;

  await saveSession(req);
};

// Google OAuth callback.
//
// AC-5.3 extends this from "store a mailbox" to "resolve an identity, then
// store a mailbox owned by it". Everything before the two writes is validation,
// deliberately: the previous version wrote nothing unless the whole exchange
// succeeded, and resolving the User earlier would leave an orphan User row
// behind whenever the token exchange or profile lookup failed.
//
// AC-5.4 adds the session: once identity is resolved and the mailbox linked,
// the caller is authenticated. No route consumes that session yet — reading it
// back to identify a caller is `requireAuth` in AC-5.5.
//
// The `state` and PKCE checks come first (RFC-001 §10.1). Until they existed,
// this endpoint would establish a session from any valid authorization code —
// including one an attacker obtained for their own Google identity and then
// induced a victim to visit, which handed the victim's browser a session for
// the attacker's tenant. The code is still genuine and the identity still
// verifies in that scenario; the only thing wrong is that this is not the
// browser that asked, and that is precisely what the state proves.
export const gmailCallbackController = async (req: Request, res: Response) => {
  try {
    // FIRST, before anything with a side effect. An authorization response
    // this browser did not ask for must not reach the token exchange, the
    // User upsert, the mailbox write, or the session — a rejected response
    // leaves no trace at all.
    const pending = readPendingOAuth(req);

    if (!pending) {
      return res.status(400).json(OAUTH_STATE_ERROR);
    }

    await consumeOAuthState(req);

    const code = req.query.code as string;

    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Authorization code missing",
      });
    }

    const tokens = await getTokens(code, pending.codeVerifier);

    if (!tokens.id_token) {
      throw new Error("Google did not return an ID token");
    }

    const identity = await verifyGoogleIdToken(tokens.id_token);

    if (!tokens.refresh_token) {
      throw new Error("Refresh token not received");
    }

    const email = await getGmailAddress(tokens);

    if (!email) {
      throw new Error("Unable to retrieve Gmail address");
    }

    // First write. Idempotent on `googleSub`, so a retried callback converges
    // rather than duplicating.
    const user = await resolveUserFromGoogleIdentity(identity);

    // Second write. Not in a transaction with the first: both are idempotent,
    // and the only interleaving that can be observed is a User that exists
    // without a linked mailbox — which is a legitimate state anyway, since a
    // User may own zero mailboxes (RFC-001 §6.2 P2).
    await connectGmailAccount(email, tokens.refresh_token, user.id);

    // Session established last, so a session only exists once the whole
    // exchange has succeeded. `establishSession` regenerates the session id
    // before writing to it, which is what makes this immune to fixation
    // (RFC-001 §10.1), then persists and saves the record before this response
    // carries its cookie back.
    await establishSession(req, user);

    // Google sent the BROWSER here as a top-level navigation, so whatever this
    // returns is what the person sees. A JSON body left them looking at
    // `{"success":true}` on the API origin with no way back into the app; a
    // redirect returns them to it.
    //
    // After `establishSession`, never before: the redirect and the Set-Cookie
    // ride on the same response, so the browser cannot arrive at the frontend
    // ahead of the session that makes it useful.
    //
    // Nothing about the User is exposed — `publicId` remains the only
    // identifier that may ever leave the backend (RFC-001 §8.2), and a redirect
    // carries none of it.
    return res.redirect(process.env.FRONTEND_URL ?? "/");
  } catch (error) {
    if (
      error instanceof UnverifiedGoogleIdentityError ||
      error instanceof InactiveUserError
    ) {
      console.warn(`[gmail-callback] Identity refused: ${error.message}`);

      return res.status(403).json({
        success: false,
        message: "This Google account cannot be used to sign in",
      });
    }

    // A failed code exchange throws a GaxiosError whose request config holds
    // the authorization code, the PKCE verifier and the client secret. Logging
    // the raw error would disclose all three, so only safe diagnostics are
    // recorded here (RFC-001 §13.2).
    console.error(
      "[gmail-callback] Failed to exchange code",
      describeGmailError(error),
    );

    return res.status(500).json({
      success: false,
      message: "Failed to exchange code",
    });
  }
};

// Synchronize the caller's own mailboxes.
//
// The controller no longer chooses a mailbox. It derives the tenant from the
// authenticated session and hands it to the service, which resolves ownership
// itself (RFC-001 §10). There is no longer any input — from the caller or from
// the database — that can point this at someone else's mailbox.
//
// Zero mailboxes answers 200 with an empty list rather than the previous 404. A
// User who owns no mailbox is in a legitimate state, not a missing resource, and
// 404 would tell an authenticated caller their own account is absent.
export const gmailSyncController = async (req: Request, res: Response) => {
  const context = requireTenantContext(req);

  const result = await syncUserMailboxes(context);

  console.log("[gmail-sync] Manual sync complete", {
    userId: context.userId,
    mailboxes: result.mailboxes.length,
    synced: result.synced,
    failed: result.failed,
  });

  return res.json({
    success: true,
    synced: result.synced,
    failed: result.failed,
    mailboxes: result.mailboxes,
  });
};
