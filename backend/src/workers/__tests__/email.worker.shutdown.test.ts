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

// The worker's module scope reads `.env` on import. Stubbed so a test run never
// loads real credentials into `process.env`, and so nothing here depends on a
// developer's local file existing.
jest.mock("dotenv/config", () => ({}));

jest.mock("bullmq", () => ({
  Worker: jest.fn().mockImplementation(() => ({
    close: mockClose,
    on: jest.fn(),
  })),
  UnrecoverableError: class UnrecoverableError extends Error {},
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

describe("the email worker shuts down gracefully on a signal", () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

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
