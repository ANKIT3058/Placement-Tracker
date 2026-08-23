// PR-8D RED — one Gmail operation must never authenticate as another mailbox.
//
// `gmail.service.ts` builds ONE `OAuth2Client` at module scope and every Gmail
// helper mutates it with `setCredentials({ refresh_token })` before use. That
// is shared mutable credential state in a process that serves many users at
// once — the API process runs the Gmail scheduler alongside HTTP handlers, so a
// scheduler sync and a `POST /gmail/sync` genuinely overlap.
//
// Five of the six call sites survive that today, and only by an implementation
// detail of google-auth-library: `getRequestMetadataAsync` captures
// `this.credentials` SYNCHRONOUSLY, before any await, so a single-call helper
// has already taken its own credentials by the time anything else can run. That
// is not a documented API guarantee, and a minor release could withdraw it.
//
// `getHistoryChanges` does not survive it. It calls `setCredentials` ONCE and
// then paginates, so pages 2..N are issued AFTER an await and re-read whatever
// the shared client holds by then. The damage is not abstract: the historyId
// that walk returns is written straight onto the syncing account as its
// incremental cursor, so a crossed page hands mailbox A a watermark taken from
// mailbox B — and A then silently skips the mail in between.
//
// WHAT THESE TESTS OBSERVE. Not `oauth2Client.credentials`, which would only
// show what the object happens to contain; the assertions are on the
// `Authorization` header the Google request actually carries. The real
// google-auth-library does the credential capture, the refresh and the header
// construction here — only the network transport and the Gmail HTTP surface are
// replaced. A test that mocked the OAuth client itself could not detect shared
// mutable state at all, which is the whole point.
//
// The mocked Gmail surface reads credentials via `auth.getRequestHeaders()` as
// the FIRST thing each API method does, which reproduces the real path:
// `users.history.list` → `createAPIRequestAsync` → `authClient.request` →
// `requestAsync` → `getRequestMetadataAsync`, all synchronous through to the
// capture (verified against googleapis-common@8.0.3 — `getUniverseDomain` is
// absent from OAuth2Client, so the one await that could precede the capture
// never runs).
//
// The mock takes `auth` from whatever client production passes to
// `google.gmail({ auth })`, so these tests keep working when the GREEN fix
// gives each operation its own client.

// Recorded `Authorization` per Google API call, in order.
const mockRecorded: { op: string; authorization: string | null }[] = [];

// Runs once, during page 1 of the history walk — the await window in which
// another user's request lands. Set per test; deterministic, never timed.
let mockDuringPage1: null | (() => Promise<unknown>) = null;

// Barrier: when set, user A's token refresh parks here until released.
let mockHoldRefreshA: Promise<void> | null = null;

let mockHistoryCalls = 0;

jest.mock("googleapis", () => {
  const actual = jest.requireActual("googleapis");

  // REFRESH_A -> ACCESS_A, REFRESH_B -> ACCESS_B. The mapping is the whole
  // instrument: an Authorization header names the mailbox it came from.
  const accessTokenFor = (refreshToken: string | null) =>
    refreshToken === "REFRESH_A"
      ? "ACCESS_A"
      : refreshToken === "REFRESH_B"
        ? "ACCESS_B"
        : `ACCESS_FOR_${refreshToken}`;

  const installTransport = (auth: any) => {
    if (auth.__isolationTransport) return;
    auth.__isolationTransport = true;

    auth.transporter = {
      async request(opts: any) {
        const url = String(opts.url ?? "");

        if (!url.includes("token")) {
          return { data: {}, status: 200, headers: {}, config: {} };
        }

        const raw =
          typeof opts.data === "string"
            ? opts.data
            : new URLSearchParams(opts.data ?? {}).toString();
        const refreshToken = new URLSearchParams(raw).get("refresh_token");

        if (refreshToken === "REFRESH_A" && mockHoldRefreshA) {
          const held = mockHoldRefreshA;
          mockHoldRefreshA = null;
          await held;
        }

        return {
          data: {
            access_token: accessTokenFor(refreshToken),
            token_type: "Bearer",
            expiry_date: Date.now() + 3_600_000,
          },
          status: 200,
          headers: {},
          config: {},
        };
      },
    };
  };

  // Reads the credentials the same way and at the same moment the real request
  // path does, and records what went on the wire.
  const record = async (auth: any, op: string): Promise<string | null> => {
    installTransport(auth);

    const headers = await auth.getRequestHeaders();
    const authorization =
      typeof headers?.get === "function"
        ? headers.get("authorization")
        : (headers?.authorization ?? null);

    mockRecorded.push({ op, authorization });

    return authorization;
  };

  return {
    google: {
      // Real OAuth2Client: the credential capture, refresh and header
      // construction under test must be the library's, not a stand-in.
      auth: actual.google.auth,

      gmail: ({ auth }: any) => ({
        users: {
          getProfile: async () => {
            await record(auth, "getProfile");
            return { data: { emailAddress: "mailbox@x", historyId: "PROFILE_HISTORY" } };
          },
          messages: {
            list: async () => {
              await record(auth, "messages.list");
              return { data: { messages: [] } };
            },
            get: async () => {
              await record(auth, "messages.get");
              return { data: { id: "msg-1", payload: {} } };
            },
            attachments: {
              get: async () => {
                await record(auth, "attachments.get");
                return { data: { data: Buffer.from("bytes").toString("base64url") } };
              },
            },
          },
          history: {
            list: async () => {
              const authorization = await record(auth, "history.list");

              mockHistoryCalls += 1;

              if (mockHistoryCalls === 1) {
                // The await window. Another user's request runs to completion
                // here, exactly as it may while page 1 is on the network.
                if (mockDuringPage1) {
                  const interleaved = mockDuringPage1;
                  mockDuringPage1 = null;
                  await interleaved();
                }

                return {
                  data: { historyId: "A_PAGE_1", history: [], nextPageToken: "page-2" },
                };
              }

              // The final page decides the cursor that gets persisted. It is
              // derived from the credentials actually used, so a crossed page
              // is visible in the returned watermark and not only in a header.
              return {
                data: {
                  historyId:
                    authorization === "Bearer ACCESS_A" ? "A_FINAL" : "B_FINAL",
                  history: [],
                },
              };
            },
          },
        },
      }),
    },
  };
});

// Cursor integrity is asserted at `syncGmailAccount`, the smallest boundary at
// which the returned historyId actually reaches the database.
jest.mock("../gmail.repository", () => ({
  updateHistoryId: jest.fn(async () => ({})),
  getGmailAccountsByUser: jest.fn(async () => []),
}));

jest.mock("../../email/email.repository", () => ({
  createEmail: jest.fn(async () => ({ id: 1, userId: 1 })),
  getEmailByGmailMessageId: jest.fn(async () => null),
}));

jest.mock("../../email/email.producer", () => ({
  enqueueEmailProcessing: jest.fn(async () => undefined),
}));

import {
  oauth2Client,
  getHistoryChanges,
  getRecentMessages,
  getMessageDetails,
  getLatestHistoryId,
  getAttachmentData,
} from "../gmail.service";
import { syncGmailAccount } from "../gmail.sync.service";
import { updateHistoryId } from "../gmail.repository";

const REFRESH_A = "REFRESH_A";
const REFRESH_B = "REFRESH_B";

const historyCalls = () => mockRecorded.filter((call) => call.op === "history.list");

beforeEach(() => {
  jest.clearAllMocks();

  mockRecorded.length = 0;
  mockHistoryCalls = 0;
  mockDuringPage1 = null;
  mockHoldRefreshA = null;

  // Each test starts from a client holding nothing, so no assertion can pass on
  // credentials left behind by the test before it.
  oauth2Client.setCredentials({});
});

/* ------------------------------------------------------------------ *
 * THE CENTRAL TEST. The paginated walk must stay on one mailbox.
 * ------------------------------------------------------------------ */

describe("a paginated history walk stays on the mailbox it started on", () => {
  test("every page authenticates as the mailbox being synced", async () => {
    // User B's request lands while page 1 is in flight. This models the
    // interleaving the API process already permits between a scheduler sync and
    // a POST /gmail/sync — no timers, no sleeps: B runs to completion inside
    // page 1's await and the ordering is fixed by the barrier, not by timing.
    mockDuringPage1 = () => getLatestHistoryId(REFRESH_B);

    await getHistoryChanges(REFRESH_A, "1");

    const pages = historyCalls();

    expect(pages).toHaveLength(2);

    // Page 1 is safe: the credentials are captured synchronously, before
    // anything else can run.
    expect(pages[0]?.authorization).toBe("Bearer ACCESS_A");

    // Page 2 is the vulnerability. `setCredentials` ran once, before the loop,
    // so this page re-reads a shared client that user B has since overwritten.
    expect(pages[1]?.authorization).toBe("Bearer ACCESS_A");
  });

  test("the walk never reads a page as another mailbox", async () => {
    mockDuringPage1 = () => getLatestHistoryId(REFRESH_B);

    await getHistoryChanges(REFRESH_A, "1");

    // Stated as a negative as well, because it is the security property itself:
    // no part of A's operation may carry B's credentials.
    expect(historyCalls().map((call) => call.authorization)).not.toContain(
      "Bearer ACCESS_B",
    );
  });
});

/* ------------------------------------------------------------------ *
 * THE IMPACT. A crossed page corrupts the mailbox's sync cursor.
 * ------------------------------------------------------------------ */

describe("the persisted sync cursor belongs to the mailbox that was synced", () => {
  test("getHistoryChanges returns its own mailbox's historyId", async () => {
    mockDuringPage1 = () => getLatestHistoryId(REFRESH_B);

    const result = await getHistoryChanges(REFRESH_A, "1");

    expect(result.latestHistoryId).toBe("A_FINAL");
  });

  test("syncGmailAccount writes its own mailbox's historyId", async () => {
    mockDuringPage1 = () => getLatestHistoryId(REFRESH_B);

    await syncGmailAccount({
      id: 1,
      email: "a@college.edu",
      refreshToken: REFRESH_A,
      historyId: "1",
      userId: 1,
    });

    // THE BUSINESS IMPACT. A watermark taken from another mailbox is not a
    // cosmetic error: incremental sync trusts this cursor, so mail arriving in
    // A's mailbox between the two positions is never fetched again. The
    // service's own comment demands exactly this — "overlap is safe, gaps are
    // not" — and a crossed cursor creates a gap.
    expect(updateHistoryId).toHaveBeenCalledWith("a@college.edu", "A_FINAL");
  });
});

/* ------------------------------------------------------------------ *
 * Overlapping operations. The invariant the single-call sites rely on.
 * ------------------------------------------------------------------ */

describe("overlapping operations keep their own credentials", () => {
  test("an operation held mid-flight still finishes as its own mailbox", async () => {
    // Explicit barrier, not a delay: A parks inside its token refresh until
    // this promise is resolved, so B is guaranteed to complete in between.
    let release!: () => void;
    mockHoldRefreshA = new Promise<void>((resolve) => {
      release = resolve;
    });

    const userA = getRecentMessages(REFRESH_A);

    // B runs a whole operation while A is parked, leaving the shared client
    // holding B's credentials.
    await getRecentMessages(REFRESH_B);

    release();
    await userA;

    const listCalls = mockRecorded.filter((call) => call.op === "messages.list");

    expect(listCalls).toHaveLength(2);
    expect(listCalls.map((call) => call.authorization).sort()).toEqual([
      "Bearer ACCESS_A",
      "Bearer ACCESS_B",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Single-call regression guards.
 *
 * These pass today. They are here because they pass for a reason the codebase
 * does not control — the library's synchronous credential capture — and a
 * refactor that moved any of these behind an await would break them silently.
 * ------------------------------------------------------------------ */

describe("each mailbox operation authenticates as its own mailbox", () => {
  const OPERATIONS = [
    { name: "getRecentMessages", run: (token: string) => getRecentMessages(token) },
    { name: "getMessageDetails", run: (token: string) => getMessageDetails(token, "msg-1") },
    { name: "getLatestHistoryId", run: (token: string) => getLatestHistoryId(token) },
    {
      name: "getAttachmentData",
      run: (token: string) => getAttachmentData(token, "msg-1", "att-1"),
    },
  ];

  test.each(OPERATIONS)("$name uses only its own credentials", async ({ run }) => {
    // Another mailbox's credentials are already loaded on the shared client
    // when the operation begins — the state a previous request leaves behind.
    oauth2Client.setCredentials({ refresh_token: REFRESH_B });

    await run(REFRESH_A);

    expect(mockRecorded).toHaveLength(1);
    expect(mockRecorded[0]?.authorization).toBe("Bearer ACCESS_A");
  });
});

/* ------------------------------------------------------------------ *
 * The architectural contract PR-8D GREEN must satisfy.
 * ------------------------------------------------------------------ */

describe("a mailbox operation owns its credentials privately", () => {
  test("it does not leave a mailbox's refresh token on the shared client", async () => {
    await getRecentMessages(REFRESH_A);

    // Stated behaviourally rather than as `clientA !== clientB`: what matters
    // is that no mailbox's credentials outlive the operation on state another
    // operation can reach. A per-operation client satisfies this for free; the
    // module-level singleton cannot satisfy it at all.
    expect(oauth2Client.credentials.refresh_token).toBeUndefined();
  });
});
