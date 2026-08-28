import { Router } from "express";
import { getStudentProfileController, updateStudentProfileController, getShortlistParticipationController, } from "./user.controller.js";
import { requireAuth } from "../auth/auth.middleware.js";
import { requireCsrf } from "../auth/csrf.js";
const router = Router();
// Every route here is about the CALLER'S OWN record, so authentication is not
// merely a precondition for scoping — it is the entire addressing mechanism
// (RFC-001 §15.2). There is no `/user/:id/profile` and there must not be: the
// handlers take "whose profile" from the session and from nowhere else.
router.use(requireAuth);
// CSRF on the write only, and AFTER `requireAuth` (RFC-001 §11.4). The read
// changes nothing, and a cross-site GET still returns its response to an origin
// that cannot read it. The PATCH is the surface worth protecting: an attacker
// page cannot read `placement.csrf` to echo it, so it cannot reach it.
router.get("/profile", getStudentProfileController);
router.patch("/profile", requireCsrf, updateStudentProfileController);
// A read, so no `requireCsrf` — the same reason GET /profile above has none.
router.get("/shortlists", getShortlistParticipationController);
export default router;
//# sourceMappingURL=user.routes.js.map