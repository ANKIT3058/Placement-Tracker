import { Router } from "express";
import { receiveEmailController } from "./email.controller";

const router = Router();

router.post("/", receiveEmailController);

export default router;