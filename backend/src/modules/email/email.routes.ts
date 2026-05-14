import { Router } from "express";
import { receiveEmailController } from "./email.controller.js";

const router = Router();

router.post("/", receiveEmailController);

export default router;