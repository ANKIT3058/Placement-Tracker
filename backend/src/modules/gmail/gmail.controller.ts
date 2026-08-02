import { Request, Response } from "express";
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

export const gmailAuthController = (req: Request, res: Response) => {
  const url = generateAuthUrl();

  return res.redirect(url);
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
// The OAuth `state` parameter is still absent (RFC-001 §10.1). That was
// tolerable while the callback issued nothing; now that it issues a session it
// is a live CSRF hole and must close before this flow is exposed to real users.
export const gmailCallbackController = async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string;

    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Authorization code missing",
      });
    }

    const tokens = await getTokens(code);

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

    // Response shape unchanged. Nothing about the User is exposed: `publicId`
    // is the only identifier that may ever leave the backend (RFC-001 §8.2),
    // and no consumer has asked for it yet.
    return res.json({
      success: true,
      email,
    });
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

    console.error(error);

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
