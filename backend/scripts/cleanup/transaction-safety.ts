// How the cleanup transaction's failures are classified.
//
// Separated from the entrypoint for the same reason the plan is: this file
// imports nothing — not even the Prisma client — so the decision "was this a
// concurrency conflict or a real bug?" can be tested from synthetic errors with
// no database in existence.
//
// NOTHING HERE RETRIES. A serialization failure means another transaction
// touched rows this one had already validated, which is precisely the condition
// under which the approved plan stops being valid: the preconditions were
// checked against a state that no longer exists. Retrying would silently
// re-derive a plan from whatever the table looks like on the second attempt,
// which is the "best-effort cleanup" the whole design refuses to perform. The
// operator re-runs the dry run and looks at what changed.

export type TransactionFailure =
  | { kind: "serialization"; detail: string }
  | { kind: "unique-violation"; detail: string }
  | { kind: "precondition"; detail: string }
  | { kind: "other"; detail: string };

/**
 * Prisma's code for a transaction aborted by a write conflict or a deadlock.
 * It is what a Postgres 40001 / 40P01 surfaces as through the client.
 */
export const PRISMA_WRITE_CONFLICT = "P2034";

/** Prisma's code for a unique constraint violation — here, `(userId, eventKey)`. */
export const PRISMA_UNIQUE_VIOLATION = "P2002";

// The SQLSTATEs and driver messages a Postgres serialization failure can arrive
// as. Matched as a fallback for the case where the error reaches us from the
// driver adapter rather than as a typed Prisma error — with a driver adapter the
// pg error can propagate with its own `code` instead of a P-code.
const SERIALIZATION_SIGNALS = [
  "could not serialize access",
  "deadlock detected",
  "40001",
  "40p01",
];

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;

  const code = (error as { code?: unknown }).code;

  return typeof code === "string" ? code : undefined;
};

export const classifyTransactionFailure = (
  error: unknown,
): TransactionFailure => {
  const message = messageOf(error);
  const code = codeOf(error);

  // Postgres raises 40001 in two ways this transaction can meet, and the
  // isolation level is what turns both into an error rather than a silent
  // anomaly:
  //
  //   - "could not serialize access due to concurrent update" — another
  //     transaction updated a row this one is deleting or updating after our
  //     snapshot was taken. First-updater-wins; it fires whatever isolation
  //     level the OTHER transaction ran at.
  //   - "could not serialize access due to read/write dependencies" — SSI found
  //     a dependency cycle among serializable transactions.
  //
  // Either way the rows this transaction validated are no longer the rows it
  // would have written, so it must stop.
  if (code === PRISMA_WRITE_CONFLICT || code === "40001" || code === "40P01") {
    return {
      kind: "serialization",
      detail: `serialization failure (${code}): ${message}`,
    };
  }

  // A colliding INSERT from a transaction that is NOT serializable is the one
  // hazard SSI does not necessarily catch — only serializable transactions
  // participate in its monitoring. The non-deferrable UNIQUE(userId, eventKey)
  // index is the backstop: a canonicalisation that would claim a key some
  // concurrent insert has just taken fails here, and the whole transaction
  // rolls back. So this is a concurrency signal too, not a planning bug.
  if (code === PRISMA_UNIQUE_VIOLATION) {
    return {
      kind: "unique-violation",
      detail: `unique constraint violated (${code}): ${message}`,
    };
  }

  if (SERIALIZATION_SIGNALS.some((signal) => message.toLowerCase().includes(signal))) {
    return { kind: "serialization", detail: `serialization failure: ${message}` };
  }

  return { kind: "other", detail: message };
};

/** What the operator is told, per failure kind. Never "retrying…". */
export const failureGuidance = (failure: TransactionFailure): string[] => {
  switch (failure.kind) {
    case "serialization":
      return [
        "CONCURRENT ACTIVITY DETECTED — the transaction was rolled back.",
        "Another transaction modified Event rows this cleanup had already validated,",
        "so the approved plan no longer describes the table it was approved against.",
        "This is NOT retried on purpose: a retry would re-plan against a state nobody reviewed.",
        "Stop every writer (local `npm run dev` / `worker:email`, the dashboard), then re-run",
        "the dry run and compare it against the approved inventory before applying again.",
      ];
    case "unique-violation":
      return [
        "IDENTITY COLLISION — the transaction was rolled back.",
        "A canonicalised eventKey collided with one that already existed, which means an",
        "Event was created or modified concurrently after the preconditions passed.",
        "Stop every writer, then re-run the dry run: the collision checks will name the pair.",
      ];
    case "precondition":
      return [
        "PRECONDITION FAILED INSIDE THE TRANSACTION — rolled back.",
        "Production no longer matches the state the plan was approved against.",
        "Re-run the read-only inventory before proceeding.",
      ];
    case "other":
      return [
        "ROLLED BACK — the transaction did not complete.",
        "Production is unchanged. Investigate the error above before re-running.",
      ];
  }
};
