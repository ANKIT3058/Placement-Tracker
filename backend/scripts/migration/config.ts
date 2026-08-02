import "dotenv/config";
import path from "node:path";

// Configuration resolution for the migration verification framework.
//
// Everything is derived from DATABASE_URL so the framework verifies the same
// database the application and the Prisma CLI use. Overrides exist for the
// cases where that derivation cannot be right.

export type ResolvedConfig = {
  /** The database being verified. Read from, never written to. */
  sourceUrl: string;
  sourceDatabase: string;
  /**
   * A database on the same server used to issue CREATE/DROP DATABASE, which
   * cannot be run while connected to the target.
   */
  maintenanceUrl: string;
  /** Where dumps are written. */
  backupDir: string;
  /** Prefix for temporary databases. Also the guard for what cleanup may drop. */
  tempDatabasePrefix: string;
};

const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `${name} is not set. The verification framework reads it from backend/.env, the same place Prisma and the application read it from.`,
    );
  }

  return value;
};

/** Swap the database name in a connection URL, preserving every other part. */
export const withDatabase = (url: string, database: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

export const databaseNameOf = (url: string): string => {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "");

  if (!name) {
    throw new Error(`Connection URL names no database: ${parsed.host}`);
  }

  return name;
};

export const resolveConfig = (): ResolvedConfig => {
  const sourceUrl = requireEnv("DATABASE_URL");
  const sourceDatabase = databaseNameOf(sourceUrl);

  // `postgres` exists on essentially every server. Overridable because managed
  // providers occasionally name it otherwise, and because the connecting role
  // may lack access to it.
  const maintenanceDatabase =
    process.env.MIGRATION_MAINTENANCE_DB || "postgres";

  return {
    sourceUrl,
    sourceDatabase,
    maintenanceUrl:
      process.env.MIGRATION_MAINTENANCE_URL ||
      withDatabase(sourceUrl, maintenanceDatabase),
    backupDir:
      process.env.MIGRATION_BACKUP_DIR ||
      path.resolve(process.cwd(), "backups", "migration"),
    // The prefix is load-bearing: cleanup refuses to drop anything without it,
    // so a configuration mistake cannot turn into a dropped production database.
    tempDatabasePrefix: process.env.MIGRATION_TEMP_PREFIX || "verify_",
  };
};
