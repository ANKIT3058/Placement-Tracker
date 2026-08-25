// Argument parsing and job selection for the attachment recovery script.
//
// Split out from the entrypoint on purpose: this module imports nothing — no
// BullMQ, no ioredis, no Prisma — so the logic that decides WHICH production
// jobs get retried can be exercised without a Redis connection existing. That
// decision is the only part of the tool whose failure is silent and expensive:
// a wrong filter retries the wrong jobs, and there is no undo.

// The minimum of BullMQ's `Job` this module needs. Structural rather than
// imported, which is what keeps this file dependency-free.
export type SelectableJob = {
  id?: string | null;
  attemptsMade: number;
  failedReason?: string | null;
};

export type RecoveryArgs = {
  /** Retry the selected jobs. False means dry-run — the default. */
  apply: boolean;
  /** Case-sensitive substring matched against `failedReason`. */
  reason?: string;
  /** Attachment ids to restrict recovery to. */
  ids?: number[];
};

export type Excluded<T extends SelectableJob = SelectableJob> = {
  job: T;
  /** Which filter rejected it, for the dry-run report. */
  because: string;
};

// Generic in the job type so the caller keeps the real BullMQ `Job` — including
// `retry()` — rather than the structural subset this module reads. Narrowing to
// `SelectableJob` here would force a cast at the one call site that mutates.
export type Selection<T extends SelectableJob = SelectableJob> = {
  selected: T[];
  excluded: Excluded<T>[];
};

export const USAGE = `
Usage: npm run recovery:retry-attachments -- [options]

Retries FAILED jobs on the attachment-processing queue in place. Written for the
G-7.4 incident, in which every attachment download failed with
\`invalid_request\` because the production worker was missing GOOGLE_CLIENT_ID
and GOOGLE_CLIENT_SECRET.

Modes:
  (default)          Dry run. Lists the failed jobs and what would be retried.
                     Reads Redis; mutates nothing.
  --dry-run          The same, stated explicitly.
  --apply            Actually retry the selected jobs.

Filters (combined with AND when both are given):
  --reason=<text>    Only jobs whose failedReason CONTAINS this text,
                     case-sensitively. e.g. --reason=invalid_request
  --id=<n>[,<n>...]  Only these attachment ids. e.g. --id=13,49

Other:
  --help             Show this message

The database is never touched, and \`queue.add\` is never called: a retry moves
the EXISTING job from failed to waiting, reusing its job id and hash, so no
second job can be created for the same attachment.

Dispatch the production attachment worker separately, AFTER retrying.
`;

// Only `--id=13,49` and `--id=13` are accepted. A trailing comma, an empty
// element, a negative, a float or anything non-numeric is rejected rather than
// coerced — this list decides which production jobs run again, so a value the
// operator plainly did not mean must stop the script, not be interpreted.
const parseIds = (raw: string): number[] => {
  if (raw.length === 0) {
    throw new Error("--id requires at least one attachment id");
  }

  const parts = raw.split(",");

  return parts.map((part) => {
    const trimmed = part.trim();

    if (!/^\d+$/.test(trimmed)) {
      throw new Error(
        `--id expects a comma-separated list of positive integers; got "${part}"`,
      );
    }

    const value = Number(trimmed);

    if (value <= 0) {
      throw new Error(`--id expects positive attachment ids; got "${part}"`);
    }

    return value;
  });
};

export const parseArgs = (argv: string[]): RecoveryArgs => {
  const args: RecoveryArgs = { apply: false };

  // Tracked separately from `args.apply` so that passing both --dry-run and
  // --apply is an error rather than a race between whichever came last. An
  // ambiguous instruction to a tool that mutates production must not resolve
  // itself by argument order.
  let sawDryRun = false;
  let sawApply = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }

    if (arg === "--dry-run") {
      sawDryRun = true;
      continue;
    }

    if (arg === "--apply") {
      sawApply = true;
      continue;
    }

    if (arg.startsWith("--reason=")) {
      const value = arg.slice("--reason=".length);

      if (value.length === 0) {
        throw new Error("--reason requires a value, e.g. --reason=invalid_request");
      }

      args.reason = value;
      continue;
    }

    if (arg.startsWith("--id=")) {
      args.ids = parseIds(arg.slice("--id=".length));
      continue;
    }

    // Everything else — a bare word, a typo'd flag, a `--reason value` written
    // with a space instead of `=` — stops the script. A tool that mutates a
    // production queue must never guess.
    if (arg.startsWith("-")) {
      throw new Error(`Unrecognised option: ${arg}\n${USAGE}`);
    }

    throw new Error(
      `Unexpected argument: ${arg}\nThis script takes options only.\n${USAGE}`,
    );
  }

  if (sawDryRun && sawApply) {
    throw new Error("--dry-run and --apply are mutually exclusive");
  }

  args.apply = sawApply;

  return args;
};

// The job id `enqueueAttachmentProcessing` assigns. Matching on the id rather
// than on the payload keeps this aligned with the queue's own identity — the
// same string BullMQ uses to refuse a duplicate.
export const jobIdFor = (attachmentId: number): string =>
  `attachment-${attachmentId}`;

// Partition the failed jobs into what the filters select and what they reject.
//
// Both filters are AND-ed, and both DEFAULT TO INCLUDING nothing extra: an
// absent filter is not a wildcard that widens the set beyond the failed jobs
// already fetched.
export const selectJobs = <T extends SelectableJob>(
  jobs: T[],
  args: RecoveryArgs,
): Selection<T> => {
  const wanted = args.ids ? new Set(args.ids.map(jobIdFor)) : undefined;

  const selected: T[] = [];
  const excluded: Excluded<T>[] = [];

  for (const job of jobs) {
    if (wanted && !(job.id != null && wanted.has(job.id))) {
      excluded.push({ job, because: "not in --id" });
      continue;
    }

    if (args.reason !== undefined) {
      // A job with no recorded reason can never be CONFIRMED to belong to the
      // incident, so a --reason filter excludes it. Failing closed here is the
      // point of the filter: it is what keeps recovery scoped to the failure
      // the operator is actually recovering from.
      if (job.failedReason == null || !job.failedReason.includes(args.reason)) {
        excluded.push({ job, because: "failedReason does not match --reason" });
        continue;
      }
    }

    selected.push(job);
  }

  return { selected, excluded };
};
