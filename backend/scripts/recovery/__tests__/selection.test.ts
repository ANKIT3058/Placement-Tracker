// The decision layer of the attachment recovery tool.
//
// This is the only part of that script whose failure is silent and expensive.
// The mutation itself is BullMQ's — `job.retry()` moves an existing job from
// `failed` to `wait` in place — so it cannot create a duplicate however it is
// called. What CAN go wrong is choosing the wrong jobs: a filter that is too
// wide retries production work that failed for reasons nobody has diagnosed, and
// one that silently matches nothing lets an operator believe a recovery ran.
//
// So the assertions here are mostly negative and mostly about refusal. Nothing
// in this file imports BullMQ, ioredis or Prisma — `selection.ts` deliberately
// depends on nothing — so no connection can be opened by running it.

import {
  parseArgs,
  selectJobs,
  jobIdFor,
  type SelectableJob,
} from "../selection";

const job = (
  id: string | null,
  failedReason: string | null,
  attemptsMade = 3,
): SelectableJob => ({ id, failedReason, attemptsMade });

const INCIDENT = "invalid_request";

// The shape the incident actually left behind: OAuth refusals, plus one
// unrelated failure that recovery must not sweep up.
const FAILED: SelectableJob[] = [
  job("attachment-13", INCIDENT),
  job("attachment-49", INCIDENT),
  job("attachment-77", "Gmail returned no data for attachment … on message …"),
  job("attachment-91", null),
];

describe("dry run is the default", () => {
  test("no arguments means apply is false", () => {
    // THE SAFETY PROPERTY. Running the script with no arguments must never
    // mutate, so the flag that gates mutation defaults to off rather than
    // being inferred from anything else.
    expect(parseArgs([]).apply).toBe(false);
  });

  test("--dry-run is explicit but changes nothing", () => {
    expect(parseArgs(["--dry-run"]).apply).toBe(false);
  });

  test("only --apply turns mutation on", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
  });

  test("filters alone never imply --apply", () => {
    // A filter narrows what WOULD be retried; it must not be mistaken for an
    // instruction to retry it.
    expect(parseArgs([`--reason=${INCIDENT}`]).apply).toBe(false);
    expect(parseArgs(["--id=13"]).apply).toBe(false);
    expect(parseArgs([`--reason=${INCIDENT}`, "--id=13"]).apply).toBe(false);
  });

  test.each([
    [["--dry-run", "--apply"]],
    [["--apply", "--dry-run"]],
  ])("--dry-run with --apply is refused, in either order (%p)", (argv) => {
    // Refused rather than resolved by argument order: an ambiguous instruction
    // to a tool that mutates production must stop, not pick a winner.
    expect(() => parseArgs(argv)).toThrow(/mutually exclusive/);
  });
});

describe("malformed invocation is refused", () => {
  test.each([
    ["an unknown flag", ["--force"]],
    ["a typo'd flag", ["--aply"]],
    ["a bare positional argument", ["13"]],
    ["a filter written with a space", ["--reason", INCIDENT]],
    ["an empty reason", ["--reason="]],
    ["an empty id list", ["--id="]],
    ["a non-numeric id", ["--id=abc"]],
    ["a mixed id list", ["--id=13,abc"]],
    ["a trailing comma", ["--id=13,"]],
    ["a negative id", ["--id=-13"]],
    ["a float id", ["--id=13.5"]],
    ["a zero id", ["--id=0"]],
  ])("%s", (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });

  test("a valid id list is accepted and parsed to numbers", () => {
    expect(parseArgs(["--id=13,49"]).ids).toEqual([13, 49]);
  });

  test("surrounding whitespace in an id list is tolerated", () => {
    expect(parseArgs(["--id= 13 , 49 "]).ids).toEqual([13, 49]);
  });
});

describe("the reason filter scopes recovery to one incident", () => {
  test("it selects only matching jobs", () => {
    const { selected } = selectJobs(FAILED, {
      apply: true,
      reason: INCIDENT,
    });

    expect(selected.map((entry) => entry.id)).toEqual([
      "attachment-13",
      "attachment-49",
    ]);
  });

  test("an unrelated failure is left alone", () => {
    const { selected } = selectJobs(FAILED, { apply: true, reason: INCIDENT });

    // The whole point of filtering. A job that failed for a reason nobody has
    // diagnosed must not be retried as a side effect of recovering a different
    // incident.
    expect(selected.map((entry) => entry.id)).not.toContain("attachment-77");
  });

  test("a job with no recorded reason is excluded", () => {
    const { selected, excluded } = selectJobs(FAILED, {
      apply: true,
      reason: INCIDENT,
    });

    // Fails closed: absence of evidence is not a match. It cannot be CONFIRMED
    // to belong to the incident, so it is reported rather than swept in.
    expect(selected.map((entry) => entry.id)).not.toContain("attachment-91");
    expect(excluded.map((entry) => entry.job.id)).toContain("attachment-91");
  });

  test("matching is case-sensitive", () => {
    const { selected } = selectJobs(FAILED, {
      apply: true,
      reason: "INVALID_REQUEST",
    });

    expect(selected).toHaveLength(0);
  });

  test("matching is a substring, not equality", () => {
    const { selected } = selectJobs([job("attachment-13", INCIDENT)], {
      apply: true,
      reason: "invalid",
    });

    expect(selected).toHaveLength(1);
  });

  test("no reason filter leaves every failed job selected", () => {
    const { selected } = selectJobs(FAILED, { apply: true });

    expect(selected).toHaveLength(FAILED.length);
  });
});

describe("the id filter restricts recovery to named attachments", () => {
  test("it matches on the deterministic job id", () => {
    expect(jobIdFor(13)).toBe("attachment-13");

    const { selected } = selectJobs(FAILED, { apply: true, ids: [13] });

    expect(selected.map((entry) => entry.id)).toEqual(["attachment-13"]);
  });

  test("an id with no failed job simply selects nothing", () => {
    const { selected } = selectJobs(FAILED, { apply: true, ids: [9999] });

    expect(selected).toHaveLength(0);
  });

  test("a job with no id is never selected by an id filter", () => {
    const { selected } = selectJobs([job(null, INCIDENT)], {
      apply: true,
      ids: [13],
    });

    expect(selected).toHaveLength(0);
  });

  test("ids are not matched as substrings", () => {
    // `attachment-1` must not match a filter for attachment 13, nor the
    // reverse. Set membership on the exact id is what rules this out.
    const { selected } = selectJobs(
      [job("attachment-1", INCIDENT), job("attachment-130", INCIDENT)],
      { apply: true, ids: [13] },
    );

    expect(selected).toHaveLength(0);
  });
});

describe("both filters apply together", () => {
  test("a job must satisfy the id AND the reason", () => {
    const { selected } = selectJobs(FAILED, {
      apply: true,
      reason: INCIDENT,
      ids: [13, 77],
    });

    // 13 matches both. 77 matches the id but failed for another reason, so the
    // AND excludes it — an operator naming an id does not thereby override the
    // incident filter.
    expect(selected.map((entry) => entry.id)).toEqual(["attachment-13"]);
  });

  test("every job is accounted for as selected or excluded", () => {
    const { selected, excluded } = selectJobs(FAILED, {
      apply: true,
      reason: INCIDENT,
      ids: [13],
    });

    // Nothing may be silently dropped: the dry-run report is only trustworthy
    // if it describes the whole failed set.
    expect(selected.length + excluded.length).toBe(FAILED.length);
  });

  test("an empty failed set yields an empty selection", () => {
    const { selected, excluded } = selectJobs([], { apply: true });

    expect(selected).toHaveLength(0);
    expect(excluded).toHaveLength(0);
  });
});

describe("selection never mutates a job", () => {
  test("retry is never called during selection", () => {
    // Selection is a pure partition. The only mutation in the tool is the
    // explicit `job.retry()` loop in the entrypoint, reached only under
    // `--apply`, so a job handed to this function must come back untouched.
    const retry = jest.fn();
    const withRetry = { ...job("attachment-13", INCIDENT), retry };

    const { selected } = selectJobs([withRetry], { apply: true });

    expect(retry).not.toHaveBeenCalled();
    // And the concrete type survives, so the caller keeps the real BullMQ Job.
    expect(selected[0].retry).toBe(retry);
  });

  test("the input array is not reordered or modified", () => {
    const input = [...FAILED];
    const snapshot = input.map((entry) => ({ ...entry }));

    selectJobs(input, { apply: true, reason: INCIDENT });

    expect(input).toEqual(snapshot);
  });
});
