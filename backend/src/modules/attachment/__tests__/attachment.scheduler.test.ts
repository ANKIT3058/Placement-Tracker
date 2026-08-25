// G-7.3 — the invocation layer for attachment reconciliation.
//
// `reconcileOrphanedAttachments` recovers work that Postgres owes and BullMQ has
// lost, and on its own nothing calls it: a stranded attachment would be
// recoverable in principle and unrecovered in practice. This suite specifies the
// timer that makes the sweep actually happen.
//
// WHY A SEPARATE TIMER RATHER THAN THE EMAIL RECONCILER'S. The same separation,
// for the same reason, that keeps email reconciliation off the Gmail
// scheduler's flag: a sweep that stalls must not be able to stop an unrelated
// one, and the degraded moments that strand attachment work are exactly when
// the rest of the system is least healthy. Recovery must not depend on the
// component most likely to be broken.
//
// THE CONTRACT:
//
//     startAttachmentReconciliationScheduler()
//         ↓ immediately, then every ATTACHMENT_RECONCILE_INTERVAL_MS
//     reconcileOrphanedAttachments({
//       olderThan: now - ATTACHMENT_RECONCILE_MIN_AGE_MS,
//       batchSize: ATTACHMENT_RECONCILE_BATCH_SIZE,
//     })
//         ↓
//     one cycle at a time, failures logged and survived
//
// SHUTDOWN is deliberately not specified, matching the two schedulers already
// in the API process: none exports a stop, and inventing a lifecycle
// abstraction for this one timer would add a convention the codebase does not
// have. An interrupted sweep is harmless — the reconciler writes nothing, so
// every row it had not reached is exactly as it was.
//
// The scheduler owns the clock; the reconciler owns nothing. Both the cutoff and
// the batch size are computed here and passed down, which is why the reconciler
// suite can inject them and no test has to wait on real time.

const INTERVAL_MS = 60_000;
const MIN_AGE_MS = 900_000;
const BATCH_SIZE = 100;

// The public configuration contract, pinned here so the timing values are small
// enough for fake timers to step through cleanly and so the suite does not
// re-assert production defaults it does not own.
jest.mock("../../../shared/constants/config", () => ({
  ...jest.requireActual("../../../shared/constants/config"),
  ATTACHMENT_RECONCILE_INTERVAL_MS: 60_000,
  ATTACHMENT_RECONCILE_MIN_AGE_MS: 900_000,
  ATTACHMENT_RECONCILE_BATCH_SIZE: 100,
}));

const mockReconcile = jest.fn(
  async (_options: { olderThan: Date; batchSize: number }) => ({
    enqueued: 0,
  }),
);

jest.mock("../attachment.reconciler", () => ({
  reconcileOrphanedAttachments: mockReconcile,
}));

// The email reconciler is sabotaged for the whole suite: if this scheduler
// touches it in any way, the test fails loudly. Two schedulers sharing state is
// the failure this separation exists to prevent.
jest.mock("../../email/email.scheduler", () => ({
  startEmailReconciliationScheduler: jest.fn(() => {
    throw new Error(
      "The attachment scheduler must not start the email scheduler",
    );
  }),
}));

jest.mock("../../email/email.reconciler", () => ({
  reconcilePendingEmails: jest.fn(async () => {
    throw new Error("The attachment scheduler must not reconcile emails");
  }),
}));

type Scheduler = {
  startAttachmentReconciliationScheduler: () => void;
};

/* Loaded per test, and with a fresh module registry each time so the
   scheduler's module-level timer state does not leak between tests. */
const loadScheduler = (): Scheduler => {
  let scheduler: Scheduler | undefined;

  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    scheduler = require("../attachment.scheduler") as Scheduler;
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

const options = () => mockReconcile.mock.calls.map(([option]) => option);
const cutoffs = () => options().map((option) => option.olderThan);

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();

  mockReconcile.mockImplementation(async () => ({ enqueued: 0 }));

  // `setImmediate` stays real so `drain` resolves; everything else — including
  // the clock, which the cutoff tests pin — is controlled.
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
    const { startAttachmentReconciliationScheduler } = loadScheduler();

    startAttachmentReconciliationScheduler();
    await drain();

    // An attachment stranded before a restart should not have to wait a full
    // interval to be recovered.
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ *
 * The interval.
 * ------------------------------------------------------------------ */

describe("the sweep repeats on its interval", () => {
  test("each elapsed interval runs another cycle", async () => {
    const { startAttachmentReconciliationScheduler } = loadScheduler();

    startAttachmentReconciliationScheduler();
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
 * The parameters. The scheduler owns them; the reconciler reads no config.
 * ------------------------------------------------------------------ */

describe("the sweep is driven by configuration", () => {
  test("olderThan trails the current time by exactly the minimum age", async () => {
    const { startAttachmentReconciliationScheduler } = loadScheduler();

    startAttachmentReconciliationScheduler();
    await drain();

    const [cutoff] = cutoffs();

    // Asserted as a relationship against a controlled clock, never as a literal
    // date: the age is configuration, and pinning a number here would freeze a
    // deployment decision into the test suite.
    expect(NOW.getTime() - cutoff.getTime()).toBe(MIN_AGE_MS);
  });

  test("the cutoff advances with the clock", async () => {
    const { startAttachmentReconciliationScheduler } = loadScheduler();

    startAttachmentReconciliationScheduler();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    const [first, second] = cutoffs();

    // Recomputed from the current clock each cycle, not captured once at
    // startup. A fixed `olderThan` would stay put while `now` advanced, so the
    // window would widen without bound instead of tracking the configured age.
    expect(second.getTime() - first.getTime()).toBe(INTERVAL_MS);
  });

  test("the configured batch size is passed to every sweep", async () => {
    const { startAttachmentReconciliationScheduler } = loadScheduler();

    startAttachmentReconciliationScheduler();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    // The bound is what keeps a standing backlog from costing one Redis round
    // trip per row per interval. A sweep that dropped it would look identical
    // until the backlog was large.
    expect(options().map((option) => option.batchSize)).toEqual([
      BATCH_SIZE,
      BATCH_SIZE,
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * One cycle at a time.
 * ------------------------------------------------------------------ */

describe("sweeps do not overlap", () => {
  test("an interval that fires mid-sweep is skipped", async () => {
    let releaseSweep!: () => void;

    // A gate rather than a timer: holding the sweep open until this test
    // chooses to release it makes "still running" an observable state instead
    // of a timing window.
    const sweepGate = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });

    mockReconcile.mockImplementationOnce(async () => {
      await sweepGate;
      return { enqueued: 0 };
    });

    const { startAttachmentReconciliationScheduler } = loadScheduler();

    startAttachmentReconciliationScheduler();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    // The first sweep is still in flight. Starting a second would run two
    // queries and two enqueue loops over the same rows for no benefit.
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();

    releaseSweep();
    await drain();
  });

  test("the guard clears so later intervals still sweep", async () => {
    let releaseSweep!: () => void;

    const sweepGate = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });

    mockReconcile.mockImplementationOnce(async () => {
      await sweepGate;
      return { enqueued: 0 };
    });

    const { startAttachmentReconciliationScheduler } = loadScheduler();

    startAttachmentReconciliationScheduler();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    releaseSweep();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    // The flag is cleared in a `finally`, so a slow sweep delays recovery by one
    // interval rather than disabling it for the life of the process — the
    // failure mode F-2b records for the Gmail scheduler.
    expect(mockReconcile).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ *
 * A failed cycle must not end the schedule.
 * ------------------------------------------------------------------ */

describe("a failed cycle does not stop the scheduler", () => {
  test("the next interval sweeps again after a rejection", async () => {
    mockReconcile.mockRejectedValueOnce(new Error("database unavailable"));

    const { startAttachmentReconciliationScheduler } = loadScheduler();

    startAttachmentReconciliationScheduler();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    // A sweep that failed because Postgres blinked must not disable recovery
    // until the next deploy.
    expect(mockReconcile).toHaveBeenCalledTimes(2);
  });

  test("the rejection is reported rather than swallowed silently", async () => {
    mockReconcile.mockRejectedValueOnce(new Error("database unavailable"));

    const { startAttachmentReconciliationScheduler } = loadScheduler();

    startAttachmentReconciliationScheduler();
    await drain();

    // Surviving a failure and hiding it are different things: an operator has to
    // be able to tell that recovery is not running.
    expect(errorSpy).toHaveBeenCalled();
  });

  test("a failed sweep logs the message, never the error object", async () => {
    const gaxiosLike = Object.assign(new Error("database unavailable"), {
      config: { connectionString: "postgres://user:hunter2@host/db" },
    });

    mockReconcile.mockRejectedValueOnce(gaxiosLike);

    const { startAttachmentReconciliationScheduler } = loadScheduler();

    startAttachmentReconciliationScheduler();
    await drain();

    for (const argument of errorSpy.mock.calls[0]) {
      expect(argument).not.toBe(gaxiosLike);
    }

    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("hunter2");
  });
});

/* ------------------------------------------------------------------ *
 * One timer per process.
 * ------------------------------------------------------------------ */

describe("starting twice installs a single schedule", () => {
  test("a duplicate start does not double the sweeps", async () => {
    const { startAttachmentReconciliationScheduler } = loadScheduler();

    startAttachmentReconciliationScheduler();
    startAttachmentReconciliationScheduler();
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
 * Independence from email reconciliation.
 * ------------------------------------------------------------------ */

describe("the sweep is independent of email reconciliation", () => {
  test("it never starts or touches the email scheduler", async () => {
    const { startAttachmentReconciliationScheduler } = loadScheduler();

    startAttachmentReconciliationScheduler();
    await drain();

    jest.advanceTimersByTime(INTERVAL_MS);
    await drain();

    // Both email modules throw if reached. Sharing a flag or a timer would mean
    // one stalled sweep stops the other, which is the coupling this second
    // scheduler exists to avoid.
    expect(mockReconcile).toHaveBeenCalledTimes(2);
  });
});
