export { resolveConfig, withDatabase, databaseNameOf } from "./config.js";
export type { ResolvedConfig } from "./config.js";

export type CliArgs = {
  /** Spec id to run. Defaults to the ownership spec. */
  spec: string;
  /** Verify this database directly, read-only. Skips backup and restore. */
  target?: string;
  /** Leave the sandbox database in place for manual inspection. */
  keep: boolean;
};

const USAGE = `
Usage: npm run migration:verify -- [options]

Modes:
  (default)         Sandbox: back up, restore into a temporary database, verify
                    there, then drop it. Requires pg_dump and pg_restore.
  --direct          Verify DATABASE_URL in place, read-only. Every check is a
                    SELECT. Requires no PostgreSQL client tools.
  --target <url>    Verify the given database in place, read-only. Use for a
                    staging copy or a restore you made yourself.

Options:
  --spec <id>       Spec to verify (default: phase-3-ownership)
  --keep            Do not drop the sandbox database when finished
  --help            Show this message
`;

export const safeParseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = { spec: "phase-3-ownership", keep: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;

      case "--keep":
        args.keep = true;
        break;

      case "--spec": {
        const value = argv[++index];
        if (!value) throw new Error("--spec requires a value");
        args.spec = value;
        break;
      }

      case "--target": {
        const value = argv[++index];
        if (!value) throw new Error("--target requires a connection URL");
        args.target = value;
        break;
      }

      // Reads DATABASE_URL from the environment rather than the command line,
      // so a connection string carrying a password never reaches shell history.
      case "--direct": {
        const value = process.env.DATABASE_URL;
        if (!value) {
          throw new Error("--direct requires DATABASE_URL to be set");
        }
        args.target = value;
        break;
      }

      default:
        throw new Error(`Unrecognised argument: ${arg}\n${USAGE}`);
    }
  }

  return args;
};
