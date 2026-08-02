import { Router } from "express";

import {
  gmailAuthController,
  gmailCallbackController,
  gmailSyncController,
} from "./gmail.controller.js";
import { requireAuth } from "../auth/auth.middleware.js";

const router = Router();

// Unauthenticated by necessity: these two are how a caller becomes
// authenticated in the first place (RFC-001 §15.2).
router.get("/auth", gmailAuthController);
router.get("/callback", gmailCallbackController);

// POST, not GET (RFC-001 §15.2). The method change is not cosmetic and cannot
// be deferred: `SameSite=Lax` sends the session cookie on cross-site top-level
// GET navigations, so the moment this route is protected by a session cookie, a
// GET form of it becomes CSRF-reachable from any page that can navigate the
// browser. Protecting it and leaving it a GET would introduce the vulnerability
// that protecting it was meant to close.
//
// Synchronizes the mailboxes the caller owns, resolved from the session via
// TenantContext (AC-5.6). No caller input selects a mailbox.
router.post("/sync", requireAuth, gmailSyncController);

export default router;
