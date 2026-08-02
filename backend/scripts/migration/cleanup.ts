import { resolveConfig } from "./config.js";
import { withClient, quoteIdent } from "./lib/db.js";
import { assertSandboxName } from "./stages/sandbox.js";

// Safe cleanup of leaked sandbox databases.
//
// Verification drops its own sandbox, but a crashed run, a killed process, or
// an explicit --keep leaves one behind. This removes them.
//
// Two guards, both non-negotiable: only databases carrying the temporary prefix
// are considered at all, and every candidate passes the same assertion the
// verifier uses before it drops anything.

const parseArgs = (argv: string[]): { apply: boolean; olderThanHours: number } => {
  const args = { apply: false, olderThanHours: 0 };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--older-than-hours") {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("--older-than-hours requires a non-negative number");
      }
      args.olderThanHours = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: npm run migration:cleanup -- [options]

Lists sandbox databases. Nothing is dropped without --apply.

Options:
  --apply                 Actually drop the listed databases
  --older-than-hours <n>  Only consider databases older than n hours
  --help                  Show this message
`);
      process.exit(0);
    } else {
      throw new Error(`Unrecognised argument: ${arg}`);
    }
  }

  return args;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig();

  await withClient(config.maintenanceUrl, async (client) => {
    const { rows } = await client.query<{ datname: string; age_hours: number }>(
      `SELECT d.datname,
              EXTRACT(EPOCH FROM (now() - COALESCE(s.stats_reset, now()))) / 3600 AS age_hours
         FROM pg_database d
         LEFT JOIN pg_stat_database s ON s.datid = d.oid
        WHERE d.datname LIKE $1
        ORDER BY d.datname`,
      [`${config.tempDatabasePrefix}%`],
    );

    const candidates = rows.filter(
      (row) => Number(row.age_hours ?? 0) >= args.olderThanHours,
    );

    if (candidates.length === 0) {
      console.log(
        `No sandbox databases matching "${config.tempDatabasePrefix}*" to clean up.`,
      );
      return;
    }

    console.log(
      `${candidates.length} sandbox database(s) matching "${config.tempDatabasePrefix}*":`,
    );

    for (const row of candidates) {
      console.log(`  ${row.datname}`);
    }

    if (!args.apply) {
      console.log("");
      console.log("Dry run. Re-run with --apply to drop them.");
      return;
    }

    for (const row of candidates) {
      // Belt and braces: the LIKE filter already restricted this, but the
      // assertion is what stands between a misconfigured prefix and a dropped
      // production database.
      assertSandboxName(config, row.datname);

      await client.query(
        `DROP DATABASE IF EXISTS ${quoteIdent(row.datname)} WITH (FORCE)`,
      );

      console.log(`  dropped ${row.datname}`);
    }
  });
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
