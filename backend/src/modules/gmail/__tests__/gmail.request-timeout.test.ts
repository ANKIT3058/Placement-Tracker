// PR-8G RED — Gmail HTTP requests must be bounded.
//
// Nothing in the stack sets a request deadline. gaxios attaches a time bound
// only when `opts.timeout` is truthy — it turns that into
// `AbortSignal.timeout()` — and neither googleapis, google-auth-library, nor
// this application ever supplies one. Verified against the installed
// googleapis@173.0.0 / google-auth-library@10.9.1 / gaxios@7.3.1: both the Gmail
// API request and the OAuth token refresh go out with no `timeout` and no
// `signal`. gaxios's retry `totalTimeout` defaults to MAX_SAFE_INTEGER, so
// retries add no ceiling either, and a hang never reaches the retry machinery
// at all — a request that never answers produces no error to retry.
//
// The consequence is not a slow sync. `runSyncCycle` awaits each account in
// sequence and clears `isRunning` only in a `finally`; a `finally` runs when its
// `try` completes or throws, and neither happens when an await never settles.
// So one stalled socket leaves `isRunning === true` for the life of the process,
// every later cycle logs "Previous run still in progress, skipping", and Gmail
// ingestion stops for EVERY user until someone restarts it. One mailbox, all
// users, no recovery.
//
// THE CONTRACT:
//
//     bounded request ─▶ normal rejection ─▶ existing catch ─▶ finally
//                    ─▶ isRunning = false ─▶ next cycle proceeds
//
// The scheduler needs no change. Its error handling is already correct — it is
// only ever reached when the awaited operation settles, which today it need not.
//
// WHAT IS REAL HERE. Only `fetch` is replaced. The real googleapis builds the
// request, the real google-auth-library builds the token refresh, and the real
// gaxios prepares both — including the `opts.timeout` → `AbortSignal.timeout`
// conversion that a fix would rely on. Replacing the transporter instead would
// bypass exactly the machinery under test, so the injection point is
// `transporter.defaults.fetchImplementation`, the lowest layer there is.
//
// Nothing here waits for a real timeout to elapse. A configured timeout is
// observed as the `signal` and `timeout` that reach the network, and the
// recovery half is driven by that signal rather than by the clock.

import { setTimeout as delay } from "node:timers/promises";

type FetchCall = {
  url: string;
  kind: "token" | "gmail";
  timeout: unknown;
  hasSignal: boolean;
};

const mockFetchCalls: FetchCall[] = [];

// Which requests should never answer. A hanging request rejects only if
// something aborts it — which is precisely the bound this suite is about.
let mockHang: { token: boolean; gmail: boolean } = { token: false, gmail: false };

jest.mock("googleapis", () => {
  const actual = jest.requireActual("googleapis");

  const respond = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const fakeFetch = async (input: unknown, init: Record<string, unknown> = {}) => {
    const url = String(input);
    const kind: "token" | "gmail" = url.includes("/token") ? "token" : "gmail";

    mockFetchCalls.push({
      url,
      kind,
      timeout: init.timeout,
      hasSignal: init.signal instanceof AbortSignal,
    });

    if (mockHang[kind]) {
      // Never answers on its own. If a finite timeout was configured, gaxios
      // has attached an AbortSignal and this rejects; if not, it hangs forever,
      // which is exactly today's production behaviour.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;

        if (signal) {
          signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted"), {
              name: "AbortError",
            })),
          );
        }
      });
    }

    if (kind === "token") {
      return respond({
        access_token: "AN_ACCESS_TOKEN",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    return respond({ emailAddress: "mailbox@college.edu", historyId: "901", history: [] });
  };

  // Injected without disturbing anything else on the transporter, so a fix that
  // sets its own gaxios defaults (a timeout among them) survives intact.
  const installFakeFetch = (auth: { transporter?: { defaults?: Record<string, unknown> } }) => {
    if (auth?.transporter?.defaults) {
      auth.transporter.defaults.fetchImplementation = fakeFetch;
    }
  };

  return {
    google: {
      auth: actual.google.auth,
      gmail: (options: { auth: unknown }) => {
        installFakeFetch(options.auth as never);
        // The REAL Gmail service, so the API request travels the real
        // googleapis → gaxios path rather than a stand-in for it.
        return actual.google.gmail(options);
      },
    },
  };
});

/* The production deadline is measured in seconds, which no fast test can wait
   out. Shrunk to 1ms here so the real `AbortSignal.timeout` fires within the
   polling window below — the mechanism under test is unchanged, only the clock
   is. `GMAIL_SYNC_INTERVAL_MS` keeps its real value, which the scheduler test
   advances fake timers by. */
jest.mock("../../../shared/constants/config", () => ({
  ...jest.requireActual("../../../shared/constants/config"),
  GMAIL_REQUEST_TIMEOUT_MS: 1,
}));

type Row = Record<string, unknown>;

const mockRows: Row[] = [];

jest.mock("../../../lib/prisma", () => ({
  prisma: {
    gmailAccount: {
      findUnique: jest.fn(
        async ({ where }: { where: { email: string } }) =>
          mockRows.find((row) => row.email === where.email) ?? null,
      ),
      findMany: jest.fn(async (args?: { where?: Record<string, unknown> }) => {
        const where = args?.where ?? {};
        return mockRows.filter((row) =>
          Object.entries(where).every(
            ([column, value]) => (row[column] ?? null) === (value ?? null),
          ),
        );
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        mockRows.push(data);
        return data;
      }),
      update: jest.fn(
        async ({ where, data }: { where: { email: string }; data: Row }) => {
          const row = mockRows.find((r) => r.email === where.email);
          if (!row) throw new Error(`No GmailAccount ${where.email}`);
          for (const [key, value] of Object.entries(data)) {
            if (value !== undefined) row[key] = value;
          }
          return row;
        },
      ),
    },
  },
}));

jest.mock("../../email/email.repository", () => ({
  createEmail: jest.fn(async () => ({ id: 1, userId: 1 })),
  getEmailByGmailMessageId: jest.fn(async () => null),
}));

jest.mock("../../email/email.producer", () => ({
  enqueueEmailProcessing: jest.fn(async () => undefined),
}));

import { syncGmailAccount } from "../gmail.sync.service";
import { startGmailScheduler } from "../gmail.scheduler";
import { GMAIL_SYNC_INTERVAL_MS } from "../../../shared/constants/config";

const USER = 1;

const seed = (overrides: Row = {}): Row => {
  const row: Row = {
    id: mockRows.length + 1,
    userId: USER,
    email: `mailbox-${mockRows.length + 1}@college.edu`,
    refreshToken: `REFRESH_${mockRows.length + 1}`,
    // Null so the account takes the full-sync path, whose first call is a
    // profile read — the shortest route to an outbound request.
    historyId: null,
    reauthRequiredAt: null,
    ...overrides,
  };

  mockRows.push(row);

  return row;
};

const rowFor = (email: unknown): Row => mockRows.find((row) => row.email === email)!;

const callsOfKind = (kind: "token" | "gmail") =>
  mockFetchCalls.filter((call) => call.kind === kind);

/* Did this promise reach a conclusion — either way — within a bounded number of
   event-loop turns? Deterministic and fast: nothing here waits on the clock, so
   an unbounded request reports `false` instead of hanging the runner. */
const settles = async (work: Promise<unknown>, turns = 30): Promise<boolean> => {
  let done = false;

  // Attached immediately so a rejection is never unhandled.
  void work.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );

  for (let index = 0; index < turns && !done; index += 1) {
    await delay(0);
  }

  return done;
};

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();

  mockRows.length = 0;
  mockFetchCalls.length = 0;
  mockHang = { token: false, gmail: false };

  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
  jest.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * The configuration contract, observed where the request meets the network.
 * ------------------------------------------------------------------ */

describe("every Gmail request reaches the network with a deadline", () => {
  test("the OAuth token refresh carries a finite timeout", async () => {
    const account = seed();

    await syncGmailAccount(account as never);

    const refresh = callsOfKind("token")[0];

    // Control: the refresh really happened. Every mailbox operation performs
    // one, because only a refresh token is ever supplied.
    expect(refresh).toBeDefined();

    // The half a Gmail-only fix would miss. The refresh precedes every Gmail
    // call, so leaving it unbounded leaves the stall fully reachable.
    expect(typeof refresh?.timeout).toBe("number");
    expect(refresh?.timeout as number).toBeGreaterThan(0);
    expect(Number.isFinite(refresh?.timeout as number)).toBe(true);

    // gaxios turns `opts.timeout` into `AbortSignal.timeout`, so a signal on the
    // wire is the observable proof that the request can actually be cancelled
    // rather than merely abandoned.
    expect(refresh?.hasSignal).toBe(true);
  });

  test("the Gmail API request carries a finite timeout", async () => {
    const account = seed();

    await syncGmailAccount(account as never);

    const apiCall = callsOfKind("gmail")[0];

    expect(apiCall).toBeDefined();

    expect(typeof apiCall?.timeout).toBe("number");
    expect(apiCall?.timeout as number).toBeGreaterThan(0);
    expect(Number.isFinite(apiCall?.timeout as number)).toBe(true);
    expect(apiCall?.hasSignal).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The behaviour that configuration buys: a hang becomes an ordinary failure.
 * ------------------------------------------------------------------ */

describe("a request that never answers still ends", () => {
  test("a hanging token refresh eventually rejects", async () => {
    mockHang = { token: true, gmail: false };

    const account = seed();

    // Settles only if something aborts the request. Today nothing does, so the
    // operation is still pending when this returns — which is the whole defect.
    expect(await settles(syncGmailAccount(account as never))).toBe(true);
  });

  test("a hanging Gmail API request eventually rejects", async () => {
    // The refresh succeeds, so the failure lands on the Gmail call itself and
    // proves the second layer is bounded independently of the first.
    mockHang = { token: false, gmail: true };

    const account = seed();

    expect(await settles(syncGmailAccount(account as never))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * THE CENTRAL TEST. The scheduler must survive a stalled mailbox.
 * ------------------------------------------------------------------ */

describe("the scheduler survives a stalled mailbox", () => {
  test("a healthy mailbox still syncs and the next cycle is not skipped", async () => {
    mockHang = { token: false, gmail: true };

    seed({ email: "a@college.edu", refreshToken: "REFRESH_A" });
    seed({ email: "b@college.edu", refreshToken: "REFRESH_B" });

    jest.useFakeTimers({ doNotFake: ["setImmediate", "setTimeout"] });

    startGmailScheduler();

    for (let index = 0; index < 40; index += 1) await delay(0);

    // A stalls, but the loop is sequential — so B is only reached if A's
    // request was bounded. Today B is never attempted at all.
    const attemptedInFirstCycle = mockFetchCalls.length;
    expect(attemptedInFirstCycle).toBeGreaterThan(0);

    mockFetchCalls.length = 0;

    jest.advanceTimersByTime(GMAIL_SYNC_INTERVAL_MS);

    for (let index = 0; index < 40; index += 1) await delay(0);

    jest.clearAllTimers();

    // THE POINT OF THE PR. `isRunning` is cleared in a `finally` that only runs
    // once the awaited operation settles. If cycle 1 never finished, this cycle
    // returns at the guard having made no request at all, and every cycle after
    // it does the same — for every user, until the process restarts.
    expect(mockFetchCalls.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * A timeout is transient. It must not be mistaken for a revoked mailbox.
 * ------------------------------------------------------------------ */

describe("a timeout is not a revoked authorization", () => {
  test("a timed-out sync leaves the mailbox eligible", async () => {
    mockHang = { token: true, gmail: false };

    const account = seed({ email: "a@college.edu" });

    await settles(syncGmailAccount(account as never));

    // PR-8F marks a mailbox only on HTTP 400 + `invalid_grant`. A network
    // deadline is transient by definition, and disabling automatic sync over
    // one would strand a user whose authorization is perfectly valid.
    expect(rowFor(account.email).reauthRequiredAt ?? null).toBeNull();
  });
});
