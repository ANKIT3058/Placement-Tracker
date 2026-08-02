import { Router } from "express";
import { logoutController } from "./auth.controller.js";

const router = Router();

router.post("/logout", logoutController);

export default router;
