// PR-9B RED — graceful shutdown for the email worker.
//
// The worker runs as a long-lived process on a host that stops it by sending a
// signal. Without a handler the process dies mid-job while still holding the
// job's Redis lock: BullMQ cannot know the job was abandoned, so it waits out
// `lockDuration` (30s), lets the stalled checker move the job back to `wait`,
// and re-runs it from the top. That replay re-executes `createExtraction`,
// which has no unique constraint — so every ungraceful stop costs a duplicate
// EmailExtraction row. Worse, `maxStalledCount` defaults to 1, so a job
// unlucky enough to be interrupted twice is failed permanently and silently.
//
// Deploying is itself the event that triggers this, which is why it is worth
// closing before the worker ever runs in production.
//
// WHAT IS ASSERTED HERE, and what deliberately is not.
//
// "Stop accepting new jobs, then finish the active one" is BullMQ's own
// contract for `Worker.close()` — reimplementing it would mean testing BullMQ,
// not this module. What belongs to this module is: that a signal reaches
// `close()` at all, that the close is the graceful form rather than the forced
// one, that the process is not torn down until close has resolved, and that
// two signals cannot start two concurrent shutdowns. Those four are what these
// tests pin.
//
// The distinction between `close()` and `close(true)` is the whole point: the
// forced variant abandons the running job, which is precisely the behaviour
// this change exists to prevent. A test that only checked "close was called"
// would pass against an implementation that made things worse.

// Typed with the optional force flag BullMQ's `Worker.close(force?)` accepts, so
// a test can tell `close()` apart from `close(true)`.
const mockClose = jest.fn(async (_force?: boolean) => undefined);
const mockQuit = jest.fn(async () => "OK");

// PR-9K. The worker's own `drained` handler is what batch mode hangs off, so the
// mock has to hand it back rather than swallow it — a `jest.fn()` that only
// counted registrations could not distinguish a handler that exits correctly
// from one that exits on every drain.
const mockHandlers: Record<string, (...args: unknown[]) => unknown> = {};

const mockGetJobCounts = jest.fn();

// The worker's module scope reads `.env` on import. Stubbed so a test run never
// loads real credentials into `process.env`, and so nothing here depends on a
// developer's local file existing.
jest.mock("dotenv/config", () => ({}));

jest.mock("bullmq", () => ({
  Worker: jest.fn().mockImplementation(() => ({
    close: mockClose,
    on: jest.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      mockHandlers[event] = handler;
    }),
  })),
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

// The Queue the drain check interrogates. Mocked so no Redis client is
// constructed: production holds 101 real jobs on this queue and the suite must
// never be able to see them, let alone move one.
jest.mock("../../infrastructure/queue/queues", () => ({
  emailQueue: { getJobCounts: mockGetJobCounts },
}));

// Mocked so importing the worker opens no socket. Production Redis is never
// contacted by this suite.
jest.mock("../../infrastructure/redis/redis", () => ({
  redis: { quit: mockQuit },
}));

jest.mock("../../modules/email/email.processor", () => ({
  processEmailJob: jest.fn(),
}));

jest.mock("../../modules/email/email.repository", () => ({
  getEmailById: jest.fn(),
}));

jest.mock("../../../generated/prisma/client", () => ({
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code = "";
    },
  },
}));

// The shutdown path is async and is started by a signal handler, which cannot
// be awaited from the outside. Draining the macrotask queue a few times is
// enough for a chain whose every await resolves immediately, and keeps the
// test honest: it observes the handler's real completion rather than reaching
// into it.
const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const loadWorker = () => {
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../email.worker");
  });
};

// Shared by both describes. The batch-mode flag is read once at module scope, so
// it must be set BEFORE `loadWorker()` — and cleared between tests, or a stray
// "true" would silently turn a signal test into a batch test.
const resetWorkerEnvironment = () => {
  delete process.env.WORKER_EXIT_WHEN_DRAINED;

  for (const event of Object.keys(mockHandlers)) {
    delete mockHandlers[event];
  }
};

const NO_JOBS = {
  waiting: 0,
  active: 0,
  delayed: 0,
  paused: 0,
  prioritized: 0,
  "waiting-children": 0,
};

describe("the email worker shuts down gracefully on a signal", () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    resetWorkerEnvironment();

    // Handlers are registered at import time, and every test imports the module
    // again. Without this the previous test's handler would still be attached
    // and a single emit would run several shutdowns.
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");

    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    jest.restoreAllMocks();
  });

  test("SIGTERM closes the worker", async () => {
    loadWorker();

    process.emit("SIGTERM");
    await flush();

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  test("SIGINT closes the worker", async () => {
    loadWorker();

    process.emit("SIGINT");
    await flush();

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  test("the close is graceful, never forced", async () => {
    loadWorker();

    process.emit("SIGTERM");
    await flush();

    // Asserted before reading the argument so this cannot pass vacuously
    // against an implementation that never calls close at all.
    expect(mockClose).toHaveBeenCalledTimes(1);

    // `close(true)` abandons the running job instead of waiting for it. An
    // implementation that forced the close would satisfy "close was called"
    // while causing exactly the replay this change exists to prevent.
    const [force] = mockClose.mock.calls[0] ?? [];

    expect(force).toBeFalsy();
  });

  test("the process is not exited until close has resolved", async () => {
    let closeResolved = false;
    let releaseClose!: () => void;

    // A gate rather than a timer: the point of this test is ordering, and a
    // real delay would make it a race between the implementation and the test's
    // own polling. Holding `close()` open until this test chooses to release it
    // makes "still draining" an observable state instead of a timing window.
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    mockClose.mockImplementationOnce(async () => {
      await closeGate;
      closeResolved = true;
      return undefined;
    });

    loadWorker();

    process.emit("SIGTERM");
    await flush();

    // The active job is still finishing. Exiting here is precisely the failure
    // being fixed, so this is the assertion that carries the test.
    expect(closeResolved).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();

    releaseClose();
    await flush();

    expect(closeResolved).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test("two signals arriving together start only one shutdown", async () => {
    loadWorker();

    // A host that sends SIGTERM and is then interrupted, or a terminal sending
    // SIGINT while a SIGTERM shutdown is already draining. Two concurrent
    // `close()` calls would race the same BullMQ internals.
    process.emit("SIGTERM");
    process.emit("SIGINT");
    await flush();

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockQuit).toHaveBeenCalledTimes(1);
  });
});

// PR-9K RED — opt-in drain-and-exit.
//
// A scheduled runtime hands a job a wall-clock budget, not a lifetime. The
// worker as it stands never ends: it blocks on Redis waiting for work that may
// not come, and is eventually killed having spent the budget idle. Batch mode
// lets it finish instead.
//
// WHAT MAKES THIS WORTH TESTING AT ALL.
//
// The dangerous version of this feature is the obvious one — exit on `drained`
// and be done. BullMQ emits `drained` when a fetch found nothing *immediately
// available*, which is not the same as an empty queue: a job that fails with
// attempts remaining is moved to the DELAYED set, and `drained` follows straight
// after. An implementation that trusted the event would abandon pending retries
// and would still pass any test that only asserted "it exits when drained".
//
// So the assertions that carry this suite are the negative ones. Each of the six
// job states is proved individually to hold the worker open, because a check
// that omitted one — or that called `getJobCounts()` with no arguments and so
// counted the permanent `failed` set — would look identical from the outside
// until the state it forgot actually occurred in production.
describe("batch mode exits only when the queue is genuinely drained", () => {
  let exitSpy: jest.SpyInstance;

  const enableBatchMode = () => {
    process.env.WORKER_EXIT_WHEN_DRAINED = "true";
  };

  // Fires the handler the worker registered, exactly as BullMQ would.
  const emitDrained = async () => {
    await mockHandlers["drained"]?.();
    await flush();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resetWorkerEnvironment();

    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");

    mockGetJobCounts.mockResolvedValue({ ...NO_JOBS });

    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetWorkerEnvironment();
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    jest.restoreAllMocks();
  });

  test("an empty queue shuts the worker down through the existing graceful path", async () => {
    enableBatchMode();
    loadWorker();

    await emitDrained();

    // The same three steps SIGTERM takes, in the same order, because it is
    // literally the same function — a second shutdown implementation is what
    // this asserts against.
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockQuit).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test("the batch close is graceful, never forced", async () => {
    enableBatchMode();
    loadWorker();

    await emitDrained();

    expect(mockClose).toHaveBeenCalledTimes(1);

    // `close(true)` abandons whatever is running. Reaching the drain check does
    // not prove nothing is in flight — a stalled job recovered moments earlier
    // can be active — so the forced variant would be as wrong here as on a
    // signal.
    const [force] = mockClose.mock.calls[0] ?? [];

    expect(force).toBeFalsy();
  });

  // One state per case rather than a single mixed fixture: a check that dropped
  // exactly one of the six would still pass every mixed case that happened to
  // include another non-zero state.
  test.each([
    ["waiting", "a job still queued"],
    ["active", "a job recovered from a killed run"],
    ["delayed", "a retry waiting out its backoff"],
    ["paused", "the queue paused"],
    ["prioritized", "a prioritised job"],
    ["waiting-children", "a job waiting on children"],
  ])("%s > 0 keeps the worker alive (%s)", async (state) => {
    enableBatchMode();
    mockGetJobCounts.mockResolvedValue({ ...NO_JOBS, [state]: 1 });

    loadWorker();

    await emitDrained();

    // Asserted first so the three negatives below cannot pass vacuously against
    // a handler that was never wired up or never reached the check.
    expect(mockGetJobCounts).toHaveBeenCalledTimes(1);

    expect(mockClose).not.toHaveBeenCalled();
    expect(mockQuit).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("a later true drain still exits after an earlier one was declined", async () => {
    enableBatchMode();
    mockGetJobCounts.mockResolvedValueOnce({ ...NO_JOBS, delayed: 1 });

    loadWorker();

    // The retry runs, and BullMQ emits `drained` again — fetching any job clears
    // its internal flag, so the event re-arms on its own. Nothing would ever
    // exit if the first declined check also disarmed the handler.
    await emitDrained();
    expect(exitSpy).not.toHaveBeenCalled();

    await emitDrained();

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test("exactly the six pending states are counted, and no terminal state is", async () => {
    enableBatchMode();
    loadWorker();

    await emitDrained();

    expect(mockGetJobCounts).toHaveBeenCalledTimes(1);

    // Asserted as the whole argument list, which is what rules out the two
    // states that must never appear. `completed` and `failed` are terminal, and
    // with removeOnFail: false the failed set is permanent — counting either
    // would mean this process can never exit.
    expect(mockGetJobCounts.mock.calls[0]).toEqual([
      "waiting",
      "active",
      "delayed",
      "paused",
      "prioritized",
      "waiting-children",
    ]);
  });

  test("a failed count query leaves the worker running rather than killing it", async () => {
    enableBatchMode();
    mockGetJobCounts.mockRejectedValue(new Error("Redis unreachable"));

    loadWorker();

    await emitDrained();

    // An unhandled rejection here would tear the process down outside the
    // graceful path, abandoning any job it still holds — strictly worse than
    // staying up and letting the runtime's own timeout end the run.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  test("with the flag unset the drain event does nothing at all", async () => {
    // No enableBatchMode(). This is the default every existing deployment runs
    // under, and the queue empties constantly in normal operation — a worker
    // that exited here would stop dead the first quiet minute.
    loadWorker();

    await emitDrained();

    // Not even asked: the flag is checked before Redis is touched.
    expect(mockGetJobCounts).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("the flag opts in on the exact string alone", async () => {
    // "1", "TRUE", "yes" and an empty value all have to read as off, or a
    // plausible-looking value in a deploy config silently changes the process's
    // lifecycle.
    process.env.WORKER_EXIT_WHEN_DRAINED = "TRUE";

    loadWorker();

    await emitDrained();

    expect(mockGetJobCounts).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("a signal during batch mode still shuts down exactly once", async () => {
    enableBatchMode();
    loadWorker();

    // Both routes converge on the same in-flight promise, so a runtime that
    // sends SIGTERM while the drain exit is already running cannot start a
    // second close against the same BullMQ internals.
    await emitDrained();
    process.emit("SIGTERM");
    await flush();

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockQuit).toHaveBeenCalledTimes(1);
  });
});
