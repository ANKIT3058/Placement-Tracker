/* The one place a non-2xx response becomes an error.

   Every call in this folder used to end in `res.json()` with no look at
   `res.ok`, so a 401 body — `{ success: false, message: "Authentication
   required" }` — came back looking exactly like data. The Dashboard then
   rendered "No events yet", telling a signed-out user their account was empty.

   `status` is carried on the error because it is the smallest thing that keeps
   the three outcomes apart: 401 means sign in, any other failure means
   something broke, and a 2xx with an empty list means the account really is
   empty. A caller that cannot tell those apart cannot say anything true. */

export class ApiError extends Error {
  status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

/* Performs the request and returns the parsed body, or throws.

   A network failure (no response at all) propagates untouched: `fetch` already
   rejects with a TypeError, there is no status to attach, and wrapping it would
   only obscure the cause. */
export const requestJson = async <T>(
  url: string,
  init?: RequestInit,
): Promise<T> => {
  const res = await fetch(url, init);

  if (!res.ok) {
    throw new ApiError(res.status);
  }

  return (await res.json()) as T;
};
