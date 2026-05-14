import { Router } from "express";
import { createEventController, getEventsController, getEventByIdController, updateEventController, } from "./event.controller.js";
const router = Router();
router.post("/", createEventController);
router.get("/", getEventsController);
router.get("/:id", getEventByIdController);
router.patch("/:id", updateEventController);
export default router;
//# sourceMappingURL=event.routes.js.map