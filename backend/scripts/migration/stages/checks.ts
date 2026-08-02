import type { Client } from "pg";
import { quoteIdent, countOf } from "../lib/db.js";
import {
  listTenantTables,
  listForeignKeys,
  appliedMigrations,
} from "../lib/introspect.js";
import type {
  CheckResult,
  MigrationSpec,
  StageResult,
  TenantConvention,
} from "../types.js";
import { stageStatus } from "../lib/reporter.js";

// Stages 3-5 plus custom checks. Every check here is generated from the live
// catalog and the spec's conventions; none of them names a table.

const asStage = (stage: string, checks: CheckResult[]): StageResult => ({
  stage,
  status: stageStatus(checks),
  checks,
});

// ---------------------------------------------------------------------------
// Precondition: were the migrations under test actually applied?
// ---------------------------------------------------------------------------
// Verifying a migration's effects against a database that never ran it yields a
// confident, meaningless PASS. This turns that into an explicit failure.

export const checkMigrationsApplied = async (
  client: Client,
  spec: MigrationSpec,
): Promise<StageResult> => {
  const required = spec.requiredMigrations ?? [];

  if (required.length === 0) {
    return asStage("Migrations Applied", [
      {
        name: "required migrations",
        status: "skip",
        summary: "spec declares none",
      },
    ]);
  }

  const applied = await appliedMigrations(client);
  const missing = required.filter((name) => !applied.includes(name));

  return asStage("Migrations Applied", [
    {
      name: "required migrations",
      status: missing.length === 0 ? "pass" : "fail",
      summary:
        missing.length === 0
          ? `all ${required.length} applied`
          : `${missing.length} of ${required.length} not applied`,
      details: missing.map((name) => `missing: ${name}`),
    },
  ]);
};

// ---------------------------------------------------------------------------
// Stage 3 — Ownership completeness
// ---------------------------------------------------------------------------
// Two distinct questions per table: does any row lack an owner (data), and is
// the column declared NOT NULL (schema). A migration that backfilled without
// constraining leaves the second unanswered, and nothing stops the next insert
// from reintroducing a null.

export const checkOwnershipComplete = async (
  client: Client,
  tenant: TenantConvention,
): Promise<StageResult> => {
  const tables = await listTenantTables(
    client,
    tenant.column,
    tenant.includeTables,
    tenant.excludeTables,
  );

  if (tables.length === 0) {
    return {
      stage: "Ownership Complete",
      status: "fail",
      checks: [],
      error: `No table carries a "${tenant.column}" column — the schema does not match the spec.`,
    };
  }

  const checks: CheckResult[] = [];

  for (const { table, notNull } of tables) {
    const { rows } = await client.query(
      `SELECT count(*)::bigint AS nulls,
              (SELECT count(*)::bigint FROM ${quoteIdent(table)}) AS total
         FROM ${quoteIdent(table)}
        WHERE ${quoteIdent(tenant.column)} IS NULL`,
    );

    const nulls = countOf(rows[0]?.nulls);
    const total = countOf(rows[0]?.total);

    const problems: string[] = [];

    if (nulls > 0) problems.push(`${nulls} row(s) with a null ${tenant.column}`);
    if (!notNull) problems.push(`${tenant.column} is still nullable in the schema`);

    checks.push({
      name: table,
      status: problems.length === 0 ? "pass" : "fail",
      summary:
        problems.length === 0
          ? `every row owned, ${tenant.column} NOT NULL`
          : problems.join("; "),
      rowsChecked: total,
    });
  }

  return asStage("Ownership Complete", checks);
};

// ---------------------------------------------------------------------------
// Stage 4 — Referential integrity
// ---------------------------------------------------------------------------
// Every foreign key in the schema is checked for orphans, not just the tenant
// ones. A declared constraint should make orphans impossible — but a constraint
// added with NOT VALID, or data loaded around one, leaves them possible, and a
// migration is exactly when that happens.

export const checkReferentialIntegrity = async (
  client: Client,
): Promise<StageResult> => {
  const foreignKeys = await listForeignKeys(client);

  if (foreignKeys.length === 0) {
    return asStage("Referential Integrity", [
      { name: "foreign keys", status: "skip", summary: "none declared" },
    ]);
  }

  const checks: CheckResult[] = [];

  for (const fk of foreignKeys) {
    const joinOn = fk.childColumns
      .map(
        (childCol, index) =>
          `child.${quoteIdent(childCol)} = parent.${quoteIdent(fk.parentColumns[index]!)}`,
      )
      .join(" AND ");

    // Postgres MATCH SIMPLE: a composite key with any NULL column is exempt
    // from the constraint. Orphan detection has to use the same rule, or a
    // legitimately-null link is reported as a violation.
    const allColumnsPresent = fk.childColumns
      .map((childCol) => `child.${quoteIdent(childCol)} IS NOT NULL`)
      .join(" AND ");

    const { rows } = await client.query(
      `SELECT count(*)::bigint AS orphans
         FROM ${quoteIdent(fk.childTable)} child
         LEFT JOIN ${quoteIdent(fk.parentTable)} parent ON ${joinOn}
        WHERE ${allColumnsPresent}
          AND parent.${quoteIdent(fk.parentColumns[0]!)} IS NULL`,
    );

    const orphans = countOf(rows[0]?.orphans);

    checks.push({
      name: `${fk.childTable}.(${fk.childColumns.join(", ")}) → ${fk.parentTable}`,
      status: orphans === 0 ? "pass" : "fail",
      summary:
        orphans === 0
          ? "no orphans"
          : `${orphans} orphan row(s) referencing a missing ${fk.parentTable}`,
      details:
        orphans === 0
          ? undefined
          : [`constraint ${fk.constraint} is not satisfied by existing data`],
    });
  }

  return asStage("Referential Integrity", checks);
};

// ---------------------------------------------------------------------------
// Stage 5 — Ownership consistency
// ---------------------------------------------------------------------------
// The rule, derived rather than enumerated: wherever a foreign key links two
// tables that BOTH carry the tenant column, the child's owner must equal the
// parent's owner.
//
// That single rule generates the whole expected chain — Email → GmailAccount,
// EmailExtraction → Email, Attachment → Email, EventUpdate → Event — from the
// schema itself, so no join is invented here and a new relationship is covered
// the moment it is declared.

export const checkOwnershipConsistency = async (
  client: Client,
  tenant: TenantConvention,
): Promise<StageResult> => {
  const tenantTables = new Set(
    (
      await listTenantTables(
        client,
        tenant.column,
        tenant.includeTables,
        tenant.excludeTables,
      )
    ).map((entry) => entry.table),
  );

  const foreignKeys = await listForeignKeys(client);

  const relevant = foreignKeys.filter(
    (fk) =>
      tenantTables.has(fk.childTable) &&
      tenantTables.has(fk.parentTable) &&
      // Skip the tenant column's own FK to the owner table: comparing a User's
      // id to itself is vacuous, and stage 4 already covers it.
      fk.parentTable !== tenant.ownerTable,
  );

  if (relevant.length === 0) {
    return asStage("Ownership Consistency", [
      {
        name: "tenant-linked relations",
        status: "skip",
        summary: "no relation joins two tenant-scoped tables",
      },
    ]);
  }

  const checks: CheckResult[] = [];

  for (const fk of relevant) {
    // Join on the declared key columns minus the tenant column, then compare
    // ownership across that join. Including the tenant column in the join would
    // make the check tautological for composite keys — the rows that disagree
    // are exactly the ones such a join excludes.
    const linkColumns = fk.childColumns
      .map((childCol, index) => ({ childCol, parentCol: fk.parentColumns[index]! }))
      .filter((pair) => pair.childCol !== tenant.column);

    if (linkColumns.length === 0) continue;

    const joinOn = linkColumns
      .map(
        (pair) =>
          `child.${quoteIdent(pair.childCol)} = parent.${quoteIdent(pair.parentCol)}`,
      )
      .join(" AND ");

    const childKey = linkColumns
      .map((pair) => `child.${quoteIdent(pair.childCol)}`)
      .join(", ");

    const { rows } = await client.query(
      `SELECT count(*)::bigint AS mismatches
         FROM ${quoteIdent(fk.childTable)} child
         JOIN ${quoteIdent(fk.parentTable)} parent ON ${joinOn}
        WHERE child.${quoteIdent(tenant.column)}
              IS DISTINCT FROM parent.${quoteIdent(tenant.column)}`,
    );

    const mismatches = countOf(rows[0]?.mismatches);

    let details: string[] | undefined;

    if (mismatches > 0) {
      const sample = await client.query(
        `SELECT ${childKey},
                child.${quoteIdent(tenant.column)}  AS child_owner,
                parent.${quoteIdent(tenant.column)} AS parent_owner
           FROM ${quoteIdent(fk.childTable)} child
           JOIN ${quoteIdent(fk.parentTable)} parent ON ${joinOn}
          WHERE child.${quoteIdent(tenant.column)}
                IS DISTINCT FROM parent.${quoteIdent(tenant.column)}
          LIMIT 20`,
      );

      details = sample.rows.map(
        (row: Record<string, unknown>) =>
          `child owner ${String(row.child_owner)} ≠ parent owner ${String(row.parent_owner)} — ${JSON.stringify(row)}`,
      );
    }

    checks.push({
      name: `${fk.childTable} → ${fk.parentTable}`,
      status: mismatches === 0 ? "pass" : "fail",
      summary:
        mismatches === 0
          ? "child and parent agree on owner"
          : `${mismatches} row(s) disagree with their parent's owner`,
      details,
    });
  }

  return asStage("Ownership Consistency", checks);
};

// ---------------------------------------------------------------------------
// Custom checks — the escape hatch for assertions the generic rules cannot make
// ---------------------------------------------------------------------------

export const runCustomChecks = async (
  client: Client,
  spec: MigrationSpec,
): Promise<StageResult> => {
  const custom = spec.customChecks ?? [];

  if (custom.length === 0) {
    return asStage("Spec Checks", [
      { name: "custom checks", status: "skip", summary: "spec declares none" },
    ]);
  }

  const checks: CheckResult[] = [];

  for (const check of custom) {
    try {
      const { rows } = await client.query(check.sql);

      checks.push({
        name: check.name,
        status: rows.length === 0 ? "pass" : "fail",
        summary:
          rows.length === 0
            ? check.description
            : `${rows.length} violation(s) — ${check.description}`,
        details: rows
          .slice(0, 20)
          .map((row: Record<string, unknown>) => JSON.stringify(row)),
      });
    } catch (error) {
      checks.push({
        name: check.name,
        status: "fail",
        summary: `check could not run: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return asStage("Spec Checks", checks);
};
