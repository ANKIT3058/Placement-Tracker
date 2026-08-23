// PR-8G — the Gmail request deadline must always be a usable number.
//
// `GMAIL_REQUEST_TIMEOUT_MS` is handed to gaxios, which turns it into
// `AbortSignal.timeout(value)`. That call rejects anything outside
// `0 <= n <= 4294967295` and anything non-integral, and it happens while the
// request is being PREPARED — before dispatch. So a value that survives parsing
// but not `AbortSignal` does not degrade the timeout, it throws a RangeError
// out of every Gmail request: total, immediate failure of all mailbox sync
// rather than the unbounded wait this constant was added to prevent.
//
// The idiom this replaced, `Number(raw) || fallback`, let exactly two such
// values through — `-1` and `Infinity` are both truthy — which is why the
// parsing is asserted here rather than assumed.
//
// NOT MOCKED. The suite reloads the real module with `process.env` set, so the
// assertions run against the production parsing and the production wiring to
// `process.env`, not a stand-in for either.

const ENV_KEY = "GMAIL_REQUEST_TIMEOUT_MS";
const DEFAULT_MS = 10000;

/* Re-imports the config module with one environment value in place. Prisma and
   the rest of the app are untouched — this module reads `process.env` at import
   time and nothing else. */
const timeoutFor = (raw: string | undefined): number => {
  const previous = process.env[ENV_KEY];

  if (raw === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = raw;
  }

  let value: number;

  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    value = (require("../config") as { GMAIL_REQUEST_TIMEOUT_MS: number })
      .GMAIL_REQUEST_TIMEOUT_MS;
  });

  if (previous === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = previous;
  }

  return value!;
};

describe("the Gmail request deadline is always usable", () => {
  const CASES: [string, string | undefined, number][] = [
    ["unset", undefined, DEFAULT_MS],
    ["a plain value", "10000", 10000],
    ["a shorter value", "5000", 5000],
    // Zero reads as "no timeout", which is the condition this constant exists
    // to remove, so it falls back rather than disabling the bound.
    ["zero", "0", DEFAULT_MS],
    // Truthy, so the previous `Number(raw) || fallback` idiom passed it
    // straight through. `AbortSignal.timeout(-1)` throws.
    ["a negative value", "-1", DEFAULT_MS],
    // Also truthy, and `AbortSignal.timeout(Infinity)` throws — it is not an
    // integer.
    ["Infinity", "Infinity", DEFAULT_MS],
    // Overflows to Infinity, so it must be caught by the same guard.
    ["a value that overflows to Infinity", "1e400", DEFAULT_MS],
    ["nonsense", "abc", DEFAULT_MS],
    ["empty", "", DEFAULT_MS],
    ["whitespace", " ", DEFAULT_MS],
  ];

  test.each(CASES)("%s resolves to a usable deadline", (_name, raw, expected) => {
    expect(timeoutFor(raw)).toBe(expected);
  });

  test.each(CASES)("%s satisfies the gaxios contract", (_name, raw) => {
    const timeout = timeoutFor(raw);

    // The invariant, stated directly: whatever the environment says, the value
    // handed to gaxios is finite and positive.
    expect(Number.isFinite(timeout)).toBe(true);
    expect(timeout).toBeGreaterThan(0);

    // And the end this all serves — `AbortSignal.timeout` accepts it, so a
    // request can actually be bounded rather than failing to start.
    expect(() => AbortSignal.timeout(timeout)).not.toThrow();
  });
});
