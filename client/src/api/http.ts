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

/* The server's explanation for a failure, when it sent one.

   Every client-facing error in this backend answers with a `message` — and
   `message` alone is read. Reaching for whatever other fields happen to be
   present would turn the contract into "display any string the server sent",
   which is a much larger promise than the one the backend makes.

   Every failure to READ the body is swallowed. An error response may be empty,
   plain text, or malformed JSON, and in each case the HTTP failure is still the
   truth: a SyntaxError surfacing where a 500 belongs would be strictly worse
   than having no message at all. Reading why a request failed must never be
   able to replace the fact that it did. */
const serverMessage = async (res: Response): Promise<string | undefined> => {
  try {
    const body: unknown = await res.json();

    if (typeof body === "object" && body !== null) {
      const message = (body as { message?: unknown }).message;

      if (typeof message === "string" && message.trim() !== "") {
        return message;
      }
    }
  } catch {
    // Unreadable body — the status is all we can report.
  }

  return undefined;
};

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
    throw new ApiError(res.status, await serverMessage(res));
  }

  return (await res.json()) as T;
};
