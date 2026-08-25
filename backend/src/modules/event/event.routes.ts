import { Router } from "express";
import {
  createEventController,
  getEventsController,
  getEventByIdController,
  updateEventController,
} from "./event.controller.js";
import { requireAuth } from "../auth/auth.middleware.js";
import { requireCsrf } from "../auth/csrf.js";

const router = Router();

// Every Event route requires an authenticated caller (RFC-001 §15.2).
//
// Authentication only: knowing *who* is asking is the precondition for scoping,
// not the scoping itself. Every handler derives a TenantContext from the session
// and passes it down, and the repository scopes each query by owner — so this
// middleware must never be treated as the thing that keeps tenants apart.
router.use(requireAuth);

// CSRF on the writes only, and AFTER `requireAuth` above (RFC-001 §11.4).
//
// Reads are exempt because they change nothing: a cross-site GET that a
// forgery can cause still returns its response to an origin that cannot read
// it. The writes are the whole attack surface — an attacker page cannot read
// `placement.csrf` to echo it, so it cannot reach these two.
router.post("/", requireCsrf, createEventController);
router.get("/", getEventsController);
router.get("/:id", getEventByIdController);
router.patch("/:id", requireCsrf, updateEventController);

export default router;
