import { resolveConfig } from "./config.js";
import { withClient } from "./lib/db.js";

// Transfer records owned by the legacy migration owner to a real User.
//
// This is the half of the ownership migration that a migration engine must not
// perform. "Which of these accounts should own the data that predates accounts?"
// is a question about people, answerable only after somebody has authenticated,
// and therefore not a function of the database contents. The backfill migration
// parks that data under a disabled placeholder precisely so this decision can be
// made deliberately, later, by someone who knows the answer.
//
// Idempotent: re-running after a completed claim finds nothing to move.

const LEGACY_SUB = "migration:legacy-owner";

const TABLES = [
  "GmailAccount",
  "Email",
  "Event",
  "EventUpdate",
  "EmailExtraction",
  "Attachment",
] as const;

const USAGE = `
Usage: npm run migration:claim -- [options]

Transfers every record owned by the legacy migration owner to a real User.
Nothing is written without --apply.

Options:
  --to <userId>   Numeric id of the User that should own the data
  --apply         Perform the transfer (default is a dry run)
  --help          Show this message
`;

const parseArgs = (argv: string[]): { to?: number; apply: boolean } => {
  const args: { to?: number; apply: boolean } = { apply: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--to") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--to requires a positive integer User id");
      }
      args.to = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`Unrecognised argument: ${arg}\n${USAGE}`);
    }
  }

  return args;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig();

  await withClient(config.sourceUrl, async (client) => {
    const legacy = await client.query<{ id: number }>(
      `SELECT id FROM "User" WHERE "googleSub" = $1`,
      [LEGACY_SUB],
    );

    const legacyId = legacy.rows[0]?.id;

    if (!legacyId) {
      console.log(
        "No legacy migration owner exists — nothing was ever parked. Nothing to do.",
      );
      return;
    }

    // Count what is held, per table, before asking for a destination. A dry run
    // with no --to is then a useful "what is outstanding?" query.
    let total = 0;

    console.log(`Legacy owner is User id ${legacyId}. Records held:`);

    for (const table of TABLES) {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::bigint AS count FROM "${table}" WHERE "userId" = $1`,
        [legacyId],
      );

      const count = Number(rows[0]?.count ?? 0);
      total += count;

      console.log(`  ${table.padEnd(16)} ${count}`);
    }

    if (total === 0) {
      console.log("");
      console.log("Nothing is owned by the legacy owner. Already claimed.");
      return;
    }

    if (!args.to) {
      console.log("");
      console.log(`${total} record(s) outstanding. Re-run with --to <userId> --apply.`);
      console.log("");
      console.log("Candidate users:");

      const { rows } = await client.query(
        `SELECT id, email, status FROM "User" WHERE "googleSub" <> $1 ORDER BY id`,
        [LEGACY_SUB],
      );

      if (rows.length === 0) {
        console.log("  (none — sign in through Google first)");
      }

      for (const row of rows) {
        console.log(`  id=${row.id}  ${row.email}  [${row.status}]`);
      }

      return;
    }

    const destination = await client.query<{ id: number; status: string }>(
      `SELECT id, status FROM "User" WHERE id = $1 AND "deletedAt" IS NULL`,
      [args.to],
    );

    if (destination.rows.length === 0) {
      throw new Error(`User ${args.to} does not exist, or is deleted.`);
    }

    if (destination.rows[0]!.status !== "active") {
      throw new Error(
        `User ${args.to} is "${destination.rows[0]!.status}". Transferring to a non-active account would leave the data unreachable.`,
      );
    }

    if (args.to === legacyId) {
      throw new Error("Destination is the legacy owner itself.");
    }

    if (!args.apply) {
      console.log("");
      console.log(`Dry run: would transfer ${total} record(s) to User ${args.to}.`);
      console.log("Re-run with --apply to perform it.");
      return;
    }

    // One transaction. The composite foreign keys added by
    // 20260802030000_require_ownership compare a child's owner against its
    // parent's, so a partially applied transfer would violate them — every
    // table has to move together or not at all.
    await client.query("BEGIN");

    try {
      // Parents first. The composite foreign keys are ON UPDATE CASCADE, so
      // moving a parent already drags its children along — a child table
      // reporting 0 moved here means the cascade got there first, not that
      // something was missed. The explicit updates remain because the cascade
      // is a property of the current constraints, not a guarantee of this
      // script.
      for (const table of TABLES) {
        const result = await client.query(
          `UPDATE "${table}" SET "userId" = $1 WHERE "userId" = $2`,
          [args.to, legacyId],
        );

        console.log(`  ${table.padEnd(16)} ${result.rowCount} moved`);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    console.log("");
    console.log(`Transferred ${total} record(s) to User ${args.to}.`);
    console.log(
      "The legacy owner row is left in place, disabled and owning nothing; it is harmless and records that a migration happened.",
    );
  });
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
