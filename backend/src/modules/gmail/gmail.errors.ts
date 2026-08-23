/* Safe diagnostics for Gmail failures (RFC-001 §13.2).
 *
 * A Gmail call that needs a fresh access token makes google-auth-library POST a
 * body built from the mailbox's own credentials:
 *
 *     URLSearchParams { refresh_token, client_id, client_secret, grant_type }
 *
 * When Google refuses — `invalid_grant`, which is exactly what a revoked
 * mailbox returns — gaxios throws a `GaxiosError` that carries that request
 * config as a public own property. Handing such an error to
 * `console.error(message, error)` makes Node's formatter walk those properties
 * and print the refresh token in clear text: a long-lived `gmail.readonly`
 * credential written to stdout, and from there into whatever ingests the logs.
 * No attacker is involved — revoking access in Google's own settings is enough,
 * and the scheduler then repeats it every cycle for as long as the row exists.
 *
 * ALLOWLIST, NOT DENYLIST, and that is the whole design. Stripping `config` off
 * the error and logging the rest would close today's hole and silently reopen
 * it the first time the library grew another field holding request data. Here
 * nothing reaches a log unless it was named below, so an unknown future field
 * is excluded by default rather than by remembering to exclude it.
 *
 * Every field is read from the RESPONSE side of the exchange. That asymmetry is
 * the reason this is safe: credentials travel in the request, and Google's
 * error responses describe the refusal without echoing what was sent.
 */

// Deliberately narrow. Everything here is either a short identifier from Google
// or a value this application itself produced.
export type GmailErrorSummary = {
  // `GaxiosError.message` is derived from the response body — for a token
  // failure it is Google's own `error` field, e.g. "invalid_grant". It is never
  // built from the request, so it cannot carry a credential.
  message: string;

  // HTTP status of the refusal, e.g. 400 for invalid_grant, 401/403 otherwise.
  status?: number;

  // Transport-level code where one exists, e.g. "ECONNRESET" or "TimeoutError".
  code?: string | number;

  // Google's machine-readable identifier, e.g. "invalid_grant". Worth carrying
  // separately from `message` because the message can be reworded by the
  // library while this stays stable enough to alert on.
  googleError?: string;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/* Reduce any thrown value to the few fields that are safe to log.
 *
 * Takes `unknown` rather than `Error`: a catch block receives whatever was
 * thrown, and a helper that assumed otherwise would either need a cast at every
 * call site or would throw while handling an error.
 */
export const describeGmailError = (error: unknown): GmailErrorSummary => {
  const summary: GmailErrorSummary = {
    message: error instanceof Error ? error.message : "Unknown error",
  };

  const record = asRecord(error);

  if (!record) {
    return summary;
  }

  const response = asRecord(record.response);

  // `GaxiosError` sets `status` from the response; older shapes only carry it
  // on the response itself, so both are read.
  const status = record.status ?? response?.status;

  if (typeof status === "number") {
    summary.status = status;
  }

  if (typeof record.code === "string" || typeof record.code === "number") {
    summary.code = record.code;
  }

  // `response.data` as a whole is NOT passed through — only this one field, and
  // only when it is a string. Google's REST errors put an object here whose
  // contents vary by API, and copying that shape wholesale would be the same
  // open-ended serialization this helper exists to prevent.
  const googleError = asRecord(response?.data)?.error;

  if (typeof googleError === "string") {
    summary.googleError = googleError;
  }

  return summary;
};
