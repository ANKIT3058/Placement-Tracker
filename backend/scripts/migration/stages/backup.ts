import fs from "node:fs";
import path from "node:path";
import { runToFile } from "../lib/exec.js";
import { resolveTool, missingToolMessage } from "../lib/pg-tools.js";
import { safeHost } from "../lib/db.js";
import type { ResolvedConfig } from "../config.js";

// Stage 1 — Backup.
//
// A dump in Postgres' custom format (-Fc): compressed, and restorable into a
// database with a different name, which the sandbox stage depends on.

export type BackupResult = {
  filePath: string;
  bytes: number;
  tool: string;
};

/** Filesystem-safe, sortable, and unique to the second. */
const timestamp = (): string =>
  new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");

export const createBackup = async (
  config: ResolvedConfig,
  specId: string,
): Promise<BackupResult> => {
  const tool = await resolveTool("pg_dump");

  if (!tool) {
    throw new Error(missingToolMessage("pg_dump"));
  }

  fs.mkdirSync(config.backupDir, { recursive: true });

  const fileName = `${specId}_${config.sourceDatabase}_${timestamp()}.dump`;
  const filePath = path.join(config.backupDir, fileName);

  // Never overwrite. The timestamp makes a collision essentially impossible, so
  // if one occurs something is wrong enough that clobbering a backup would be
  // the worst available response.
  if (fs.existsSync(filePath)) {
    throw new Error(
      `Refusing to overwrite an existing backup at ${filePath}. Move or delete it and re-run.`,
    );
  }

  console.log(`  dumping ${safeHost(config.sourceUrl)}`);
  console.log(`  using   ${tool.describe}`);
  console.log(`  writing ${filePath}`);

  try {
    await runToFile(
      tool.command,
      [
        ...tool.prefixArgs,
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        // The dump is read-only with respect to the source. pg_dump takes no
        // exclusive locks; the working database is untouched.
        `--dbname=${config.sourceUrl}`,
      ],
      filePath,
    );
  } catch (error) {
    // A failed dump leaves a truncated file behind, which would later look like
    // a usable backup. Remove it so a partial dump can never be restored.
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    throw error;
  }

  const bytes = fs.statSync(filePath).size;

  if (bytes === 0) {
    fs.unlinkSync(filePath);
    throw new Error("pg_dump produced an empty file; treating it as a failure.");
  }

  return { filePath, bytes, tool: tool.describe };
};
