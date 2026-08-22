import { Router } from "express";
import { receiveEmailController } from "./email.controller.js";
import { requireAuth } from "../auth/auth.middleware.js";
import { requireCsrf } from "../auth/csrf.js";

const router = Router();

// Authenticated as of AC-5.9 — see the note on `receiveEmailController`. An
// Email now requires an owner at the database level, so this route cannot
// accept anonymous input.
//
// `requireCsrf` follows `requireAuth`, never precedes it (RFC-001 §11.4): a
// signed-out caller must still be answered 401, and only a caller who is
// already authenticated is a CSRF target worth protecting.
router.post("/", requireAuth, requireCsrf, receiveEmailController);

export default router;
