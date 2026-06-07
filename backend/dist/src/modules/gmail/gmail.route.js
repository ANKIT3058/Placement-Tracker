import { Router } from "express";
import { gmailAuthController, gmailCallbackController, } from "./gmail.controller.js";
const router = Router();
router.get("/auth", gmailAuthController);
router.get("/callback", gmailCallbackController);
export default router;
//# sourceMappingURL=gmail.route.js.map