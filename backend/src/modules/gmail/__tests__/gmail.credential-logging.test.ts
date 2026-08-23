// PR-8E RED — OAuth credentials must never reach the application log.
//
// When google-auth-library refreshes an access token it POSTs a body built from
// the mailbox's own credentials:
//
//     URLSearchParams { refresh_token, client_id, client_secret, grant_type }
//
// If Google refuses — `invalid_grant`, which is exactly what a revoked mailbox
// returns — gaxios throws a `GaxiosError` carrying that request config as a
// public own property. Every Gmail catch in this codebase then hands the whole
// error object to `console.error(message, error)`, and Node's formatter walks
// those own properties. The refresh token is printed in clear text.
//
// That is a long-lived `gmail.readonly` credential written to stdout, and from
// there into the platform's log store and anything that ingests it — a
// materially weaker boundary than the database the token is otherwise kept in.
// It needs no attacker: revoking access in Google's account settings is enough,
// and the scheduler then reproduces it every couple of minutes for as long as
// the row exists.
//
// WHAT IS REAL HERE, AND WHY IT MATTERS. The credential-bearing object is not
// constructed by this test. The real `OAuth2Client` builds the real refresh
// request from the real stored refresh token and the real client secret, and
// that untouched options object is what becomes `GaxiosError.config` — thrown
// through gaxios's own error class. Only the transport is replaced, which is
// the narrowest boundary that still produces the production error: a socket is
// not part of the mechanism under test, and depending on one would make the
// suite fragile for no gain in fidelity.
//
// The captured output is equally real. `util.format(...args)` is precisely what
// `console.error` applies to its arguments before writing — same default
// inspect depth — so these assertions read the bytes the log stream would
// actually receive, never a deeper serialization that could invent a leak
// production does not have.

import { format } from "node:util";

// Markers, never real secrets. If either string is printed, a credential escaped.
const REFRESH_TOKEN_MARKER = "REFRESH_TOKEN_SHOULD_NEVER_APPEAR";
const CLIENT_SECRET_MARKER = "CLIENT_SECRET_SHOULD_NEVER_APPEAR";

// How many token refreshes succeed before the stub starts refusing. Lets a test
// place the failure on a specific Gmail call rather than always the first.
let mockRefreshesBeforeFailure = 0;
let mockRefreshCount = 0;

jest.mock("googleapis", () => {
  const actual = jest.requireActual("googleapis");
  const { GaxiosError } = jest.requireActual("gaxios");

  // Replace ONLY the transport. Everything upstream of it — the client, its
  // credentials, and the request body carrying them — stays real.
  const stubTransport = (auth: any) => {
    if (auth.__transportStubbed) return;
    auth.__transportStubbed = true;

    auth.transporter = {
      async request(opts: any) {
        mockRefreshCount += 1;

        if (mockRefreshCount <= mockRefreshesBeforeFailure) {
          return {
            data: {
              access_token: "an-access-token",
              token_type: "Bearer",
              expires_in: 3600,
            },
            status: 200,
            headers: {},
            config: opts,
          };
        }

        // What Google answers for a revoked or expired refresh token. `opts` is
        // the library's own options object, so the error carries the genuine
        // credential-bearing body — exactly as in production.
        throw new GaxiosError("invalid_grant", opts, {
          status: 400,
          data: {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          },
          headers: {},
          config: opts,
        });
      },
    };
  };

  const authenticate = async (auth: any) => {
    stubTransport(auth);
    await auth.getRequestHeaders();
  };

  return {
    google: {
      auth: actual.google.auth,

      gmail: ({ auth }: any) => ({
        users: {
          getProfile: async () => {
            await authenticate(auth);
            return { data: { emailAddress: "mailbox@college.edu", historyId: "500" } };
          },
          messages: {
            list: async () => {
              await authenticate(auth);
              return { data: { messages: [{ id: "msg-1" }] } };
            },
            get: async () => {
              await authenticate(auth);
              return { data: { id: "msg-1", payload: {} } };
            },
            attachments: {
              get: async () => {
                await authenticate(auth);
                return { data: { data: "" } };
              },
            },
          },
          history: {
            list: async () => {
              await authenticate(auth);
              return { data: { historyId: "501", history: [] } };
            },
          },
        },
      }),
    },
  };
});

const MAILBOX = "mailbox@college.edu";
const USER_ID = 7;


jest.mock("../gmail.repository", () => ({
  getGmailAccountsByUser: jest.fn(async () => [
    {
      id: 1,
      email: "mailbox@college.edu",
      refreshToken: "REFRESH_TOKEN_SHOULD_NEVER_APPEAR",
      historyId: null,
      userId: 7,
    },
  ]),
  getAllGmailAccounts: jest.fn(async () => [
    {
      id: 1,
      email: "mailbox@college.edu",
      refreshToken: "REFRESH_TOKEN_SHOULD_NEVER_APPEAR",
      historyId: null,
      userId: 7,
    },
  ]),
  updateHistoryId: jest.fn(async () => ({})),
}));

jest.mock("../../email/email.repository", () => ({
  createEmail: jest.fn(async () => ({ id: 1, userId: 7 })),
  getEmailByGmailMessageId: jest.fn(async () => null),
}));

jest.mock("../../email/email.producer", () => ({
  enqueueEmailProcessing: jest.fn(async () => undefined),
}));

import { syncUserMailboxes } from "../gmail.sync.service";
import { startGmailScheduler } from "../gmail.scheduler";

/* Everything `console.error` would have written, formatted as the console
   formats it. */
let logged: string[] = [];
let errorSpy: jest.SpyInstance;

const capturedOutput = () => logged.join("\n");

let originalClientSecret: string | undefined;

beforeAll(() => {
  originalClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  // Read by `createOAuthClient()` when each operation builds its client, so the
  // secret genuinely travels in the refresh body.
  process.env.GOOGLE_CLIENT_SECRET = CLIENT_SECRET_MARKER;
});

afterAll(() => {
  process.env.GOOGLE_CLIENT_SECRET = originalClientSecret;
});

beforeEach(() => {
  jest.clearAllMocks();

  mockRefreshCount = 0;
  mockRefreshesBeforeFailure = 0;
  logged = [];

  errorSpy = jest
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      logged.push(format(...args));
    });
});

afterEach(() => {
  // Restored every time so no global mock leaks into another test.
  errorSpy.mockRestore();
  jest.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * THE CENTRAL TEST. The recurring production path.
 * ------------------------------------------------------------------ */

describe("a failed mailbox sync does not log the mailbox's credentials", () => {
  test("the refresh token never reaches the log", async () => {
    await syncUserMailboxes({ userId: USER_ID });

    // Control: the failure really happened and really was logged. Without this,
    // an implementation that logged nothing at all would pass.
    expect(capturedOutput()).not.toBe("");

    // THE SECURITY PROPERTY. A `gmail.readonly` credential for this user's
    // mailbox must not be written to a log stream.
    expect(capturedOutput()).not.toContain(REFRESH_TOKEN_MARKER);
  });

  test("the client secret never reaches the log", async () => {
    await syncUserMailboxes({ userId: USER_ID });

    // The same request body carries the application's OAuth client secret.
    // Whether today's formatter happens to reach it is not the point — the
    // contract forbids it either way.
    expect(capturedOutput()).not.toContain(CLIENT_SECRET_MARKER);
  });

  test("the failure is still diagnosable", async () => {
    await syncUserMailboxes({ userId: USER_ID });

    // Redaction must not become silence. A fix that logged "Gmail sync failed"
    // and nothing else would satisfy every assertion above while making a
    // revoked mailbox impossible to diagnose, so the useful half of the
    // contract is pinned too: which mailbox, which user, and why.
    expect(capturedOutput()).toContain(MAILBOX);
    expect(capturedOutput()).toContain(String(USER_ID));
    expect(capturedOutput()).toContain("invalid_grant");
  });
});

/* ------------------------------------------------------------------ *
 * The per-message catch — a second, independent log call.
 * ------------------------------------------------------------------ */

describe("a failed message fetch does not log the mailbox's credentials", () => {
  test("the refresh token never reaches the log", async () => {
    // Let the two calls that open a full sync succeed — `getLatestHistoryId`
    // and `getRecentMessages` — so the failure lands inside `processMessages`,
    // which logs through a different call site than the mailbox-level catch.
    mockRefreshesBeforeFailure = 2;

    await syncUserMailboxes({ userId: USER_ID });

    // Confirms the failure reached the per-message catch and not the outer one.
    expect(capturedOutput()).toContain("msg-1");
    expect(capturedOutput()).not.toContain(REFRESH_TOKEN_MARKER);
  });
});

/* ------------------------------------------------------------------ *
 * The scheduler — the most damaging path, because it repeats forever.
 * ------------------------------------------------------------------ */

describe("the background scheduler does not log mailbox credentials", () => {
  test("the refresh token never reaches the log", async () => {
    // Fake timers so the interval this installs can never fire. The assertion
    // is about the cycle the scheduler runs immediately on start, which is a
    // promise chain rather than a timer, so nothing here waits on real time.
    // `setImmediate` is left real: it is how this test drains the cycle, and
    // faking it would make the drain never resolve.
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });

    startGmailScheduler();

    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    jest.clearAllTimers();

    expect(capturedOutput()).not.toBe("");
    expect(capturedOutput()).not.toContain(REFRESH_TOKEN_MARKER);
  });
});

/* ------------------------------------------------------------------ *
 * The response body is a second way out. A guard, not a known defect.
 * ------------------------------------------------------------------ */

describe("a failed sync does not return credentials to the caller", () => {
  test("the per-mailbox error message carries no credentials", async () => {
    const result = await syncUserMailboxes({ userId: USER_ID });

    const body = JSON.stringify(result);

    expect(body).not.toContain(REFRESH_TOKEN_MARKER);
    expect(body).not.toContain(CLIENT_SECRET_MARKER);
  });
});
