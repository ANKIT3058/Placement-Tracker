import { requestJson } from "./http";

const BASE_URL = import.meta.env.VITE_API_URL;

/* End the Placement Tracker session.
 *
 * POST, never GET: this changes server state, and `SameSite=Lax` sends the
 * session cookie on cross-site top-level GET navigations — a GET form would be
 * reachable from any page that can navigate the browser (RFC-001 §11.4).
 *
 * No body. The session is identified by its cookie; there is nothing for a
 * caller to supply, and accepting anything would invite one to name a session
 * that is not theirs.
 *
 * The endpoint answers 200 whether or not a session existed, so there is no
 * "already signed out" case to special-case here — an absent session is a
 * successful logout. A 500 means the destroy genuinely failed and the session
 * may still be live, so it rejects like any other failure; translating it into
 * success would let the UI show a signed-out screen over a live session.
 *
 * Ends the application session only. The Google grant and the connected
 * mailbox survive by design (RFC-001 §10.3) — signing back in reuses them
 * rather than re-prompting for consent.
 */
export const logout = async () => {
  return requestJson(`${BASE_URL}/auth/logout`, { method: "POST" });
};
