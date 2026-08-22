import { Router } from "express";
import { logoutController } from "./auth.controller.js";
import { requireCsrf } from "./csrf.js";

const router = Router();

// `requireCsrf` with no `requireAuth` in front of it, which is the one place in
// the codebase that ordering appears.
//
// Logout is deliberately unauthenticated and idempotent (PR-7E): "you are now
// logged out" is true whether or not a session existed, and answering 401 would
// report whether the presented cookie was valid. So there is no authentication
// step for CSRF to follow here — this check stands alone.
//
// It is still needed. A forced logout is a real, if minor, cross-site attack:
// an attacker page that can end a victim's session denies them the application.
// The check runs before the handler, so a refused request leaves the session
// alive rather than destroying it and then reporting 403.
router.post("/logout", requireCsrf, logoutController);

export default router;
