// F-3e RED (part 3) — the production invocation layer for reconciliation.
//
// `reconcilePendingEmails` is implemented and tested, and nothing calls it. An
// orphaned email is recoverable in principle and unrecovered in practice, so
// F-3e is not closed until something invokes the sweep on a schedule.
//
// WHY A SEPARATE TIMER RATHER THAN GMAIL'S. `runSyncCycle` sets `isRunning`
// before its `try` and clears it only in the `finally` — and a `finally` runs
// when the `try` completes or throws, neither of which happens when an await
// never settles. That is F-2b: one stalled Gmail request leaves the flag set
// for the life of the process and every later cycle short-circuits. Putting
// reconciliation behind that flag would mean a stalled Gmail request also stops
// orphan recovery, and the failure that CREATES orphans — a Redis outage — is
// exactly the kind of degraded moment when the rest of the system is least
// healthy. Recovery must not depend on the component most likely to be broken.
//
// THE CONTRACT:
//
//     startEmailReconciliationScheduler()
//         ↓ immediately, then every EMAIL_RECONCILE_INTERVAL_MS
//     reconcilePendingEmails({ olderThan: now - EMAIL_RECONCILE_MIN_AGE_MS })
//         ↓
//     one cycle at a time, failures logged and survived
//
// SHUTDOWN is deliberately not specified. The repository has no SIGTERM handler,
// no graceful-shutdown path, and no stop function for any background loop —
// `startGmailScheduler` exports only a start. Inventing a lifecycle abstraction
// for this one timer would add a convention the codebase does not have; an
// interrupted sweep simply resumes on the next boot, which is safe because
// reconciliation is idempotent.
//
// MULTIPLE API INSTANCES are likewise not integration-tested. If the web
// service scales, each instance runs its own timer and they sweep the same rows
// — which is harmless, because every enqueue carries `jobId: email-${id}` and
// BullMQ collapses the duplicates into the job already queued. That behaviour
// was source-verified against the installed 5.81.3 (`addStandardJob` returns
// early when the job hash exists); no Redis is reachable from the test
// environment, so it is not re-asserted here.
//
// The scheduler module does not exist yet, so it is loaded per test: each
// failure then names the missing capability rather than collapsing the file
// before any test runs.

const INTERVAL_MS = 60_000;
const MIN_AGE_MS = 300_000;

// The intended public configuration contract. Declared here rather than added
// to production so the RED suite specifies the shape without implementing it —
// and so the interval is small enough for fake timers to step through cleanly.
jest.mock("../../../shared/constants/config", () => ({
  ...jest.requireActual("../../../shared/constants/config"),
  EMAIL_RECONCILE_INTERVAL_MS: 60_000,
  EMAIL_RECONCILE_MIN_AGE_MS: 300_000,
}));

const mockReconcile = jest.fn(
  async (_options: { olderThan: Date }) => ({ enqueued: 0 }),
);

jest.mock("../email.reconciler", () => ({
  reconcilePendingEmails: mockReconcile,
}));

// Gmail is sabotaged for the whole suite: if the email scheduler touches the
// Gmail scheduler or the Gmail API in any way, it fails loudly.
const mockStartGmailScheduler = jest.fn(() => {
  throw new Error("The email scheduler must not start the Gmail scheduler");
});

jest.mock("../../gmail/gmail.scheduler", () => ({
  startGmailScheduler: mockStartGmailScheduler,
}));

jest.mock("../../gmail/gmail.service", () => ({
  getRecentMessages: jest.fn(async () => {
    throw new Error("Reconciliation must not contact Gmail");
  }),
  getLatestHistoryId: jest.fn(async () => {
    throw new Error("Reconciliation must not contact Gmail");
  }),
  getHistoryChanges: jest.fn(async () => {
    throw new Error("Reconciliation must not contact Gmail");
  }),
  getMessageDetails: jest.fn(async () => {
    throw new Error("Reconciliation must not contact Gmail");
  }),
}));

type Scheduler = {
  startEmailReconciliationScheduler: () => void;
};

/* Loaded per test, and with a fresh module registry each time so the
   scheduler's module-level timer state does not leak between tests. */
const loadScheduler = (): Scheduler => {
  let scheduler: Scheduler | undefined;

  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    scheduler = require("../email.scheduler") as Scheduler;
  });

  return scheduler!;
};

const NOW = new Date("2026-08-23T12:00:00.000Z");

/* Lets the scheduler's promise chain settle without waiting on the clock.
   Bounded and deterministic — `setImmediate` is left unfaked for exactly this. */
const drain = async (turns = 5) => {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const cutoffs = () => mockReconcile.mock.calls.map(([options]) => options.olderThan);

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();

  mockReconcile.mockImplementation(async () => ({ enqueued: 0 }));

  // `setImmediate` stays real so `drain` resolves; everything else — including
  // the clock, which test 3 pins — is controlled.
  jest.useFakeTimers({ doNotFake: ["setImmediate"] });
  jest.setSystemTime(NOW);

  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();

  errorSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

/* ------------------------------------------------------------------ *
 * Startup.
 * ------------------------------------------------------------------ */

describe("starting the scheduler sweeps immediately", () => {
  test("the first cycle runs without waiting for an interval", async () => {
    const { startEmailReconciliationScheduler } = loadScheduler();

    startEmailReconciliationScheduler();
    await drain();

    // An orphan created before a restart should not have to wait a full
    // interval to be recovered — the same reason `startGmailScheduler` fires
    // one cycle before installing its interval.
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ *
 * The interval.
 * ------------------------------------------------------------------ */

describe("the sweep repeats on its interval", () => {
  test("each elapsed interval runs another cycle", async () => {
    const { startEmailReconciliationScheduler } = loadScheduler();

    startEmailReconciliationScheduler();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    // Three cycles: the immediate one plus two intervals. A scheduler that ran
    // once and stopped would leave every later orphan stranded.
    expect(mockReconcile).toHaveBeenCalledTimes(3);
  });
});

/* ------------------------------------------------------------------ *
 * The cutoff. The scheduler owns the clock; the reconciler owns nothing.
 * ------------------------------------------------------------------ */

describe("the cutoff comes from the configured minimum age", () => {
  test("olderThan trails the current time by exactly that age", async () => {
    const { startEmailReconciliationScheduler } = loadScheduler();

    startEmailReconciliationScheduler();
    await drain();

    const [cutoff] = cutoffs();

    // Asserted as a relationship against a controlled clock, never as a
    // literal date: the age is configuration, and pinning a number here would
    // freeze a deployment decision into the test suite.
    expect(NOW.getTime() - cutoff.getTime()).toBe(MIN_AGE_MS);
  });

  test("the cutoff advances with the clock", async () => {
    const { startEmailReconciliationScheduler } = loadScheduler();

    startEmailReconciliationScheduler();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    const [first, second] = cutoffs();

    // Recomputed from the current clock each cycle, not captured once at
    // startup. A fixed `olderThan` would stay put while `now` advanced, so the
    // gap between them would grow without bound — the cutoff would stop
    // representing the configured minimum age relative to the cycle being run,
    // and the window would widen instead of tracking it.
    expect(second.getTime() - first.getTime()).toBe(INTERVAL_MS);
  });
});

/* ------------------------------------------------------------------ *
 * A failed cycle must not end the schedule.
 * ------------------------------------------------------------------ */

describe("a failed cycle does not stop the scheduler", () => {
  test("the next interval sweeps again after a rejection", async () => {
    mockReconcile.mockRejectedValueOnce(new Error("database unavailable"));

    const { startEmailReconciliationScheduler } = loadScheduler();

    startEmailReconciliationScheduler();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    // The same guarantee `runSyncCycle`'s outer catch provides — "never let it
    // crash the interval". A sweep that failed because Postgres blinked must
    // not disable recovery until the next deploy.
    expect(mockReconcile).toHaveBeenCalledTimes(2);
  });

  test("the rejection is reported rather than swallowed silently", async () => {
    mockReconcile.mockRejectedValueOnce(new Error("database unavailable"));

    const { startEmailReconciliationScheduler } = loadScheduler();

    startEmailReconciliationScheduler();
    await drain();

    // Surviving a failure and hiding it are different things: an operator has
    // to be able to tell that recovery is not running.
    expect(errorSpy).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * One timer per process.
 * ------------------------------------------------------------------ */

describe("starting twice installs a single schedule", () => {
  test("a duplicate start does not double the sweeps", async () => {
    const { startEmailReconciliationScheduler } = loadScheduler();

    startEmailReconciliationScheduler();
    startEmailReconciliationScheduler();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    // One immediate cycle plus one interval cycle. Two timers would give four,
    // and would keep diverging every interval thereafter. This guards against
    // accidental double-initialisation inside one process — it is not, and
    // should not become, distributed locking.
    expect(mockReconcile).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ *
 * Independence from Gmail — the reason this scheduler exists separately.
 * ------------------------------------------------------------------ */

describe("the sweep is independent of Gmail", () => {
  test("it never starts or touches the Gmail scheduler", async () => {
    const { startEmailReconciliationScheduler } = loadScheduler();

    startEmailReconciliationScheduler();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    // Sharing Gmail's `isRunning` would mean a stalled Gmail request (F-2b)
    // also stops orphan recovery. Every Gmail helper in this suite throws if
    // called, and the Gmail scheduler throws if started, so any coupling fails
    // here rather than in production.
    expect(mockStartGmailScheduler).not.toHaveBeenCalled();
    expect(mockReconcile).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ *
 * Its own running state — sweeps must not overlap.
 * ------------------------------------------------------------------ */

describe("sweeps do not overlap", () => {
  test("an interval that fires mid-sweep does not start a second one", async () => {
    // A cycle that never settles: the reconciler is waiting on a slow query or
    // a large backlog of orphans.
    mockReconcile.mockImplementation(() => new Promise(() => {}));

    const { startEmailReconciliationScheduler } = loadScheduler();

    startEmailReconciliationScheduler();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    // Still one. Overlapping sweeps would scan the same rows concurrently and
    // pile identical enqueues on top of an in-flight pass — harmless thanks to
    // the deterministic job id, but pointless load that grows every interval.
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  test("the schedule resumes once a slow sweep finishes", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    mockReconcile.mockImplementationOnce(async () => {
      await held;
      return { enqueued: 0 };
    });

    const { startEmailReconciliationScheduler } = loadScheduler();

    startEmailReconciliationScheduler();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    expect(mockReconcile).toHaveBeenCalledTimes(1);

    release();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    // The guard must release when the sweep completes. A flag that stayed set
    // would reproduce F-2b in the very scheduler built to be immune to it.
    expect(mockReconcile).toHaveBeenCalledTimes(2);
  });
});
