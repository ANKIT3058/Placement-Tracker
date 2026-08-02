// Migration verification framework — shared types.
//
// The framework separates the *engine* (introspection, execution, reporting)
// from the *spec* (what a particular migration is expected to have achieved).
// A spec is data, not code: adding verification for a future migration means
// writing a new spec, never editing a stage.

/** How ownership is expressed in this schema. */
export type TenantConvention = {
  /** Column carrying the owner on every tenant-scoped table, e.g. "userId". */
  column: string;
  /** Table the column points at, e.g. "User". */
  ownerTable: string;
  /** Primary key of the owner table, e.g. "id". */
  ownerKey: string;
  /**
   * Restrict to these tables. Omit to auto-discover every table carrying
   * `column`, which is the reusable default — a new tenant-scoped table is then
   * verified without anyone remembering to register it.
   */
  includeTables?: string[];
  /** Tables to skip even though they carry the column. */
  excludeTables?: string[];
};

/**
 * An assertion the generic rules cannot express. The SQL must return zero rows
 * on success; every returned row is one violation and is printed.
 */
export type CustomCheck = {
  name: string;
  /** Why this matters — printed with failures so a reader need not open the spec. */
  description: string;
  sql: string;
};

export type MigrationSpec = {
  /** Stable slug; names temp databases and backup files. */
  id: string;
  title: string;
  /**
   * Migration directory names that must appear in `_prisma_migrations` before
   * verification is meaningful. Verifying a migration's effects on a database
   * that never ran it produces a confident, worthless PASS.
   */
  requiredMigrations?: string[];
  /** Omit to skip stages 3–5 entirely and run only custom checks. */
  tenant?: TenantConvention;
  customChecks?: CustomCheck[];
};

// --- Results ---------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "skip";

export type CheckResult = {
  name: string;
  status: CheckStatus;
  /** One line summarising the outcome, shown for pass and fail alike. */
  summary: string;
  /** Rendered violations, capped by the reporter. */
  details?: string[];
  /** Rows inspected, when meaningful. Reported so a vacuous pass is visible. */
  rowsChecked?: number;
};

export type StageResult = {
  stage: string;
  status: CheckStatus;
  checks: CheckResult[];
  /** Set when the stage itself could not run (missing tool, connection refused). */
  error?: string;
};
