import express from "express";
import eventRoutes from "./modules/event/event.routes.js";
import emailRoutes from "./modules/email/email.routes.js";
import gmailRoutes from "./modules/gmail/gmail.route.js";
import { prisma } from "./lib/prisma.js";
import cors from "cors";
const app = express();
app.use(cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
}));
app.use(express.json());
/* ---------------- HEALTH CHECK ROUTES ---------------- */
// Root route
app.get("/", (_, res) => {
    res.send("Backend Running");
});
// Database health route
app.get("/health", async (_, res) => {
    try {
        await prisma.$queryRaw `SELECT 1`;
        res.json({
            status: "ok",
            database: "connected",
        });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({
            status: "db failed",
        });
    }
});
/* ---------------- API ROUTES ---------------- */
app.use("/gmail", gmailRoutes);
app.use("/event", eventRoutes);
app.use("/email", emailRoutes);
export default app;
//# sourceMappingURL=app.js.map