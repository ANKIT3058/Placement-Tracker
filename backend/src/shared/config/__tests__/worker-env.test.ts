// PR-10A — startup configuration validation for the worker processes.
//
// WHAT IS ASSERTED HERE, and what deliberately is not.
//
// This module's job is a decision — "may this process start?" — and a refusal
// that an operator can act on. So the tests pin the decision (which names count
// as missing, and when OPENAI_API_KEY joins the list), the exit code, and the
// fact that the refusal names variables without printing their values. They do
// not test that `console.error` writes to stderr or that `process.exit` ends a
// process; those are Node's contracts, not this module's.
//
// The environment is INJECTED rather than mutated on `process.env` for the pure
// functions. `maxWorkers: 1` means every suite in the run shares one
// `process.env`, and a test that set DATABASE_URL globally would silently
// satisfy some other suite's precondition. Only `assertWorkerEnv`'s own
// defaulting is exercised against the real `process.env`, and that one test
// restores what it touched.

import {
  ATTACHMENT_WORKER_REQUIRED_ENV,
  EMAIL_WORKER_REQUIRED_ENV,
  assertWorkerEnv,
  findMissingEnv,
  resolveRequiredEnv,
} from "../worker-env";

describe("the requirement lists", () => {
  // The email worker never calls Gmail; the attachment worker downloads every
  // file from it. The lists differ for that reason, and a future edit that
  // merged them would quietly start demanding Google credentials from a process
  // that has no use for them.
  test("the email worker requires the datastores and nothing else", () => {
    expect([...EMAIL_WORKER_REQUIRED_ENV]).toEqual([
      "DATABASE_URL",
      "REDIS_URL",
    ]);
  });

  test("the attachment worker additionally requires the Gmail OAuth client", () => {
    expect([...ATTACHMENT_WORKER_REQUIRED_ENV]).toEqual([
      "DATABASE_URL",
      "REDIS_URL",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ]);
  });

  // The lists are what the systemd units and the deployment guide are written
  // against, so the email worker's must stay a strict subset — one
  // `EnvironmentFile` shape can then serve both units.
  test("the email worker's requirements are a subset of the attachment worker's", () => {
    for (const name of EMAIL_WORKER_REQUIRED_ENV) {
      expect([...ATTACHMENT_WORKER_REQUIRED_ENV]).toContain(name);
    }
  });
});

describe("findMissingEnv", () => {
  test("reports nothing when every name is present", () => {
    expect(
      findMissingEnv(["DATABASE_URL", "REDIS_URL"], {
        DATABASE_URL: "postgresql://host/db",
        REDIS_URL: "redis://host",
      }),
    ).toEqual([]);
  });

  test("reports an absent name", () => {
    expect(
      findMissingEnv(["DATABASE_URL", "REDIS_URL"], {
        DATABASE_URL: "postgresql://host/db",
      }),
    ).toEqual(["REDIS_URL"]);
  });

  // An empty assignment in a unit file and a trailing space in an
  // `EnvironmentFile` both produce this, and both fail exactly the way an unset
  // variable does — ioredis still falls back to 127.0.0.1:6379. Treating them as
  // "set" would let the check pass on the configuration it exists to catch.
  test.each([
    ["empty", ""],
    ["a single space", " "],
    ["a tab and a newline", "\t\n"],
  ])("treats %s as missing", (_label, value) => {
    expect(findMissingEnv(["REDIS_URL"], { REDIS_URL: value })).toEqual([
      "REDIS_URL",
    ]);
  });

  // Ordering follows the requirement list, not discovery order, so the message
  // an operator reads is stable across runs.
  test("reports every missing name, in the order declared", () => {
    expect(findMissingEnv([...ATTACHMENT_WORKER_REQUIRED_ENV], {})).toEqual([
      "DATABASE_URL",
      "REDIS_URL",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ]);
  });
});

describe("resolveRequiredEnv", () => {
  // The gate that matters. Both AI call sites are fail-soft — a missing key
  // degrades extraction to regex-only and records no document understanding,
  // without failing a single job — so USE_AI enabled with no key is a worker
  // that runs forever producing quietly worse output. That is the failure this
  // turns into a refusal to start.
  test("requires the API key when USE_AI is exactly true", () => {
    expect(
      resolveRequiredEnv(EMAIL_WORKER_REQUIRED_ENV, { USE_AI: "true" }),
    ).toEqual(["DATABASE_URL", "REDIS_URL", "OPENAI_API_KEY"]);
  });

  // Matched against the literal string, the same comparison the AI call sites
  // themselves make. Demanding a key on any other value would reject a
  // configuration that never reaches the provider.
  test.each([["false"], ["TRUE"], ["1"], ["yes"], [""]])(
    "does not require the API key when USE_AI is %p",
    (value) => {
      expect(
        resolveRequiredEnv(EMAIL_WORKER_REQUIRED_ENV, { USE_AI: value }),
      ).toEqual(["DATABASE_URL", "REDIS_URL"]);
    },
  );

  test("does not require the API key when USE_AI is unset", () => {
    expect(resolveRequiredEnv(EMAIL_WORKER_REQUIRED_ENV, {})).toEqual([
      "DATABASE_URL",
      "REDIS_URL",
    ]);
  });

  // Returns a new array rather than mutating the exported constant, which is
  // shared process-wide and read by every caller after this one.
  test("leaves the base list unmodified", () => {
    const before = [...EMAIL_WORKER_REQUIRED_ENV];

    resolveRequiredEnv(EMAIL_WORKER_REQUIRED_ENV, { USE_AI: "true" });

    expect([...EMAIL_WORKER_REQUIRED_ENV]).toEqual(before);
  });
});

describe("assertWorkerEnv", () => {
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const COMPLETE = {
    DATABASE_URL: "postgresql://host/db",
    REDIS_URL: "redis://host",
  };

  test("returns quietly when the configuration is complete", () => {
    assertWorkerEnv("email-worker", EMAIL_WORKER_REQUIRED_ENV, COMPLETE);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // Exit code 1 and not 0, because systemd reads the difference: `Restart=`
  // retries a non-zero exit and `StartLimitBurst` then parks the unit in
  // `failed`, which is what makes a misconfiguration self-limiting and visible
  // in `systemctl status`. A clean 0 would look like a completed run.
  test("exits 1 when a required variable is missing", () => {
    assertWorkerEnv("email-worker", EMAIL_WORKER_REQUIRED_ENV, {
      DATABASE_URL: "postgresql://host/db",
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("names the missing variable and the worker it belongs to", () => {
    assertWorkerEnv("attachment-worker", ATTACHMENT_WORKER_REQUIRED_ENV, {
      ...COMPLETE,
      GOOGLE_CLIENT_ID: "an-id",
    });

    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");

    expect(logged).toContain("attachment-worker");
    expect(logged).toContain("GOOGLE_CLIENT_SECRET");
  });

  // THE ASSERTION THAT MAKES THIS SAFE TO RUN UNDER journalctl, whose entries
  // are readable by every member of `systemd-journal`. The check reports which
  // credential is absent; the ones that are PRESENT must not be echoed back
  // while doing so. A DATABASE_URL carries a user, a password and a host.
  test("never prints the value of a variable that is set", () => {
    assertWorkerEnv("attachment-worker", ATTACHMENT_WORKER_REQUIRED_ENV, {
      DATABASE_URL: "postgresql://admin:SUPER_SECRET@db.internal/placement",
      REDIS_URL: "redis://default:ANOTHER_SECRET@redis.internal:6379",
    });

    const logged = errorSpy.mock.calls
      .map((call) => call.map((arg: unknown) => String(arg)).join(" "))
      .join("\n");

    expect(logged).not.toContain("SUPER_SECRET");
    expect(logged).not.toContain("ANOTHER_SECRET");
    expect(logged).not.toContain("db.internal");
    expect(logged).not.toContain("redis.internal");
  });

  // The workers call this with two arguments and let the third default. If that
  // defaulting were wrong the check would read an empty object, find everything
  // missing, and refuse to start a correctly configured worker.
  test("reads process.env when no environment is supplied", () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalRedisUrl = process.env.REDIS_URL;
    const originalUseAi = process.env.USE_AI;

    process.env.DATABASE_URL = "postgresql://host/db";
    process.env.REDIS_URL = "redis://host";
    delete process.env.USE_AI;

    try {
      assertWorkerEnv("email-worker", EMAIL_WORKER_REQUIRED_ENV);

      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      // Restored precisely, including the "was unset" case: `maxWorkers: 1`
      // means the next suite in this run inherits whatever is left here.
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      };

      restore("DATABASE_URL", originalDatabaseUrl);
      restore("REDIS_URL", originalRedisUrl);
      restore("USE_AI", originalUseAi);
    }
  });
});
