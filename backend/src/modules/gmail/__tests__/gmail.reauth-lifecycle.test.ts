// PR-8F RED — a permanently revoked mailbox must stop being retried.
//
// When a user revokes this application's access in their Google account, every
// subsequent token refresh answers `invalid_grant` (HTTP 400). Google documents
// that as terminal: the token "may have expired or has been invalidated", and
// the remedy is to "authenticate the user again and ask for user consent".
// Presenting the same refresh token again cannot succeed, by definition.
//
// The scheduler nevertheless attempts it on every cycle. At the default
// 120-second interval that is ~720 futile token requests per day per account,
// forever, and — the part that actually matters — the mailbox looks completely
// healthy the whole time. There is no state on `GmailAccount` to say otherwise:
// the row carries `id, userId, provider, email, refreshToken, historyId,
// connectedAt, createdAt` and nothing about authentication health. So
// ingestion stops permanently while the dashboard keeps rendering the events it
// already had, and if the outage outlives Gmail's history cursor the messages
// in between are never fetched at all.
//
// THE CONTRACT THESE TESTS PIN:
//
//     ACTIVE ──invalid_grant──▶ REAUTH_REQUIRED ──reconnect──▶ ACTIVE
//
// expressed as `reauthRequiredAt` becoming non-null, the account dropping out
// of automatic sync, and a successful reconnect clearing it. Production has no
// such state today — this suite is the specification for it, not a description
// of it.
//
// WHAT IS OBSERVED, AND WHY. Assertions are on persisted row state and on which
// refresh tokens actually reached Google, never on a named production helper.
// A test asserting `markReauthRequired()` was called would prescribe an
// implementation; these assert the behaviour, so GREEN stays free to choose how
// it writes the state as long as the lifecycle holds.
//
// The Prisma double is in-memory but the repository functions running against
// it are the real ones, so `connectGmailAccount`'s actual update semantics —
// including the fact that it deliberately leaves `historyId` alone — are what
// the reconnect tests exercise.

// Which outcome the stubbed token endpoint gives each refresh token.
type TokenOutcome = "ok" | "invalid_grant" | "503" | "429" | "401";

const mockTokenPolicy = new Map<string, TokenOutcome>();

// Every refresh token presented to Google, in order. This is how "the account
// was not attempted" is observed.
const mockAttempts: string[] = [];

jest.mock("googleapis", () => {
  const actual = jest.requireActual("googleapis");
  const { GaxiosError } = jest.requireActual("gaxios");

  const FAILURES: Record<string, { status: number; error: string }> = {
    invalid_grant: { status: 400, error: "invalid_grant" },
    "503": { status: 503, error: "backendError" },
    "429": { status: 429, error: "rateLimitExceeded" },
    "401": { status: 401, error: "authError" },
  };

  const stubTransport = (auth: any) => {
    if (auth.__transportStubbed) return;
    auth.__transportStubbed = true;

    auth.transporter = {
      async request(opts: any) {
        const raw =
          typeof opts.data === "string"
            ? opts.data
            : new URLSearchParams(opts.data ?? {}).toString();
        const refreshToken = new URLSearchParams(raw).get("refresh_token") ?? "";

        mockAttempts.push(refreshToken);

        const outcome = mockTokenPolicy.get(refreshToken) ?? "ok";

        if (outcome !== "ok") {
          const failure = FAILURES[outcome]!;

          // The real Google error shape, not `new Error("invalid_grant")`: a
          // classifier worth having must key off `status` and
          // `response.data.error`, so the test must present both.
          throw new GaxiosError(failure.error, opts, {
            status: failure.status,
            data: { error: failure.error },
            headers: {},
            config: opts,
            // A real response has had its body read by the time gaxios builds
            // the error, and gaxios keeps `data` only when `bodyUsed` is true.
            // Without this the double would silently drop `response.data` and
            // no classifier could ever see the Google error code.
            bodyUsed: true,
          });
        }

        return {
          data: {
            access_token: `ACCESS_FOR_${refreshToken}`,
            token_type: "Bearer",
            expires_in: 3600,
          },
          status: 200,
          headers: {},
          config: opts,
        };
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
            return { data: { emailAddress: "mailbox", historyId: "900" } };
          },
          messages: {
            list: async () => {
              await authenticate(auth);
              return { data: { messages: [] } };
            },
            get: async () => {
              await authenticate(auth);
              return { data: { id: "m", payload: {} } };
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
              return { data: { historyId: "901", history: [] } };
            },
          },
        },
      }),
    },
  };
});

/* An in-memory stand-in for the `gmailAccount` table, so the REAL repository
   functions run against it and the assertions can read row state directly. */
type Row = Record<string, unknown>;

const mockRows: Row[] = [];

jest.mock("../../../lib/prisma", () => ({
  prisma: {
    gmailAccount: {
      findUnique: jest.fn(async ({ where }: { where: { email: string } }) =>
        mockRows.find((row) => row.email === where.email) ?? null,
      ),
      findMany: jest.fn(async (args?: { where?: Record<string, unknown> }) => {
        const where = args?.where ?? {};

        // Every predicate is applied, so a resolver that filters on
        // `reauthRequiredAt` is actually filtered here too. Nullish values are
        // normalised because Prisma treats an absent column as null.
        return mockRows.filter((row) =>
          Object.entries(where).every(
            ([column, value]) => (row[column] ?? null) === (value ?? null),
          ),
        );
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { historyId: null, ...data };
        mockRows.push(row);
        return row;
      }),
      update: jest.fn(
        async ({ where, data }: { where: { email: string }; data: Row }) => {
          const row = mockRows.find((r) => r.email === where.email);
          if (!row) throw new Error(`No GmailAccount ${where.email}`);
          // Prisma treats an omitted/undefined field as "leave unchanged".
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

import { syncUserMailboxes } from "../gmail.sync.service";
import { startGmailScheduler } from "../gmail.scheduler";
import { connectGmailAccount } from "../gmail.repository";
import { GMAIL_SYNC_INTERVAL_MS } from "../../../shared/constants/config";

const USER = 1;
const REVOKED = "REFRESH_REVOKED";
const HEALTHY = "REFRESH_HEALTHY";

const seed = (overrides: Row = {}): Row => {
  const row: Row = {
    id: mockRows.length + 1,
    userId: USER,
    email: `mailbox-${mockRows.length + 1}@college.edu`,
    refreshToken: HEALTHY,
    historyId: "500",
    reauthRequiredAt: null,
    ...overrides,
  };

  mockRows.push(row);

  return row;
};

const rowFor = (email: unknown): Row =>
  mockRows.find((row) => row.email === email)!;

/* Lets the scheduler's promise chain settle without waiting on real time.
   Bounded and deterministic — not a retry loop. */
const drain = async (turns = 12) => {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();

  mockRows.length = 0;
  mockAttempts.length = 0;
  mockTokenPolicy.clear();

  // The paths under test log a refused sync on purpose (PR-8E). Silenced so a
  // deliberate failure does not look like a broken run.
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
 * ACTIVE ──invalid_grant──▶ REAUTH_REQUIRED
 * ------------------------------------------------------------------ */

describe("a permanently revoked mailbox is marked as needing reauthorization", () => {
  test("invalid_grant marks the account", async () => {
    const account = seed({ refreshToken: REVOKED });
    mockTokenPolicy.set(REVOKED, "invalid_grant");

    await syncUserMailboxes({ userId: USER });

    // Control: the refusal really happened.
    expect(mockAttempts).toEqual([REVOKED]);

    // Google calls this terminal — the same token can never succeed again, so
    // the account must carry that fact rather than looking healthy forever.
    expect(rowFor(account.email).reauthRequiredAt).not.toBeNull();
    expect(rowFor(account.email).reauthRequiredAt).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * The boundary. Only invalid_grant is terminal.
 * ------------------------------------------------------------------ */

describe("a recoverable failure leaves the mailbox eligible", () => {
  const RECOVERABLE: TokenOutcome[] = ["503", "429", "401"];

  test.each(RECOVERABLE)(
    "a %s failure does not mark the account",
    async (outcome) => {
      const account = seed({ refreshToken: "REFRESH_FLAKY" });
      mockTokenPolicy.set("REFRESH_FLAKY", outcome);

      await syncUserMailboxes({ userId: USER });

      expect(mockAttempts).toEqual(["REFRESH_FLAKY"]);

      // 5xx and 429 are transient by definition. 401 and 403 are ambiguous —
      // a 401 is routinely cured by the refresh the library already performs,
      // and a 403 covers rate limits as readily as policy errors. Disabling a
      // mailbox on any of them would strand a user whose mailbox is fine.
      expect(rowFor(account.email).reauthRequiredAt ?? null).toBeNull();
    },
  );
});

/* ------------------------------------------------------------------ *
 * One broken mailbox must not take the others down with it.
 * ------------------------------------------------------------------ */

describe("a revoked mailbox does not stop a healthy one", () => {
  test("the healthy mailbox still syncs and advances its cursor", async () => {
    const revoked = seed({ refreshToken: REVOKED, email: "a@college.edu" });
    const healthy = seed({ refreshToken: HEALTHY, email: "b@college.edu" });

    mockTokenPolicy.set(REVOKED, "invalid_grant");

    await syncUserMailboxes({ userId: USER });

    expect(mockAttempts).toContain(HEALTHY);

    // The cursor moved, so the healthy mailbox genuinely completed a sync
    // rather than merely being reached.
    expect(rowFor(healthy.email).historyId).toBe("901");
    expect(rowFor(revoked.email).historyId).toBe("500");
  });
});

/* ------------------------------------------------------------------ *
 * THE CENTRAL TEST. The retry loop must actually stop.
 * ------------------------------------------------------------------ */

describe("the scheduler stops attempting a revoked mailbox", () => {
  test("a second cycle does not present the revoked token again", async () => {
    seed({ refreshToken: REVOKED, email: "a@college.edu" });
    seed({ refreshToken: HEALTHY, email: "b@college.edu" });

    mockTokenPolicy.set(REVOKED, "invalid_grant");

    // `setImmediate` stays real — it is how the cycle is drained; faking it
    // would make the drain never resolve. The interval itself is faked so no
    // test waits on real time.
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });

    startGmailScheduler();
    await drain();

    // Cycle 1: both mailboxes are attempted, which is correct — the failure has
    // not happened yet.
    expect(mockAttempts).toEqual([REVOKED, HEALTHY]);

    mockAttempts.length = 0;

    jest.advanceTimersByTime(GMAIL_SYNC_INTERVAL_MS);
    await drain();

    jest.clearAllTimers();

    // THE POINT OF THE WHOLE PR. Cycle 2 must not present a token Google has
    // already refused; today it does, and will every 120 seconds indefinitely.
    expect(mockAttempts).not.toContain(REVOKED);

    // And the healthy mailbox must keep syncing — the fix must narrow what the
    // scheduler attempts, not stop it.
    expect(mockAttempts).toContain(HEALTHY);
  });
});

/* ------------------------------------------------------------------ *
 * REAUTH_REQUIRED ──reconnect──▶ ACTIVE
 * ------------------------------------------------------------------ */

describe("reconnecting restores a mailbox", () => {
  test("a successful reconnect clears the reauthorization flag", async () => {
    const account = seed({
      refreshToken: REVOKED,
      email: "a@college.edu",
      reauthRequiredAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    await connectGmailAccount(account.email as string, "REFRESH_FRESH", USER);

    expect(rowFor(account.email).refreshToken).toBe("REFRESH_FRESH");

    // Without this the mailbox stays excluded from sync forever and the
    // reconnect silently accomplishes nothing — a worse failure than the one
    // being fixed, because the user has done everything asked of them.
    expect(rowFor(account.email).reauthRequiredAt ?? null).toBeNull();
  });

  test("a reconnect leaves the history cursor alone", async () => {
    const account = seed({
      refreshToken: REVOKED,
      email: "a@college.edu",
      historyId: "500",
      reauthRequiredAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    await connectGmailAccount(account.email as string, "REFRESH_FRESH", USER);

    // Deliberate existing behaviour: the cursor survives a reconnect so sync
    // resumes incrementally. Clearing the reauthorization state must not turn
    // into resetting the mailbox.
    expect(rowFor(account.email).historyId).toBe("500");
  });
});
