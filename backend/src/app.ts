import express from "express";
import eventRoutes from "./modules/event/event.routes.js";
import emailRoutes from "./modules/email/email.routes.js";
import gmailRoutes from "./modules/gmail/gmail.route.js";
import authRoutes from "./modules/auth/auth.routes.js";
import { sessionMiddleware } from "./modules/auth/session.config.js";
import { ensureCsrfCookie } from "./modules/auth/csrf.js";
import { prisma } from "./lib/prisma.js";
import cors from "cors";

const app = express();

// Behind a TLS-terminating proxy (the usual production shape), Express sees
// http on the internal hop and would refuse to send a `Secure` cookie. Trusting
// one proxy hop lets it read X-Forwarded-Proto and treat the request as secure.
// Enabled in production only: trusting the header when nothing strips it lets a
// client claim its own protocol and address.
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  }),
);

app.use(express.json());

// Populates `req.session` for every request. It does not authenticate anyone and
// gates nothing: a request without a session cookie proceeds exactly as before,
// with an empty session that `saveUninitialized: false` never persists. Reading
// the session back to identify a caller is `requireAuth` in AC-5.5.
app.use(sessionMiddleware);

// Issuance only, and therefore safe to mount for every route including the
// unauthenticated ones: it hands out `placement.csrf` and never refuses
// anything. A signed-out visitor must be able to obtain a token here, because
// no other endpoint hands one out and the sign-in and logout flows both need
// one. The matching CHECK is `requireCsrf`, mounted per route after
// `requireAuth` (RFC-001 §11.4) — keeping the two apart is what stops a
// signed-out POST from answering 403 where 401 is the truth.
app.use(ensureCsrfCookie);

/* ---------------- HEALTH CHECK ROUTES ---------------- */

// Root route
app.get("/", (_, res) => {
  res.send("Backend Running");
});

// Database health route
app.get("/health", async (_, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      status: "ok",
      database: "connected",
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      status: "db failed",
    });
  }
});

/* ---------------- API ROUTES ---------------- */

app.use("/auth", authRoutes);
app.use("/gmail", gmailRoutes);
app.use("/event", eventRoutes);
app.use("/email", emailRoutes);

export default app;
