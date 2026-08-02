import fs from "node:fs";
import path from "node:path";
import { run } from "./exec.js";

// Locating pg_dump / pg_restore.
//
// These are the only external dependencies in the framework, and only stages 1
// and 2 need them — every verification query runs through the `pg` driver that
// the application already depends on. That split is deliberate: a developer
// without the Postgres client tools installed can still run `--target`, which
// verifies a database read-only and needs nothing extra.
//
// Resolution order, most explicit first:
//   1. PG_DUMP / PG_RESTORE environment overrides
//   2. PATH
//   3. Standard Windows install locations (the tools ship with the Postgres
//      installer but are routinely left off PATH)
//   4. A Docker container running Postgres

export type PgTool = {
  kind: "native" | "docker";
  /** Executable to spawn. */
  command: string;
  /** Arguments that must precede the tool's own arguments. */
  prefixArgs: string[];
  /** Human-readable location, for diagnostics. */
  describe: string;
};

const WINDOWS_SEARCH_ROOTS = [
  "C:/Program Files/PostgreSQL",
  "C:/Program Files (x86)/PostgreSQL",
];

const onPath = async (executable: string): Promise<boolean> => {
  try {
    const result = await run(executable, ["--version"]);
    return result.code === 0;
  } catch {
    return false;
  }
};

/** Newest Postgres install first, so the tool matches a recent server version. */
const findInWindowsInstalls = (executable: string): string | null => {
  for (const root of WINDOWS_SEARCH_ROOTS) {
    if (!fs.existsSync(root)) continue;

    const versions = fs
      .readdirSync(root)
      .filter((entry) => /^\d+$/.test(entry))
      .sort((a, b) => Number(b) - Number(a));

    for (const version of versions) {
      const candidate = path.join(root, version, "bin", `${executable}.exe`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
};

const dockerContainer = async (): Promise<string | null> => {
  const configured = process.env.MIGRATION_PG_DOCKER_CONTAINER;

  if (configured) return configured;

  if (!(await onPath("docker"))) return null;

  // Auto-detect the container declared in docker-compose.yml. Only a running
  // container is accepted; a stopped one would fail confusingly later.
  const result = await run("docker", [
    "ps",
    "--filter",
    "name=placement-db",
    "--format",
    "{{.Names}}",
  ]);

  const name = result.stdout.trim().split("\n")[0];

  return name || null;
};

export const resolveTool = async (
  executable: "pg_dump" | "pg_restore",
): Promise<PgTool | null> => {
  const override =
    process.env[executable === "pg_dump" ? "PG_DUMP" : "PG_RESTORE"];

  if (override) {
    return {
      kind: "native",
      command: override,
      prefixArgs: [],
      describe: `${override} (from ${executable === "pg_dump" ? "PG_DUMP" : "PG_RESTORE"})`,
    };
  }

  if (await onPath(executable)) {
    return { kind: "native", command: executable, prefixArgs: [], describe: `${executable} (PATH)` };
  }

  const windowsPath = findInWindowsInstalls(executable);

  if (windowsPath) {
    return { kind: "native", command: windowsPath, prefixArgs: [], describe: windowsPath };
  }

  const container = await dockerContainer();

  if (container) {
    return {
      kind: "docker",
      command: "docker",
      // `-i` keeps stdin open, which pg_restore needs when a dump is piped in.
      prefixArgs: ["exec", "-i", container, executable],
      describe: `${executable} inside docker container "${container}"`,
    };
  }

  return null;
};

export const missingToolMessage = (executable: string): string =>
  [
    `${executable} was not found.`,
    "",
    "Stages 1 and 2 (backup, sandbox restore) need the PostgreSQL client tools.",
    "Resolve any one of these:",
    `  • install the PostgreSQL client tools and put ${executable} on PATH`,
    `  • set ${executable === "pg_dump" ? "PG_DUMP" : "PG_RESTORE"}=/full/path/to/${executable}`,
    "  • start the docker-compose postgres service (container placement-db)",
    "",
    "Or skip them entirely: `npm run migration:verify -- --target <url>` runs",
    "stages 3-6 read-only against a database that already exists.",
  ].join("\n");
