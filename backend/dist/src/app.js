import express from "express";
import eventRoutes from "./modules/event/event.routes.js";
import emailRoutes from "./modules/email/email.routes.js";
const app = express();
app.use(express.json());
app.use("/event", eventRoutes);
app.use("/email", emailRoutes);
export default app;
//# sourceMappingURL=app.js.map