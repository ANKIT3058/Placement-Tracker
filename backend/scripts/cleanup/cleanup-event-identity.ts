import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import {
  classifyTransactionFailure,
  failureGuidance,
} from "./transaction-safety.js";
import {
  buildPlan,
  verifyPostConditions,
  DO_NOT_TOUCH_IDS,
  EVENT_54,
  HUL_SURVIVOR,
  ZANSKAR_SURVIVOR,
  type CheckResult,
  type CleanupPlan,
  type EventRow,
  type EventUpdateRow,
} from "./event-identity-plan.js";

/* ONE-OFF production cleanup for Event identity (approved 2026-08-28).
 *
 * WHAT IT REPAIRS
 *
 * The extractor now canonicalises every company (lower case, collapsed
 * whitespace, no trailing period) before it becomes part of an `eventKey`. The
 * Event table predates that rule, so 29 rows hold a non-canonical company. All
 * three recognition tiers compare `company` EXACTLY — `findByEventKey` on the
 * whole key, `findNearbyEvents` and `findByCompanyAndStage` as SQL equality —
 * so a canonical observation returns ZERO candidates against a title-cased row.
 * Nothing vetoes it; a duplicate Event is simply created. Two such pairs
 * already exist (68/71, 72/77), and three Events were keyed off parser
 * defects that are now fixed (`least`, `stipulated`, `https`).
 *
 * This script deletes those five rows and canonicalises the rest, once.
 *
 * SAFETY PROPERTY 1 — DRY RUN IS THE DEFAULT; `--apply` IS REQUIRED.
 *
 * With no arguments it issues SELECTs only, computes every intended mutation,
 * runs every precondition, writes the report artifact including Event 54's
 * exported history, and exits. There is no confirmation prompt to click through
 * and no flag that mutates by accident.
 *
 * SAFETY PROPERTY 2 — IT REFUSES TO IMPROVISE.
 *
 * Every target id and every expected field value is a constant in
 * `event-identity-plan.ts`, decided by a human against a read-only inventory.
 * If production no longer matches — a field changed, a dependent row appeared,
 * a collision group differs — the script ABORTS. It never falls back to a
 * best-effort cleanup, because "production changed since the inventory" is
 * exactly the condition under which the approved decisions stop being valid.
 *
 * SAFETY PROPERTY 3 — ONE SERIALIZABLE TRANSACTION, VERIFIED BEFORE IT COMMITS.
 *
 * All mutations run inside a single `prisma.$transaction` at SERIALIZABLE. The
 * post-conditions are then evaluated against a fresh read taken INSIDE that same
 * transaction; any failure throws, and Prisma rolls the whole thing back. The
 * database is either fully cleaned or completely untouched.
 *
 * WHY THE ISOLATION LEVEL IS LOAD-BEARING, and why re-reading is not enough on
 * its own. At the default READ COMMITTED there is a window between the
 * in-transaction revalidation and the statements it authorises: another
 * transaction — a local `npm run dev`, an email worker run, the dashboard —
 * could update Event 71 in that gap, and the DELETE would then remove a row
 * whose fields are no longer the fields that were validated. SERIALIZABLE is
 * built on snapshot isolation, so every statement here sees ONE snapshot, and a
 * write against a row another transaction has updated since that snapshot
 * raises 40001 instead of proceeding. See the transaction call for the full
 * argument, including the phantom-insert case.
 *
 * A serialization failure is NEVER retried. It means the reviewed plan no
 * longer describes the table, and re-planning silently is exactly what this
 * script refuses to do.
 *
 * SAFETY PROPERTY 4 — EVENT 54'S HISTORY IS ON DISK BEFORE ANYTHING IS WRITTEN.
 *
 * `EventUpdate` cascades on Event delete, so removing Event 54 destroys the ten
 * rows that are the only record that eight observations were ever conflated
 * into it. The export is written and read back BEFORE the transaction opens; if
 * it cannot be written, the script exits without touching production.
 *
 * WHAT IT NEVER TOUCHES: Email, EmailExtraction, Attachment, Event 37 (`TPO`),
 * Event 17 (`naukri.com`), Event 23 (`ti`), Event 72, and every legitimate
 * same-company / different-stage / different-date Event. No fuzzy matching and
 * no legal-name matching: `Infosys` and `Infosys Limited` are different
 * companies here, because `canonicalCompany` says they are.
 */

const ARTIFACT_DIR = path.resolve(import.meta.dirname, "artifacts");

export const USAGE = `
Usage: npm run cleanup:event-identity -- [options]

One-off production cleanup of Event identity. Merges two duplicate pairs,
deletes three junk Events, and canonicalises the remaining non-canonical
companies together with their eventKeys.

Modes:
  (default)      Dry run. SELECTs only. Computes and reports every intended
                 mutation, runs every precondition, writes the report artifact
                 (including Event 54's exported history) and exits.
  --dry-run      The same, stated explicitly.
  --apply        Execute the cleanup inside one SERIALIZABLE transaction.
                 A concurrent modification aborts it; it is never retried.

Other:
  --help         Show this message

Artifacts are written to scripts/cleanup/artifacts/ and are gitignored. They
contain Event identity fields and Event 54's change history only — no email
bodies, no rawText, no credentials.

Run the dry run, read the artifact, and only then re-run with --apply.
`;

type Args = { apply: boolean };

const parseArgs = (argv: string[]): Args => {
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

    throw new Error(`Unrecognised argument: ${arg}\n${USAGE}`);
  }

  // Passing both is an error rather than a race between whichever came last.
  // An ambiguous instruction to a tool that deletes production rows must not
  // resolve itself by argument order.
  if (sawDryRun && sawApply) {
    throw new Error("--dry-run and --apply are mutually exclusive");
  }

  return { apply: sawApply };
};

/** Filesystem-safe, sortable, unique to the second — as scripts/migration does. */
const timestamp = (): string =>
  new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("Z", "")
    .replace(/-\d{3}$/, "");

const line = (check: CheckResult): string =>
  `  ${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`;

// ---------------------------------------------------------------------------
// Reads. Plain `findMany`/`count` — no transaction, no writes.
// ---------------------------------------------------------------------------

// The narrow slice of the client this needs, so the same function serves both
// the outer read and the in-transaction re-read. Written structurally because
// `PrismaClient` and the `$transaction` callback's `tx` are different types that
// agree on exactly these three delegates.
type DbReader = {
  event: { findMany(args?: never): Promise<unknown[]> };
  eventUpdate: { findMany(args?: never): Promise<unknown[]> };
  emailExtraction: { count(args?: never): Promise<number> };
};

const readState = async (client: DbReader) => {
  const events = (await client.event.findMany({
    orderBy: { id: "asc" },
  } as never)) as EventRow[];

  // Every EventUpdate row, so dependent counts come from the data rather than
  // from a per-id query that could miss a row added since the inventory.
  const updates = (await client.eventUpdate.findMany({
    orderBy: { id: "asc" },
  } as never)) as EventUpdateRow[];

  const dependentUpdateCounts = new Map<number, number>();
  for (const row of updates) {
    dependentUpdateCounts.set(
      row.eventId,
      (dependentUpdateCounts.get(row.eventId) ?? 0) + 1,
    );
  }

  return {
    events,
    updates,
    dependentUpdateCounts,
    event54Updates: updates.filter((row) => row.eventId === EVENT_54),
    extractionCount: await client.emailExtraction.count(),
  };
};

// ---------------------------------------------------------------------------
// The artifact. Written before any mutation, in both modes.
// ---------------------------------------------------------------------------

const writeArtifact = (plan: CleanupPlan, mode: "dry-run" | "apply"): string => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const filePath = path.join(
    ARTIFACT_DIR,
    `cleanup-report-${timestamp()}.json`,
  );

  // Never overwrite. The timestamp makes a collision essentially impossible, so
  // if one occurs something is wrong enough that clobbering an export of
  // irrecoverable history would be the worst available response.
  if (fs.existsSync(filePath)) {
    throw new Error(
      `Refusing to overwrite an existing artifact at ${filePath}. Move it and re-run.`,
    );
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    mode,
    ok: plan.ok,
    summary: plan.summary,
    preconditions: plan.preconditions,
    merge: plan.merge,
    deletions: plan.deletions,
    canonicalisations: plan.canonicalisations,
    doNotTouch: DO_NOT_TOUCH_IDS,
    // The reason this artifact exists. `EventUpdate` cascades on delete, so
    // these ten rows are destroyed with Event 54 and live nowhere else.
    // Identity and change fields only — no email body, no rawText.
    event54EventUpdateExport: plan.event54Export.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      userId: row.userId,
      field: row.field,
      oldValue: row.oldValue,
      newValue: row.newValue,
      updatedAt: row.updatedAt.toISOString(),
    })),
  };

  fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2), "utf8");

  // Read back and re-parse before trusting it. A write that silently produced a
  // truncated file would look identical to a successful one, and this is the
  // only copy of Event 54's history that will survive the delete.
  const readBack = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
    event54EventUpdateExport: unknown[];
  };

  if (readBack.event54EventUpdateExport.length !== plan.event54Export.length) {
    throw new Error(
      `Artifact at ${filePath} does not contain all ${plan.event54Export.length} Event ${EVENT_54} history rows. Refusing to continue.`,
    );
  }

  return filePath;
};

// ---------------------------------------------------------------------------

class PostConditionError extends Error {
  constructor(readonly checks: CheckResult[]) {
    super("Post-conditions failed; rolling back.");
    this.name = "PostConditionError";
  }
}

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));

  console.log("");
  console.log("Event identity cleanup — one-off");
  console.log(
    `Mode: ${args.apply ? "APPLY (one transaction, will mutate)" : "dry run (SELECT only)"}`,
  );

  const state = await readState(prisma);

  const plan = buildPlan({
    events: state.events,
    event54Updates: state.event54Updates,
    dependentUpdateCounts: state.dependentUpdateCounts,
    extractionCount: state.extractionCount,
  });

  console.log("");
  console.log("Preconditions");
  for (const check of plan.preconditions) console.log(line(check));

  console.log("");
  console.log("Planned operations");
  console.log(
    `  merge:          ${
      plan.merge
        ? `Event ${plan.merge.eventId}.${plan.merge.field} "${plan.merge.oldValue}" -> "${plan.merge.newValue}" (+1 EventUpdate)`
        : "none"
    }`,
  );
  console.log(`  deletions:      ${plan.deletions.length}`);
  for (const deletion of plan.deletions) {
    console.log(
      `    - Event ${deletion.eventId} ${JSON.stringify(deletion.eventKey)} deps=${deletion.dependentUpdates} — ${deletion.reason}`,
    );
  }
  console.log(`  canonicalise:   ${plan.canonicalisations.length}`);
  for (const entry of plan.canonicalisations) {
    console.log(
      `    - Event ${entry.eventId} ${JSON.stringify(entry.fromCompany)} -> ${JSON.stringify(entry.toCompany)}   ${JSON.stringify(entry.fromKey)} -> ${JSON.stringify(entry.toKey)}`,
    );
  }
  console.log(`  untouched:      Events ${DO_NOT_TOUCH_IDS.join(", ")}`);
  console.log("");
  console.log(
    `  Events ${plan.summary.initialEventCount} -> ${plan.summary.finalEventCount}; ` +
      `non-canonical rows left by decision: [${plan.summary.remainingNonCanonicalIds.join(", ")}]`,
  );

  // The export is written in BOTH modes, and always before any mutation could
  // occur — a dry run that produced no artifact would be a dry run of something
  // other than what `--apply` does.
  const artifactPath = writeArtifact(plan, args.apply ? "apply" : "dry-run");

  console.log("");
  console.log(`Artifact: ${artifactPath}`);
  console.log(
    `  includes Event ${EVENT_54}'s ${plan.event54Export.length} EventUpdate rows (destroyed by cascade on delete)`,
  );

  if (!plan.ok) {
    console.error("");
    console.error("ABORT — one or more preconditions failed.");
    console.error("Production has changed since the inventory the plan was approved against.");
    console.error("Nothing was modified. Re-run the read-only inventory before proceeding.");
    return 1;
  }

  if (!args.apply) {
    console.log("");
    console.log("DRY RUN — no UPDATE, no DELETE, no INSERT was issued.");
    console.log("Review the artifact, then re-run with --apply.");
    return 0;
  }

  console.log("");
  console.log("Applying inside a single SERIALIZABLE transaction…");
  console.log("  a concurrent modification aborts it and is not retried");

  try {
    await prisma.$transaction(
      async (tx) => {
        // RE-READ AND RE-VALIDATE INSIDE THE TRANSACTION.
        //
        // The plan above was built from reads taken outside it. Between those
        // reads and this point another process — a local worker run, the
        // dashboard — could have written. Re-checking here means the mutations
        // are applied against state that has been validated within the same
        // snapshot that will commit them.
        const inner = await readState(tx);
        const revalidated = buildPlan({
          events: inner.events,
          event54Updates: inner.event54Updates,
          dependentUpdateCounts: inner.dependentUpdateCounts,
          extractionCount: inner.extractionCount,
        });

        if (!revalidated.ok) {
          throw new PostConditionError(
            revalidated.preconditions.filter((check) => !check.ok),
          );
        }

        // ORDER IS DERIVED FROM THE CONSTRAINT, NOT ASSUMED.
        //
        // `UNIQUE(userId, eventKey)` is a plain, non-deferrable index, so it is
        // checked per statement even inside one transaction. The duplicates
        // must therefore go BEFORE any canonicalisation: Event 77's canonical
        // key is Event 72's CURRENT key, so canonicalising 77 would fail
        // immediately, and canonicalising 71 after 68 would collide too. The
        // merge must precede the delete that removes the value it copies.

        // 1. Group A merge: history first, then the row — the order
        //    `updateEventService` uses, so the change is recorded even if the
        //    update fails.
        if (revalidated.merge) {
          await tx.eventUpdate.create({
            data: {
              eventId: revalidated.merge.eventId,
              userId: revalidated.merge.userId,
              field: revalidated.merge.field,
              oldValue: revalidated.merge.oldValue,
              newValue: revalidated.merge.newValue,
            },
          });

          await tx.event.update({
            where: {
              id_userId: {
                id: revalidated.merge.eventId,
                userId: revalidated.merge.userId,
              },
            },
            data: { venue: revalidated.merge.newValue },
          });
        }

        // 2. Deletions, in DELETE_IDS order (71, 77, 76, 55, 54).
        //    Scoped by (id, userId) so a wrong-owner delete is unrepresentable
        //    rather than merely unlikely.
        for (const deletion of revalidated.deletions) {
          await tx.event.delete({
            where: {
              id_userId: { id: deletion.eventId, userId: deletion.userId },
            },
          });
        }

        // 3. Canonicalisation. `company` and `eventKey` in ONE statement:
        //    the key is derived from the company, and a row whose key lags its
        //    company is exactly the inconsistency this cleanup removes.
        for (const entry of revalidated.canonicalisations) {
          await tx.event.update({
            where: { id_userId: { id: entry.eventId, userId: entry.userId } },
            data: { company: entry.toCompany, eventKey: entry.toKey },
          });
        }

        // 4. Post-conditions, against a fresh read inside this transaction.
        const after = await tx.event.findMany({ orderBy: { id: "asc" } });

        const checks = verifyPostConditions({
          events: after as EventRow[],
          event54UpdateCount: await tx.eventUpdate.count({
            where: { eventId: EVENT_54 },
          }),
          hulMergeUpdateCount: await tx.eventUpdate.count({
            where: { eventId: HUL_SURVIVOR, field: "venue" },
          }),
          extractionCount: await tx.emailExtraction.count(),
        });

        console.log("");
        console.log("Post-conditions");
        for (const check of checks) console.log(line(check));

        // THE ROLLBACK. Prisma aborts an interactive transaction when its
        // callback throws, so a single failed invariant discards every
        // statement above — the table is either fully cleaned or untouched.
        if (checks.some((check) => !check.ok)) {
          throw new PostConditionError(checks.filter((check) => !check.ok));
        }
      },
      {
        // SERIALIZABLE, and it is doing real work rather than decoration.
        //
        // THE HAZARD. The revalidation above and the statements below are
        // separate round trips. At READ COMMITTED each statement takes its own
        // snapshot, so a concurrent writer — a local `npm run dev`, an email
        // worker, the dashboard — could modify Event 71 after it was validated
        // and before it is deleted, and the DELETE would succeed against a row
        // whose fields nobody approved.
        //
        // WHAT SERIALIZABLE GIVES US. It is layered on snapshot isolation, so
        // every read here sees one snapshot AND, decisively, a write against a
        // row that another transaction has updated since that snapshot fails
        // with 40001 "could not serialize access due to concurrent update"
        // rather than silently applying. That is first-updater-wins, and it
        // holds no matter what isolation level the OTHER transaction ran at —
        // which matters, because every other writer in this system runs at the
        // default. On top of that, SSI adds read/write dependency tracking
        // among serializable transactions, which covers the case where a
        // concurrent transaction merely READS what we write.
        //
        // WHY NO EXPLICIT `SELECT … FOR UPDATE`. It would add nothing here and
        // cost raw SQL. For rows that exist, a `FOR UPDATE` on a
        // concurrently-updated row raises the same 40001 at this isolation
        // level — locking converts nothing into a success. And for the hazard
        // it is most often reached for, a concurrent INSERT that creates a new
        // colliding identity, row locks are useless: you cannot lock a row that
        // does not exist yet. That case is covered instead by the
        // non-deferrable UNIQUE(userId, eventKey) index, which fails the
        // offending statement and rolls the whole transaction back — see
        // `classifyTransactionFailure`.
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        // Generous, because this is a one-off run against a pooled remote
        // database and a timeout mid-way would roll back work that succeeded.
        maxWait: 15_000,
        timeout: 180_000,
      },
    );
  } catch (error) {
    console.error("");

    if (error instanceof PostConditionError) {
      console.error("ROLLED BACK — a check failed inside the transaction:");
      for (const check of error.checks) console.error(line(check));
      for (const advice of failureGuidance({ kind: "precondition", detail: "" })) {
        console.error(advice);
      }
    } else {
      // NOT RETRIED, deliberately. A serialization failure says the rows this
      // transaction validated were changed by someone else, so the reviewed
      // plan no longer describes the table. Re-running automatically would
      // re-derive a plan from a state no human has looked at.
      const failure = classifyTransactionFailure(error);

      console.error(`ROLLED BACK — ${failure.detail}`);
      console.error("");
      for (const advice of failureGuidance(failure)) console.error(advice);
    }

    console.error("");
    console.error("Production is unchanged. The artifact above still holds Event 54's history.");
    return 1;
  }

  console.log("");
  console.log("COMMITTED.");
  console.log(
    `  Events ${plan.summary.initialEventCount} -> ${plan.summary.finalEventCount}; ` +
      `${plan.deletions.length} deleted, ${plan.canonicalisations.length} canonicalised, 1 merged.`,
  );
  console.log(`  Event ${ZANSKAR_SURVIVOR} and Events ${DO_NOT_TOUCH_IDS.join(", ")} were not modified.`);
  console.log(`  Keep ${artifactPath}: it is the only remaining copy of Event ${EVENT_54}'s history.`);

  return 0;
};

let exitCode = 0;

try {
  exitCode = await main();
} catch (error) {
  console.error("");
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Nothing was committed. Run with --help for usage.");
  exitCode = 1;
}

// The `pg.Pool` behind the Prisma client keeps the event loop alive, exactly as
// it does in the worker. Disconnect, then exit explicitly.
await prisma.$disconnect();

process.exit(exitCode);
