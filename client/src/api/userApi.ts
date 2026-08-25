import { requestJson } from "./http";

const BASE_URL = import.meta.env.VITE_API_URL;

/* The caller's own student profile (G-8.3).
 *
 * ADDRESSED BY THE SESSION, AND ONLY BY THE SESSION. Neither call takes an id
 * of any kind, and neither sends `userId` or the profile's own `id` — the
 * backend derives the owner from the authenticated session and refuses a body
 * carrying either. There is deliberately no `/user/:id/profile` to call.
 *
 * Both go through `requestJson`, so the CSRF token rides along on the PATCH
 * exactly as it does for every other state-changing call in this folder, and a
 * non-2xx response becomes an `ApiError` carrying the status rather than a
 * resolved value that looks like data.
 */

/* The shape both endpoints answer with. `registrationNumber` is `null` for a
   student who has never set one — an ordinary state of a fully working account,
   not an error and not an incomplete profile.

   The profile's `id` and `userId` are absent because the server never sends
   them. Nothing in this client should ever learn them: they are not an
   addressing mechanism, and holding them would invite one. */
export type StudentProfile = {
  registrationNumber: string | null;
};

type StudentProfileResponse = {
  success: boolean;
  profile: StudentProfile;
};

export const getStudentProfile = async (): Promise<StudentProfile> => {
  const result = await requestJson<StudentProfileResponse>(
    `${BASE_URL}/user/profile`,
  );

  return result.profile;
};

/* Set or clear the registration number.
 *
 * `null` clears it. The value is otherwise passed through untouched: there is
 * NO client-side format check, no case folding and no normalization. A
 * registration number is whatever shape the issuing institution uses, and the
 * server deliberately accepts arbitrary strings — duplicating a rule here would
 * reintroduce through the UI exactly what the service refuses to impose, and
 * would do it somewhere the API contract's own tests cannot see.
 *
 * Surrounding whitespace is trimmed by the SERVER, which is where that
 * behaviour already lives. Trimming here too would mean two implementations of
 * one rule, free to drift.
 */
export const updateStudentProfile = async (
  registrationNumber: string | null,
): Promise<StudentProfile> => {
  const result = await requestJson<StudentProfileResponse>(
    `${BASE_URL}/user/profile`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      // The whole body. No `userId`, no `id` — the server's field allowlist
      // would refuse them with a 400, and sending them would mean this client
      // believed it could name a row.
      body: JSON.stringify({ registrationNumber }),
    },
  );

  return result.profile;
};
