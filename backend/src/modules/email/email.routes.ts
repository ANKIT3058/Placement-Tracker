import { Router } from "express";
import { receiveEmailController } from "./email.controller.js";
import { requireAuth } from "../auth/auth.middleware.js";

const router = Router();

// Authenticated as of AC-5.9 — see the note on `receiveEmailController`. An
// Email now requires an owner at the database level, so this route cannot
// accept anonymous input.
router.post("/", requireAuth, receiveEmailController);

export default router;