import type { Client } from "pg";

// Schema introspection.
//
// This is what keeps the framework from hardcoding a migration's shape. Every
// check in stages 3-5 is derived from the live catalog, so it applies to
// whatever tables and foreign keys the schema actually has — including ones
// added after this framework was written. Nobody has to remember to register a
// new tenant-scoped table.

const SCHEMA = process.env.MIGRATION_SCHEMA || "public";

export type TenantTable = {
  table: string;
  /** Whether the tenant column is declared NOT NULL in the catalog. */
  notNull: boolean;
};

export type ForeignKey = {
  constraint: string;
  childTable: string;
  childColumns: string[];
  parentTable: string;
  parentColumns: string[];
};

/**
 * Every table carrying the tenant column.
 *
 * Discovered rather than listed, so a table added by a later migration is
 * verified automatically. `include`/`exclude` in the spec narrow this when a
 * table legitimately carries the column without being tenant-scoped.
 */
export const listTenantTables = async (
  client: Client,
  tenantColumn: string,
  include?: string[],
  exclude?: string[],
): Promise<TenantTable[]> => {
  const { rows } = await client.query<{ table_name: string; is_nullable: string }>(
    `SELECT c.table_name, c.is_nullable
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema
        AND t.table_name = c.table_name
      WHERE c.table_schema = $1
        AND c.column_name = $2
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name`,
    [SCHEMA, tenantColumn],
  );

  return rows
    .map((row) => ({
      table: row.table_name,
      notNull: row.is_nullable === "NO",
    }))
    .filter((entry) => (include ? include.includes(entry.table) : true))
    .filter((entry) => (exclude ? !exclude.includes(entry.table) : true));
};

/**
 * Every foreign key in the schema, with its column pairs in order.
 *
 * Composite keys come back as multi-element arrays, which is what lets stage 5
 * see that a child references its parent *and* its parent's owner together.
 */
export const listForeignKeys = async (client: Client): Promise<ForeignKey[]> => {
  const { rows } = await client.query<{
    constraint_name: string;
    child_table: string;
    child_columns: string[];
    parent_table: string;
    parent_columns: string[];
  }>(
    `SELECT con.conname                     AS constraint_name,
            child.relname                   AS child_table,
            ARRAY(
              SELECT a.attname
                FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a
                  ON a.attrelid = con.conrelid AND a.attnum = k.attnum
               ORDER BY k.ord
            )::text[]                       AS child_columns,
            parent.relname                  AS parent_table,
            ARRAY(
              SELECT a.attname
                FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a
                  ON a.attrelid = con.confrelid AND a.attnum = k.attnum
               ORDER BY k.ord
            )::text[]                       AS parent_columns
       FROM pg_constraint con
       JOIN pg_class child  ON child.oid  = con.conrelid
       JOIN pg_class parent ON parent.oid = con.confrelid
       JOIN pg_namespace ns ON ns.oid     = child.relnamespace
      WHERE con.contype = 'f'
        AND ns.nspname = $1
      ORDER BY child.relname, con.conname`,
    [SCHEMA],
  );

  // `name[]` has no default parser in node-postgres and arrives as the raw
  // literal `{a,b}`. The cast above makes it text[], which pg does parse — this
  // guard catches a regression if that cast is ever dropped.
  for (const row of rows) {
    if (!Array.isArray(row.child_columns) || !Array.isArray(row.parent_columns)) {
      throw new Error(
        `Foreign key ${row.constraint_name}: expected column arrays, received ${typeof row.child_columns}. The ::text[] casts in listForeignKeys are required.`,
      );
    }
  }

  return rows.map((row) => ({
    constraint: row.constraint_name,
    childTable: row.child_table,
    childColumns: row.child_columns,
    parentTable: row.parent_table,
    parentColumns: row.parent_columns,
  }));
};

export const tableExists = async (
  client: Client,
  table: string,
): Promise<boolean> => {
  const { rows } = await client.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2`,
    [SCHEMA, table],
  );

  return rows.length > 0;
};

/** Migration directory names recorded as applied by Prisma Migrate. */
export const appliedMigrations = async (client: Client): Promise<string[]> => {
  if (!(await tableExists(client, "_prisma_migrations"))) {
    return [];
  }

  const { rows } = await client.query<{ migration_name: string }>(
    `SELECT migration_name
       FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY finished_at`,
  );

  return rows.map((row) => row.migration_name);
};
