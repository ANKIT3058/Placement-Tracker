// G-7.2 — lifecycle for the attachment worker.
//
// The worker is stopped by a signal: a deploy, a restart, a host recycling its
// container, a batch runner hitting its timeout. Without a handler it dies
// mid-job while still holding the job's Redis lock, and BullMQ cannot tell an
// abandoned job from a slow one — it waits out `lockDuration`, the stalled
// checker returns the job to `wait`, and the job replays from the top.
//
// G-7.1 made that replay CORRECT. It did not make it free. For this pipeline a
// replay re-downloads the file from Gmail, orphans whatever was already stored
// under its old UUID key, repeats a paid provider call when `USE_AI=true`, and
// redoes the parse — which is the longest and therefore most-interrupted part of
// the job. And because `maxStalledCount` defaults to 1, a job interrupted twice
// is failed permanently while `removeOnFail: false` keeps its deterministic
// jobId occupied, so nothing can re-enqueue that attachment and no reconciler
// exists to notice.
//
// WHAT IS ASSERTED HERE, and what deliberately is not.
//
// "Stop accepting new jobs, then finish the active one" is BullMQ's own contract
// for `Worker.close()` — reimplementing it would mean testing BullMQ, not this
// module. What belongs to this module is: that a signal reaches `close()` at
// all, that the close is the graceful form rather than the forced one, that the
// process is not torn down until close has resolved, that two stop routes cannot
// start two concurrent shutdowns, and that batch mode exits only when the queue
// is genuinely empty.
//
// The distinction between `close()` and `close(true)` is the whole point: the
// forced variant abandons the running job, which is precisely the behaviour this
// change exists to prevent. A test that only checked "close was called" would
// pass against an implementation that made things worse.
//
// This file has no top-level `import` — the worker is pulled in through
// `require` inside `jest.isolateModules`, after the mocks are in place — so
// TypeScript would otherwise treat it as a global script and collide with the
// sibling suites in this directory. This marks it a module; it has no runtime
// effect.
export {};

type MockJob = {
  id: string;
  data: { attachmentId: number };
  queueName: string;
  attemptsMade: number;
};

// Typed with the optional force flag BullMQ's `Worker.close(force?)` accepts, so
// a test can tell `close()` apart from `close(true)`.
const mockClose = jest.fn(async (_force?: boolean) => undefined);
const mockQuit = jest.fn(async () => "OK");
const mockGetJobCounts = jest.fn();
const mockProcess = jest.fn(async (_attachmentId: number) => undefined);

// Captures the Worker's constructor arguments, so a test can read back the queue
// name it subscribed to and the processor it registered without either being
// re-exported for testing.
const mockWorkerConstructed = jest.fn();

// The worker's own event handlers. Batch mode hangs off `drained`, so the mock
// has to hand it back rather than swallow it — a `jest.fn()` that only counted
// registrations could not distinguish a handler that exits correctly from one
// that exits on every drain.
const mockHandlers: Record<string, (...args: never[]) => unknown> = {};

// The worker's module scope reads `.env` on import. Stubbed so a test run never
// loads real credentials into `process.env`, and so nothing here depends on a
// developer's local file existing.
jest.mock("dotenv/config", () => ({}));

jest.mock("bullmq", () => ({
  Worker: jest
    .fn()
    .mockImplementation((name: string, processor: unknown, opts: unknown) => {
      mockWorkerConstructed(name, processor, opts);

      return {
        close: mockClose,
        on: jest.fn((event: string, handler: (...args: never[]) => unknown) => {
          mockHandlers[event] = handler;
        }),
      };
    }),
}));

// The Queue the drain check interrogates. Mocked so no Redis client is
// constructed and no BullMQ Lua script is ever executed: production holds real
// jobs on this queue and the suite must never be able to see one, let alone
// move one.
jest.mock("../attachment.queue", () => ({
  attachmentQueue: { getJobCounts: mockGetJobCounts },
}));

// Mocked so importing the worker opens no socket. Production Redis is never
// contacted by this suite.
jest.mock("../../../infrastructure/redis/redis", () => ({
  redis: { quit: mockQuit },
}));

// Mocked at the module boundary, which also keeps the real pipeline's whole
// dependency graph — Prisma, the pg pool, pdf-parse, exceljs, the OpenAI client
// — out of this suite entirely. No database and no external service is reachable
// from here.
jest.mock("../document-processing.service", () => ({
  documentProcessingService: { process: mockProcess },
}));

// `gmail.errors` is deliberately NOT mocked. The redaction assertion below is
// only worth anything if it runs the real allowlist: a mocked `describeGmailError`
// would prove the worker called *something*, not that a refresh token stays out
// of the logs. The module is dependency-free, so loading it costs nothing.

// The shutdown path is async and is started by a signal handler, which cannot be
// awaited from the outside. Draining the macrotask queue a few times is enough
// for a chain whose every await resolves immediately, and keeps the test honest:
// it observes the handler's real completion rather than reaching into it.
const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const loadWorker = () => {
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../attachment.worker");
  });
};

// The batch-mode flag is read once at module scope, so it must be set BEFORE
// `loadWorker()` — and cleared between tests, or a stray "true" would silently
// turn a signal test into a batch test.
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

// Registered at import time, and every test imports the module again. Without
// removing them the previous test's handler would still be attached and a single
// emit would run several shutdowns.
const clearSignalHandlers = () => {
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
};

describe("the attachment worker shuts down gracefully on a signal", () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    resetWorkerEnvironment();
    clearSignalHandlers();

    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    clearSignalHandlers();
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

    // A gate rather than a timer: the point of this test is ordering, and a real
    // delay would make it a race between the implementation and the test's own
    // polling. Holding `close()` open until this test chooses to release it
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

  test("Redis is quit only after the worker has closed", async () => {
    const order: string[] = [];

    mockClose.mockImplementationOnce(async () => {
      order.push("close");
      return undefined;
    });
    mockQuit.mockImplementationOnce(async () => {
      order.push("quit");
      return "OK";
    });

    loadWorker();

    process.emit("SIGTERM");
    await flush();

    // The shared client is the one `attachmentQueue` was built on. Quitting it
    // before the close resolved would cut the connection out from under a job
    // that is still finishing.
    expect(order).toEqual(["close", "quit"]);
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
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  test("a close that rejects exits non-zero", async () => {
    mockClose.mockRejectedValueOnce(new Error("close exploded"));

    loadWorker();

    process.emit("SIGTERM");
    await flush();

    // A failed drain must not be reported as a successful one: the runtime reads
    // the exit code to decide whether the run needs attention.
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).not.toHaveBeenCalledWith(0);
  });

  test("a Redis quit failure still counts as a successful shutdown", async () => {
    mockQuit.mockRejectedValueOnce(new Error("connection already closed"));

    loadWorker();

    process.emit("SIGTERM");
    await flush();

    // The jobs are already safe at this point — `close()` resolved, so the
    // active one finished and its writes landed. A refused QUIT afterwards
    // changes nothing about that, and must not turn a clean drain into a
    // failure. Same containment, and same reasoning, as the email worker.
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// Opt-in drain-and-exit.
//
// A scheduled runtime hands a job a wall-clock budget, not a lifetime. The
// worker as it stands never ends: it blocks on Redis waiting for work that may
// not come, and is eventually killed having spent the budget idle — and killed
// OUTSIDE the graceful path above, which is the failure this whole file exists
// to close.
//
// WHAT MAKES THIS WORTH TESTING AT ALL.
//
// The dangerous version of this feature is the obvious one — exit on `drained`
// and be done. BullMQ emits `drained` when a fetch found nothing *immediately
// available*, which is not the same as an empty queue: a job that fails with
// attempts remaining is moved to the DELAYED set, and `drained` follows straight
// after. Attachment jobs carry `attempts: 3`, so that is an ordinary state here.
// An implementation that trusted the event would abandon pending retries and
// would still pass any test that only asserted "it exits when drained".
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
    clearSignalHandlers();

    mockGetJobCounts.mockResolvedValue({ ...NO_JOBS });

    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetWorkerEnvironment();
    clearSignalHandlers();
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

    // Reaching the drain check does not prove nothing is in flight — a stalled
    // job recovered moments earlier can be active — so the forced variant would
    // be as wrong here as on a signal.
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
    // No enableBatchMode(). This is the default a permanent worker runs under,
    // and the queue empties constantly in normal operation — a worker that
    // exited here would stop dead the first quiet minute.
    loadWorker();

    await emitDrained();

    // Not even asked: the flag is checked before Redis is touched.
    expect(mockGetJobCounts).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test.each(["TRUE", "True", "1", "yes", ""])(
    "the flag opts in on the exact string alone, not %p",
    async (value) => {
      // A plausible-looking value in a deploy config must not silently change
      // this process's lifecycle.
      process.env.WORKER_EXIT_WHEN_DRAINED = value;

      loadWorker();

      await emitDrained();

      expect(mockGetJobCounts).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    },
  );

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

// The lifecycle work touched the only file that also wires this worker to its
// queue and its pipeline. These are the regression guards for everything in that
// file that was NOT supposed to change.
describe("the lifecycle change left the worker's wiring intact", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetWorkerEnvironment();
    clearSignalHandlers();

    mockGetJobCounts.mockResolvedValue({ ...NO_JOBS });

    jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    clearSignalHandlers();
    jest.restoreAllMocks();
  });

  test("it consumes attachment-processing, not email-processing", async () => {
    loadWorker();

    expect(mockWorkerConstructed).toHaveBeenCalledTimes(1);

    const [queueName] = mockWorkerConstructed.mock.calls[0];

    expect(queueName).toBe("attachment-processing");
    expect(queueName).not.toBe("email-processing");
  });

  test("the drain check interrogates the attachment queue", async () => {
    process.env.WORKER_EXIT_WHEN_DRAINED = "true";
    loadWorker();

    await mockHandlers["drained"]?.();
    await flush();

    // `attachmentQueue` is the only queue this suite mocks, so a worker that
    // counted `emailQueue` instead would reach the real module, construct a
    // Queue against the real Redis client, and fail here rather than silently
    // draining the wrong backlog.
    expect(mockGetJobCounts).toHaveBeenCalledTimes(1);
  });

  test("the processor delegates to documentProcessingService.process and nothing else", async () => {
    loadWorker();

    const [, processor] = mockWorkerConstructed.mock.calls[0];

    const job: MockJob = {
      id: "attachment-42",
      data: { attachmentId: 42 },
      queueName: "attachment-processing",
      attemptsMade: 0,
    };

    await (processor as (job: MockJob) => Promise<unknown>)(job);

    // The id off the payload, and only the id — the owner is derived inside the
    // service from the persisted row (RFC-001 §9.5), and G-7.2 must not have
    // introduced a second path into the pipeline.
    expect(mockProcess).toHaveBeenCalledTimes(1);
    expect(mockProcess).toHaveBeenCalledWith(42);
  });

  test("the failed handler still redacts through describeGmailError", async () => {
    loadWorker();

    const errorSpy = console.error as jest.Mock;
    errorSpy.mockClear();

    // Shaped like the GaxiosError a token refresh throws: the credential travels
    // in the REQUEST config, which is exactly what must never be printed.
    const REFRESH_TOKEN = "1//0gSuperSecretRefreshTokenValue";
    const gaxiosLike = Object.assign(new Error("invalid_grant"), {
      status: 400,
      code: 400,
      config: {
        data: `refresh_token=${REFRESH_TOKEN}&client_secret=shhh`,
        headers: { Authorization: `Bearer ${REFRESH_TOKEN}` },
      },
      response: { status: 400, data: { error: "invalid_grant" } },
    });

    const job: MockJob = {
      id: "attachment-42",
      data: { attachmentId: 42 },
      queueName: "attachment-processing",
      attemptsMade: 2,
    };

    await (
      mockHandlers["failed"] as unknown as (
        job: MockJob,
        err: unknown,
      ) => unknown
    )(job, gaxiosLike);

    expect(errorSpy).toHaveBeenCalledTimes(1);

    // IDENTITY, not contents. Checking only for absent secrets would depend on
    // this test having guessed which property the next library version attaches;
    // asserting the error object itself never reached the logger does not.
    for (const call of errorSpy.mock.calls) {
      for (const argument of call) {
        expect(argument).not.toBe(gaxiosLike);
      }
    }

    // And the credential is absent from the serialized output under any key.
    const serialized = JSON.stringify(errorSpy.mock.calls);

    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain("client_secret");

    // What IS logged is the allowlisted summary — proving the redaction ran
    // rather than the whole payload having been dropped on the floor.
    const [, summary] = errorSpy.mock.calls[0];

    expect(summary).toEqual({
      message: "invalid_grant",
      status: 400,
      code: 400,
      googleError: "invalid_grant",
    });
  });
});
