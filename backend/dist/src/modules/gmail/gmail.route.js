import { Router } from "express";
import { gmailAuthController, gmailCallbackController, gmailSyncController, } from "./gmail.controller.js";
const router = Router();
router.get("/auth", gmailAuthController);
router.get("/callback", gmailCallbackController);
router.get("/sync", gmailSyncController);
export default router;
//# sourceMappingURL=gmail.route.js.map