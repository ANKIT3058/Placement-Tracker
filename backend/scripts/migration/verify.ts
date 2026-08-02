import { resolveConfig, safeParseArgs } from "./config-args.js";
import { withClient, safeHost } from "./lib/db.js";
import { printReport, printStage } from "./lib/reporter.js";
import { createBackup } from "./stages/backup.js";
import { createSandbox, dropSandbox } from "./stages/sandbox.js";
import {
  checkMigrationsApplied,
  checkOwnershipComplete,
  checkOwnershipConsistency,
  checkReferentialIntegrity,
  runCustomChecks,
} from "./stages/checks.js";
import { loadSpec } from "./specs/registry.js";
import type { StageResult } from "./types.js";

// Migration verification — entry point.
//
// Two modes:
//   sandbox (default)  backup → temp database → restore → verify → drop
//   direct (--target)  verify an existing database, read-only, no external tools
//
// Both run the identical set of checks. Sandbox mode additionally proves the
// backup is restorable, which is a property worth knowing before a deploy and
// is not otherwise tested anywhere.

const main = async (): Promise<void> => {
  const args = safeParseArgs(process.argv.slice(2));
  const config = resolveConfig();
  const spec = await loadSpec(args.spec);

  console.log("");
  console.log(`Migration verification — ${spec.title}`);
  console.log(`Spec: ${spec.id}`);

  const stages: StageResult[] = [];
  let targetUrl: string;
  let sandboxDatabase: string | null = null;

  try {
    if (args.target) {
      // Direct mode. Every check is a SELECT, so pointing this at a live
      // database is safe — but it is still someone's real data, so say so.
      console.log(`Mode: direct (read-only) against ${safeHost(args.target)}`);
      targetUrl = args.target;

      stages.push({
        stage: "Backup Created",
        status: "skip",
        checks: [
          {
            name: "backup",
            status: "skip",
            summary: "skipped in direct mode — nothing is written",
          },
        ],
      });
      stages.push({
        stage: "Restore Successful",
        status: "skip",
        checks: [
          { name: "restore", status: "skip", summary: "skipped in direct mode" },
        ],
      });
    } else {
      console.log(`Mode: sandbox (backup, restore, verify, drop)`);

      // --- Stage 1 -------------------------------------------------------
      console.log("");
      console.log("── Backup ───────────────────────────────────────────────");

      const backup = await createBackup(config, spec.id);

      console.log(`  ${(backup.bytes / 1024).toFixed(1)} KiB written`);

      stages.push({
        stage: "Backup Created",
        status: "pass",
        checks: [
          {
            name: "pg_dump",
            status: "pass",
            summary: `${backup.filePath} (${(backup.bytes / 1024).toFixed(1)} KiB)`,
          },
        ],
      });

      // --- Stage 2 -------------------------------------------------------
      console.log("");
      console.log("── Sandbox restore ──────────────────────────────────────");

      const sandbox = await createSandbox(config, spec.id, backup.filePath);

      sandboxDatabase = sandbox.database;
      targetUrl = sandbox.url;

      stages.push({
        stage: "Restore Successful",
        status: "pass",
        checks: [
          {
            name: "pg_restore",
            status: "pass",
            summary: `restored into ${sandbox.database}`,
          },
        ],
      });
    }

    // --- Stages 3-6, identical in both modes -----------------------------
    await withClient(targetUrl, async (client) => {
      // Each stage is isolated. A stage that cannot run — a missing table, a
      // malformed query — is recorded as a failure and the rest still execute,
      // because a verification tool that stops at the first problem tells you
      // about one problem when you needed the list.
      const runStage = async (
        name: string,
        stage: () => Promise<StageResult>,
      ): Promise<void> => {
        let result: StageResult;

        try {
          result = await stage();
        } catch (error) {
          result = {
            stage: name,
            status: "fail",
            checks: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }

        printStage(result);
        stages.push(result);
      };

      await runStage("Migrations Applied", () =>
        checkMigrationsApplied(client, spec),
      );

      if (spec.tenant) {
        const tenant = spec.tenant;

        await runStage("Ownership Complete", () =>
          checkOwnershipComplete(client, tenant),
        );
        await runStage("Referential Integrity", () =>
          checkReferentialIntegrity(client),
        );
        await runStage("Ownership Consistency", () =>
          checkOwnershipConsistency(client, tenant),
        );
      }

      await runStage("Spec Checks", () => runCustomChecks(client, spec));
    });
  } finally {
    if (sandboxDatabase && !args.keep) {
      console.log("");
      console.log(`── Cleanup ──────────────────────────────────────────────`);

      try {
        await dropSandbox(config, sandboxDatabase);
        console.log(`  dropped ${sandboxDatabase}`);
      } catch (error) {
        // Never let cleanup failure mask a verification result. A leaked
        // temporary database is recoverable with `migration:cleanup`; a lost
        // report is not.
        console.log(
          `  could not drop ${sandboxDatabase}: ${error instanceof Error ? error.message : String(error)}`,
        );
        console.log(`  run: npm run migration:cleanup`);
      }
    } else if (sandboxDatabase) {
      console.log("");
      console.log(`  keeping ${sandboxDatabase} (--keep)`);
    }
  }

  const passed = printReport(stages, spec.title);

  // Non-zero exit so CI can gate a deploy on this.
  process.exit(passed ? 0 : 1);
};

main().catch((error) => {
  console.error("");
  console.error("Verification could not complete:");
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  process.exit(2);
});
