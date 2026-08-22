import { Router } from "express";

import {
  gmailAuthController,
  gmailCallbackController,
  gmailSyncController,
} from "./gmail.controller.js";
import { requireAuth } from "../auth/auth.middleware.js";
import { requireCsrf } from "../auth/csrf.js";

const router = Router();

// Unauthenticated by necessity: these two are how a caller becomes
// authenticated in the first place (RFC-001 §15.2).
//
// Exempt from `requireCsrf` for the same reason, and not by oversight. The
// browser arrives at the callback as a top-level navigation FROM Google, with
// no application code running to attach a header — forcing an application
// token onto it would break every sign-in. These two carry their own binding
// instead: the OAuth `state` parameter and PKCE, both added in PR-7F, which is
// the protection appropriate to this leg of the flow.
router.get("/auth", gmailAuthController);
router.get("/callback", gmailCallbackController);

// POST, not GET (RFC-001 §15.2). The method change is not cosmetic and cannot
// be deferred: `SameSite=Lax` sends the session cookie on cross-site top-level
// GET navigations, so the moment this route is protected by a session cookie, a
// GET form of it becomes CSRF-reachable from any page that can navigate the
// browser. Protecting it and leaving it a GET would introduce the vulnerability
// that protecting it was meant to close.
//
// `requireCsrf` sits after `requireAuth` (RFC-001 §11.4) and before the
// handler, so a forged request never reaches `syncUserMailboxes`.
//
// Synchronizes the mailboxes the caller owns, resolved from the session via
// TenantContext (AC-5.6). No caller input selects a mailbox.
router.post("/sync", requireAuth, requireCsrf, gmailSyncController);

export default router;
