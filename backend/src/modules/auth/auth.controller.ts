import type { Request, Response } from "express";
import { destroySession } from "./session.service.js";

// POST, not GET (RFC-001 §11.4). `SameSite=Lax` sends the session cookie on
// cross-site top-level GET navigations, so a state-changing GET is reachable
// from any page that can navigate the browser.
//
// Always answers 200, whether or not a session existed. "You are now logged
// out" is true either way, and distinguishing the two would report whether a
// presented cookie was valid.
export const logoutController = async (req: Request, res: Response) => {
  try {
    await destroySession(req, res);

    return res.json({
      success: true,
    });
  } catch (error) {
    console.error("[auth] Failed to destroy session", error);

    return res.status(500).json({
      success: false,
      message: "Failed to log out",
    });
  }
};
