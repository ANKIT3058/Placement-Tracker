import { runFromFile } from "../lib/exec.js";
import { resolveTool, missingToolMessage } from "../lib/pg-tools.js";
import { quoteIdent, withClient } from "../lib/db.js";
import { withDatabase, type ResolvedConfig } from "../config.js";

// Stage 2 — Temporary verification database.
//
// The backup is restored into a throwaway database and every check runs there.
// The developer's working database is only ever read, and only by pg_dump.

export type Sandbox = {
  database: string;
  url: string;
};

const sandboxName = (config: ResolvedConfig, specId: string): string => {
  // Postgres truncates identifiers at 63 bytes; keep well inside that.
  const slug = specId.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 24);
  const stamp = Date.now().toString(36);

  return `${config.tempDatabasePrefix}${slug}_${stamp}`;
};

/**
 * Guard against ever issuing DROP/CREATE against something that is not ours.
 *
 * Called before every destructive statement rather than once at creation: the
 * cost is negligible and the failure it prevents is unrecoverable.
 */
export const assertSandboxName = (
  config: ResolvedConfig,
  database: string,
): void => {
  if (!database.startsWith(config.tempDatabasePrefix)) {
    throw new Error(
      `Refusing to operate on "${database}": it does not start with the temporary prefix "${config.tempDatabasePrefix}".`,
    );
  }

  if (database === config.sourceDatabase) {
    throw new Error(
      `Refusing to operate on "${database}": it is the source database.`,
    );
  }
};

export const createSandbox = async (
  config: ResolvedConfig,
  specId: string,
  backupPath: string,
): Promise<Sandbox> => {
  const tool = await resolveTool("pg_restore");

  if (!tool) {
    throw new Error(missingToolMessage("pg_restore"));
  }

  const database = sandboxName(config, specId);
  assertSandboxName(config, database);

  await withClient(config.maintenanceUrl, async (client) => {
    // Parameters are not permitted in CREATE DATABASE; the name is generated
    // here, never supplied by a caller, and is quoted regardless.
    await client.query(`CREATE DATABASE ${quoteIdent(database)}`);
  });

  const url = withDatabase(config.sourceUrl, database);

  console.log(`  created ${database}`);
  console.log(`  using   ${tool.describe}`);

  const result = await runFromFile(
    tool.command,
    [
      ...tool.prefixArgs,
      "--no-owner",
      "--no-privileges",
      // Keep going past errors, then judge the outcome by verification rather
      // than by exit code. Restores routinely emit non-fatal noise about roles
      // and extensions that exist on the source but not here.
      "--exit-on-error=false",
      `--dbname=${url}`,
    ],
    backupPath,
  );

  if (result.code !== 0) {
    console.log(
      `  note    pg_restore exited ${result.code}; continuing so verification can judge the result`,
    );
  }

  return { database, url };
};

export const dropSandbox = async (
  config: ResolvedConfig,
  database: string,
): Promise<void> => {
  assertSandboxName(config, database);

  await withClient(config.maintenanceUrl, async (client) => {
    // FORCE terminates leftover connections; without it a stray client keeps
    // the throwaway database alive indefinitely.
    await client.query(
      `DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`,
    );
  });
};
