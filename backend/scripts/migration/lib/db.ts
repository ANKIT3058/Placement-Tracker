import { Client } from "pg";

/**
 * Quote a SQL identifier.
 *
 * Not optional here: Prisma generates PascalCase table names, which Postgres
 * folds to lower case unquoted, so `SELECT ... FROM Email` fails. Identifiers
 * reaching this function come from the catalog or from a spec, but it escapes
 * embedded quotes regardless — an identifier is never interpolated raw.
 */
export const quoteIdent = (identifier: string): string =>
  `"${identifier.replace(/"/g, '""')}"`;

export const connect = async (connectionString: string): Promise<Client> => {
  const client = new Client({ connectionString });

  try {
    await client.connect();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const host = safeHost(connectionString);

    throw new Error(
      `Could not connect to ${host}: ${reason}`,
    );
  }

  return client;
};

/** Host and database only — never the credentials embedded in the URL. */
export const safeHost = (connectionString: string): string => {
  try {
    const url = new URL(connectionString);
    return `${url.host}${url.pathname}`;
  } catch {
    return "<unparseable connection url>";
  }
};

export const withClient = async <T>(
  connectionString: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> => {
  const client = await connect(connectionString);

  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

export const countOf = (value: unknown): number => Number(value ?? 0);
