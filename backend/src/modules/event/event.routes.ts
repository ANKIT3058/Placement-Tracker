import { Router } from "express";
import { createEventController } from "./event.controller";

const router = Router();

router.post("/", createEventController);

export default router;