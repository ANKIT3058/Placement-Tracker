// PR-9L RED — nothing sensitive reaches the worker's logs.
//
// This repository is PUBLIC, and the worker is intended to run as a batch job in
// GitHub Actions. Run logs on a public repository are readable by anyone with
// the URL and no login at all, and they persist. Whatever this process prints is
// published.
//
// Two statements were unsafe. The per-job log carried `emailSubject:
// email.subject` — a real placement email, subject line intact, once per job,
// with 101 of them queued. The failed handler passed the whole error object to
// `console.error`, and an error is a bag: gaxios hangs the request config and
// its Authorization header off one, and a driver error can carry the failing
// statement and its parameters.
//
// WHAT THESE TESTS ASSERT, and why they are phrased this way.
//
// Not "the field was renamed". A test that only checked for `emailId` would pass
// against a log that ALSO still printed the subject, and would keep passing if
// someone added `sender` next month. So the assertions are stated negatively and
// over the serialized output: the subject, body and sender values must not
// appear ANYWHERE in what was logged, whatever key they might be hiding under.
//
// For the failed path the decisive assertion is identity — that the error object
// itself was never handed to `console.error`. Checking only for absent secrets
// would depend on this test having guessed which property the next library
// chooses to attach.

// This file has no top-level `import` — the worker is pulled in through
// `require` inside `jest.isolateModules`, after the mocks are in place — so
// TypeScript would otherwise treat it as a global script and collide with the
// sibling shutdown suite, which declares `mockClose` and `loadWorker` of its
// own. This marks it a module; it has no runtime effect.
export {};

type MockJob = {
  id: string;
  data: { emailId: number; userId: number | null };
  queueName: string;
  attemptsMade: number;
};

const mockClose = jest.fn(async (_force?: boolean) => undefined);
const mockQuit = jest.fn(async () => "OK");
const mockGetJobCounts = jest.fn();

// Captures what the worker registers, so the processor and the failed handler
// can be invoked exactly as BullMQ would invoke them.
const mockWorkerConstructed = jest.fn();
const mockHandlers: Record<string, (...args: never[]) => unknown> = {};

const mockProcessEmailJob = jest.fn(async () => undefined);
const mockGetEmailById = jest.fn();

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
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

// No socket is opened by this suite. Production Redis holds 101 real jobs and
// must remain unreachable from a test run.
jest.mock("../../infrastructure/redis/redis", () => ({
  redis: { quit: mockQuit },
}));

jest.mock("../../infrastructure/queue/queues", () => ({
  emailQueue: { getJobCounts: mockGetJobCounts },
}));

jest.mock("../../modules/email/email.processor", () => ({
  processEmailJob: mockProcessEmailJob,
}));

jest.mock("../../modules/email/email.repository", () => ({
  getEmailById: mockGetEmailById,
}));

jest.mock("../../../generated/prisma/client", () => ({
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code = "";
    },
  },
}));

const loadWorker = () => {
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../email.worker");
  });
};

// The shutdown and drain paths are async and are started by handlers that cannot
// be awaited from outside. Draining the macrotask queue a few times is enough
// for a chain whose every await settles immediately.
const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

// Shaped like the errors this worker actually meets. gaxios attaches `config`
// (headers included) and `response` to its rejections; an ioredis or pg failure
// can carry a connection target. Shared by every path under test because the
// question is the same one in each: does the raw object reach the log?
const buildError = (message = "Gmail API request failed with status 403") => {
  const error = new Error(message) as Error & {
    config?: unknown;
    response?: unknown;
  };

  error.config = {
    headers: { Authorization: "Bearer ya29.SENSITIVE_ACCESS_TOKEN" },
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  };

  error.response = {
    data: { refresh_token: "1//SENSITIVE_REFRESH_TOKEN" },
  };

  return error;
};

// Distinctive enough that a substring search over the serialized log cannot
// match them by accident, and recognisably the kind of content that must never
// be published.
const SUBJECT = "Amazon SDE-1 Online Assessment on 12 Sept, LT-3";
const BODY = "Dear candidate, your OA link is https://example.test/oa/abc123";
const SENDER = "placement-cell@college.example.test";

const EMAIL_ID = 42;
const USER_ID = 7;

const email = {
  id: EMAIL_ID,
  userId: USER_ID,
  subject: SUBJECT,
  body: BODY,
  sender: SENDER,
};

const job: MockJob = {
  id: `email-${EMAIL_ID}`,
  data: { emailId: EMAIL_ID, userId: USER_ID },
  queueName: "email-processing",
  attemptsMade: 0,
};

type Processor = (job: MockJob) => Promise<void>;

const processorFor = (): Processor =>
  mockWorkerConstructed.mock.calls[0][1] as Processor;

// Everything console received, flattened into one searchable string. Objects are
// serialized so a value nested under any key is still found.
const loggedText = (spy: jest.SpyInstance) =>
  spy.mock.calls
    .map((args: unknown[]) =>
      args
        .map((arg: unknown) =>
          typeof arg === "string" ? arg : JSON.stringify(arg),
        )
        .join(" "),
    )
    .join("\n");

describe("the worker publishes no email content and no raw errors", () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  // The shutdown path really calls `process.exit`. Without this the first test
  // that reaches it would take the whole Jest run down with it.
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    for (const event of Object.keys(mockHandlers)) {
      delete mockHandlers[event];
    }

    delete process.env.WORKER_EXIT_WHEN_DRAINED;

    // PR-10A. The worker now refuses to start when its required configuration is
    // absent, and that check runs as the module's first statement — before the
    // `Worker` these tests reach through is ever constructed. `process.exit` is
    // spied to a no-op below, so a missing variable would NOT stop the import;
    // it would let a half-initialised module continue and fail somewhere less
    // obvious. Supplying the names keeps every test here about redaction.
    //
    // Values are inert placeholders, never reached: `redis` and the queue are
    // mocked, so nothing parses or dials either of these. They are also the
    // reason this suite's own assertion still means something — neither string
    // appears in any expected log line.
    process.env.DATABASE_URL = "postgresql://test/test";
    process.env.REDIS_URL = "redis://test";

    // Not set, so `resolveRequiredEnv` does not add OPENAI_API_KEY to the
    // requirement list. Cleared rather than assumed absent: `USE_AI` is
    // process-wide and another suite in the same worker may have set it.
    delete process.env.USE_AI;


    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");

    mockGetEmailById.mockResolvedValue(email);
    mockProcessEmailJob.mockResolvedValue(undefined);

    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    jest.restoreAllMocks();
  });

  describe("the per-job log", () => {
    test("does not carry the email subject, under any key", async () => {
      loadWorker();
      await processorFor()(job);

      // Asserted first so the negative below cannot pass against a processor
      // that logged nothing at all.
      expect(logSpy).toHaveBeenCalled();

      expect(loggedText(logSpy)).not.toContain(SUBJECT);
    });

    test("carries the email id instead", async () => {
      loadWorker();
      await processorFor()(job);

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({ emailId: EMAIL_ID }),
      );
    });

    test("carries no other content read from the email row", async () => {
      loadWorker();
      await processorFor()(job);

      // The body and the sender were never logged, but they sit on the same
      // object the subject came from — one destructuring change away from being
      // published. Pinning them now costs nothing.
      const text = loggedText(logSpy);

      expect(text).not.toContain(BODY);
      expect(text).not.toContain(SENDER);
    });

    test("keeps the operational fields that make a run diagnosable", async () => {
      loadWorker();
      await processorFor()(job);

      // Redaction that removed the ability to trace a job would be a different
      // kind of failure. These five are scalars: an id, a queue name, a row id,
      // an owner number and a retry count.
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: job.id,
          queue: "email-processing",
          emailId: EMAIL_ID,
          userId: USER_ID,
          attempts: 0,
        }),
      );
    });
  });

  describe("the failed-job log", () => {
    const emitFailed = (error: Error) => {
      (mockHandlers["failed"] as unknown as (j: MockJob, e: Error) => unknown)(
        job,
        error,
      );
    };

    test("never hands the error object to console", () => {
      loadWorker();

      const error = buildError();
      emitFailed(error);

      expect(errorSpy).toHaveBeenCalledTimes(1);

      // Identity, not content. An implementation that passed the error through
      // would publish whatever the next library decides to attach to it, and no
      // list of forbidden substrings can be kept ahead of that.
      expect(errorSpy.mock.calls[0]).not.toContain(error);
    });

    test("leaks nothing the error was carrying", () => {
      loadWorker();

      emitFailed(buildError());

      const text = loggedText(errorSpy);

      expect(text).not.toContain("SENSITIVE_ACCESS_TOKEN");
      expect(text).not.toContain("SENSITIVE_REFRESH_TOKEN");
      expect(text).not.toContain("Authorization");
    });

    test("still says what went wrong", () => {
      loadWorker();

      const error = buildError();
      emitFailed(error);

      // Redaction that logged nothing useful would make a failed batch run
      // undiagnosable, which is its own production problem.
      expect(loggedText(errorSpy)).toContain(error.message);
    });

    test("still says which job it was", () => {
      loadWorker();

      emitFailed(buildError());

      expect(errorSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          jobId: job.id,
          emailId: EMAIL_ID,
          attempts: 0,
        }),
      );
    });

    test("survives a job BullMQ could not load", () => {
      loadWorker();

      // BullMQ types the failed listener's job as possibly undefined — it can
      // fire without one. Throwing here would take down a worker that was
      // otherwise healthy.
      const handler = mockHandlers["failed"] as unknown as (
        j: MockJob | undefined,
        e: Error,
      ) => unknown;

      expect(() => handler(undefined, new Error("lock lost"))).not.toThrow();
      expect(loggedText(errorSpy)).toContain("lock lost");
    });
  });

  // The two infrastructure paths, and the higher-risk pair of the four.
  //
  // Both catch blocks handle REDIS failures — one when the shared client will
  // not close, one when the drain count is refused — and an ioredis rejection is
  // the error most likely to be carrying a connection target. On a public repo
  // that is the difference between a log line saying a socket closed and a log
  // line naming the host it closed on.
  describe("the infrastructure failure logs", () => {
    test("a failed shutdown reports the reason without the error", async () => {
      const error = buildError("Connection is closed");
      mockClose.mockImplementationOnce(async () => {
        throw error;
      });

      loadWorker();

      process.emit("SIGTERM");
      await flush();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]).not.toContain(error);

      const text = loggedText(errorSpy);

      expect(text).toContain("Worker shutdown failed");
      expect(text).toContain("Connection is closed");
      expect(text).not.toContain("SENSITIVE_ACCESS_TOKEN");
      expect(text).not.toContain("SENSITIVE_REFRESH_TOKEN");
      expect(text).not.toContain("Authorization");
    });

    test("a failed shutdown still exits non-zero", async () => {
      mockClose.mockImplementationOnce(async () => {
        throw buildError("Connection is closed");
      });

      loadWorker();

      process.emit("SIGTERM");
      await flush();

      // Redaction must not have moved the exit out of the catch. A shutdown that
      // failed and then reported success would be worse than a noisy log.
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test("a failed drain check reports the reason without the error", async () => {
      process.env.WORKER_EXIT_WHEN_DRAINED = "true";

      const error = buildError("Redis unreachable");
      mockGetJobCounts.mockRejectedValueOnce(error);

      loadWorker();

      await (mockHandlers["drained"] as unknown as () => Promise<void>)();
      await flush();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]).not.toContain(error);

      const text = loggedText(errorSpy);

      expect(text).toContain("Drain check failed");
      expect(text).toContain("Redis unreachable");
      expect(text).not.toContain("SENSITIVE_ACCESS_TOKEN");
      expect(text).not.toContain("SENSITIVE_REFRESH_TOKEN");
      expect(text).not.toContain("Authorization");
    });

    test("a failed drain check still leaves the worker running", async () => {
      process.env.WORKER_EXIT_WHEN_DRAINED = "true";
      mockGetJobCounts.mockRejectedValueOnce(buildError("Redis unreachable"));

      loadWorker();

      await (mockHandlers["drained"] as unknown as () => Promise<void>)();
      await flush();

      // The swallow is the point of that catch: an unhandled rejection here
      // would tear the process down outside the graceful path.
      expect(exitSpy).not.toHaveBeenCalled();
      expect(mockClose).not.toHaveBeenCalled();
    });

    test("a thrown non-Error is still reported, not dropped", async () => {
      // `catch (error)` is typed `unknown`, so the redaction has to cope with a
      // rejection that has no `.message` at all. Logging nothing would leave a
      // failed shutdown completely silent.
      mockClose.mockImplementationOnce(async () => {
        throw "redis went away";
      });

      loadWorker();

      process.emit("SIGTERM");
      await flush();

      expect(loggedText(errorSpy)).toContain("redis went away");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
