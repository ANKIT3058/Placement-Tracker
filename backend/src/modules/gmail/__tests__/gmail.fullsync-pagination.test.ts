// PR-8H RED — a full sync must read every page, not just the first.
//
// `getRecentMessages` calls `users.messages.list({ userId: "me", maxResults: 100 })`
// and returns `response.data.messages`. It never sends a `pageToken` and never
// reads `nextPageToken`. Google documents `maxResults` as a PER-PAGE limit
// ("defaults to 100 … maximum allowed value … is 500") and `nextPageToken` as
// meaning more results exist — so everything past page one is silently dropped.
//
// Dropped, and then made unreachable. `runFullSync` captures the watermark from
// `users.getProfile` BEFORE listing, and `syncGmailAccount` writes that
// watermark once the sync returns. Messages the listing skipped are older than
// the stored historyId, so no later `history.list` will ever surface them. The
// gap is silent, permanent, and unbounded in size.
//
// The realistic trigger is not a huge mailbox — it is the expired-history
// fallback. A stored historyId older than Gmail's window (documented as
// "typically at least one week") answers 404, the code correctly falls back to
// a full sync, and that fallback then reads one page and jumps the watermark to
// now. Everything in between is lost. There is no `q` filter on the listing, so
// "one page" means the most recent 100 messages of ANY kind — days of mail in a
// student's inbox, not months.
//
// THE CONTRACT: follow `nextPageToken` until it is absent, and process the
// whole result. Nothing else changes.
//
// The shape already exists in this very file: `getHistoryChanges` walks
// `do { … } while (pageToken)`. Only the full-sync path lacks it.
//
// WHAT IS OBSERVED. Every request `users.messages.list` receives, in order,
// including the `pageToken` on each — so an implementation that looped without
// advancing the token, or that re-read page one, fails just as loudly as one
// that never paginates. Assertions on the returned set are order-agnostic:
// Google does not document an ordering for this endpoint, and pinning one would
// invent a contract the API does not offer.

type ListCall = { pageToken: unknown; maxResults: unknown };
type Page = { ids: string[]; nextPageToken?: string };

// Pages the fake mailbox will serve, in order.
let mockPages: Page[] = [];

// Every `users.messages.list` request, in order.
const mockListCalls: ListCall[] = [];

// Everything the fake Gmail was asked for, so ordering between the watermark
// read and the listing can be asserted.
const mockCallLog: string[] = [];

// When set, the Nth list request (1-based) rejects instead of answering.
let mockFailListCall: number | null = null;

jest.mock("googleapis", () => {
  const actual = jest.requireActual("googleapis");

  return {
    google: {
      // Real, so `createOAuthClient()` still builds a genuine client.
      auth: actual.google.auth,

      gmail: () => ({
        users: {
          getProfile: async () => {
            mockCallLog.push("getProfile");
            return { data: { emailAddress: "mailbox@college.edu", historyId: "WATERMARK" } };
          },
          messages: {
            list: async (params: { pageToken?: string; maxResults?: number }) => {
              mockCallLog.push("messages.list");
              mockListCalls.push({
                pageToken: params.pageToken,
                maxResults: params.maxResults,
              });

              if (mockFailListCall === mockListCalls.length) {
                throw new Error("Gmail list failed");
              }

              const page = mockPages[mockListCalls.length - 1];

              if (!page) {
                throw new Error(
                  `Unexpected list request ${mockListCalls.length}: the fake mailbox has ${mockPages.length} page(s)`,
                );
              }

              return {
                data: {
                  messages: page.ids.map((id) => ({ id })),
                  nextPageToken: page.nextPageToken,
                },
              };
            },
            get: async (params: { id: string }) => {
              mockCallLog.push(`messages.get:${params.id}`);
              return {
                data: {
                  id: params.id,
                  snippet: "snippet",
                  payload: { headers: [], body: {} },
                },
              };
            },
          },
          history: {
            list: async () => {
              mockCallLog.push("history.list");
              return { data: { historyId: "WATERMARK", history: [] } };
            },
          },
        },
      }),
    },
  };
});

type Row = Record<string, unknown>;

const mockRows: Row[] = [];

jest.mock("../../../lib/prisma", () => ({
  prisma: {
    gmailAccount: {
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => [...mockRows]),
      create: jest.fn(async ({ data }: { data: Row }) => data),
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

// Every message is new, so each one reaches `createEmail` and is counted as
// processed rather than deduplicated.
jest.mock("../../email/email.repository", () => ({
  createEmail: jest.fn(async () => ({ id: 1, userId: 1 })),
  getEmailByGmailMessageId: jest.fn(async () => null),
}));

jest.mock("../../email/email.producer", () => ({
  enqueueEmailProcessing: jest.fn(async () => undefined),
}));

import { getRecentMessages } from "../gmail.service";
import { syncGmailAccount } from "../gmail.sync.service";

const REFRESH = "REFRESH_TOKEN";

const idsFrom = (messages: { id?: string | null }[]): string[] =>
  messages.map((message) => message.id!).sort();

const pageTokens = () => mockListCalls.map((call) => call.pageToken);

const fetchedIds = () =>
  mockCallLog
    .filter((entry) => entry.startsWith("messages.get:"))
    .map((entry) => entry.slice("messages.get:".length))
    .sort();

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();

  mockPages = [];
  mockListCalls.length = 0;
  mockCallLog.length = 0;
  mockFailListCall = null;
  mockRows.length = 0;

  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

/* ------------------------------------------------------------------ *
 * The existing single-page behaviour must not change.
 * ------------------------------------------------------------------ */

describe("a mailbox that fits in one page is read in one request", () => {
  test("no second request is made when there is no next page", async () => {
    mockPages = [{ ids: ["m1", "m2"] }];

    const messages = await getRecentMessages(REFRESH);

    expect(mockListCalls).toHaveLength(1);
    expect(pageTokens()).toEqual([undefined]);
    expect(idsFrom(messages)).toEqual(["m1", "m2"]);
  });
});

/* ------------------------------------------------------------------ *
 * THE CENTRAL TEST. Page two must be requested.
 * ------------------------------------------------------------------ */

describe("a mailbox spanning several pages is read completely", () => {
  test("a second page is requested with its token", async () => {
    mockPages = [
      { ids: ["m1", "m2"], nextPageToken: "PAGE_2" },
      { ids: ["m3", "m4"] },
    ];

    const messages = await getRecentMessages(REFRESH);

    // Google returns a token precisely because more messages exist. Ignoring it
    // discards them, and the watermark then moves past them for good.
    expect(mockListCalls).toHaveLength(2);
    expect(pageTokens()).toEqual([undefined, "PAGE_2"]);

    // Order is not asserted: Google documents none for this endpoint, so
    // requiring one would invent a contract the API does not offer.
    expect(idsFrom(messages)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  test("three pages are consumed and the walk then stops", async () => {
    mockPages = [
      { ids: ["m1"], nextPageToken: "PAGE_2" },
      { ids: ["m2"], nextPageToken: "PAGE_3" },
      { ids: ["m3"] },
    ];

    const messages = await getRecentMessages(REFRESH);

    // Each token must be the one the PREVIOUS response supplied. An
    // implementation that handled only one extra page, or that re-sent the
    // first request, fails here rather than silently truncating.
    expect(pageTokens()).toEqual([undefined, "PAGE_2", "PAGE_3"]);
    expect(mockListCalls).toHaveLength(3);
    expect(idsFrom(messages)).toEqual(["m1", "m2", "m3"]);
  });

  test("an empty page still follows its token", async () => {
    // Gmail may answer a page with no messages while still reporting more to
    // come — filtered or deleted items thin a page out. Stopping on an empty
    // page would drop everything behind it.
    mockPages = [
      { ids: [], nextPageToken: "PAGE_2" },
      { ids: ["m1", "m2"] },
    ];

    const messages = await getRecentMessages(REFRESH);

    expect(mockListCalls).toHaveLength(2);
    expect(idsFrom(messages)).toEqual(["m1", "m2"]);
  });
});

/* ------------------------------------------------------------------ *
 * The whole point: every page's messages must actually be ingested.
 * ------------------------------------------------------------------ */

describe("a full sync ingests every page", () => {
  const account = () => {
    const row: Row = {
      id: 1,
      userId: 1,
      email: "mailbox@college.edu",
      refreshToken: REFRESH,
      // Null takes the full-sync path — the same path the expired-history
      // fallback lands on.
      historyId: null,
      reauthRequiredAt: null,
    };

    mockRows.push(row);

    return row;
  };

  test("messages beyond the first page are fetched and processed", async () => {
    const row = account();

    mockPages = [
      { ids: ["m1", "m2"], nextPageToken: "PAGE_2" },
      { ids: ["m3", "m4"] },
    ];

    const result = await syncGmailAccount(row as never);

    // THE DATA GAP, stated directly. Today m3 and m4 are never fetched, and the
    // watermark below then puts them permanently out of reach of history sync.
    expect(fetchedIds()).toEqual(["m1", "m2", "m3", "m4"]);
    expect(result.stats.processed).toBe(4);
    expect(result.totalFetched).toBe(4);
  });

  test("the watermark is still taken before listing and written once", async () => {
    const row = account();

    mockPages = [
      { ids: ["m1"], nextPageToken: "PAGE_2" },
      { ids: ["m2"] },
    ];

    await syncGmailAccount(row as never);

    // Ordering is the safety property that makes an overlapping re-read
    // harmless and a gap impossible: the watermark predates the listing, so a
    // message arriving mid-sync is either listed or lands after the watermark.
    // Pagination must not disturb it.
    expect(mockCallLog[0]).toBe("getProfile");
    expect(mockCallLog[1]).toBe("messages.list");
    expect(mockCallLog.filter((entry) => entry === "getProfile")).toHaveLength(1);

    // Written once, after every page — never per page.
    expect(row.historyId).toBe("WATERMARK");
  });
});

/* ------------------------------------------------------------------ *
 * A failing page must not look like a completed sync.
 * ------------------------------------------------------------------ */

describe("a failure part-way through does not advance the watermark", () => {
  test("a rejected second page abandons the whole sync", async () => {
    // `historyId: null` puts the account on the full-sync path — the same path
    // the expired-history fallback lands on — so the failing page is reached
    // through the real production flow rather than by calling the fetcher
    // directly. `updateHistoryId` lives in `syncGmailAccount`, so only this
    // route can show whether the cursor moves.
    const row: Row = {
      id: 1,
      userId: 1,
      email: "mailbox@college.edu",
      refreshToken: REFRESH,
      historyId: null,
      reauthRequiredAt: null,
    };

    mockRows.push(row);

    mockPages = [{ ids: ["m1"], nextPageToken: "PAGE_2" }];
    mockFailListCall = 2;

    const outcome = await syncGmailAccount(row as never).then(
      () => "completed",
      (error: Error) => error.message,
    );

    // An incomplete listing is not a completed sync. Today page two is never
    // requested, so the failure never happens and the sync reports success on
    // a partial mailbox — which is precisely the bug.
    expect(outcome).toBe("Gmail list failed");

    // THE INVARIANT. A sync that did not finish must leave the cursor where it
    // was, so the next run retries the same window. Advancing it here would
    // convert a retryable failure into a permanent gap — and it is exactly
    // what a GREEN implementation that swallowed page errors inside the new
    // loop would do.
    expect(row.historyId).toBeNull();

    // And the failing page must genuinely have been attempted.
    expect(pageTokens()).toEqual([undefined, "PAGE_2"]);
  });
});
