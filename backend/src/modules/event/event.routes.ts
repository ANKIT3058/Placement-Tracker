import { Router } from "express";
import {
  createEventController,
  getEventsController,
  getEventByIdController,
  updateEventController,
} from "./event.controller.js";
import { requireAuth } from "../auth/auth.middleware.js";

const router = Router();

// Every Event route requires an authenticated caller (RFC-001 §15.2).
//
// Authentication only. These handlers still read and write across all Events
// regardless of owner — `userId` is nullable and nothing scopes a query yet.
// Knowing *who* is asking is the precondition for scoping, not the scoping
// itself: that is AC-5.7 (tenant context) and AC-5.9 (enforcement), and until
// they land an authenticated user can still reach another user's Event.
router.use(requireAuth);

router.post("/", createEventController);
router.get("/", getEventsController);
router.get("/:id", getEventByIdController);
router.patch("/:id", updateEventController);

export default router;
