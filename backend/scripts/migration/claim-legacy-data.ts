import type { Client } from "pg";
import { resolveConfig } from "./config.js";
import { withClient } from "./lib/db.js";
import {
  isEligibleOwner,
  resolveMailboxOwner,
  type CandidateUser,
  type MailboxOwnerResolution,
  type MailboxRef,
} from "./lib/mailbox-owner-resolver.js";

// Transfer records owned by the legacy migration owner to a real User.
//
// This is the half of the ownership migration that a migration engine must not
// perform. "Which of these accounts should own the data that predates accounts?"
// is a question about people, answerable only after somebody has authenticated,
// and therefore not a function of the database contents. The backfill migration
// parks that data under a disabled placeholder precisely so this decision can be
// made deliberately, later, by someone who knows the answer.
//
// Idempotent: re-running after a completed claim finds nothing to move.
//
// ---------------------------------------------------------------------------
// DISCOVERY (Step 1)
// ---------------------------------------------------------------------------
//
// Everything above the transfer is discovery and validation, and it writes
// nothing. Its job is to answer, before a single row moves:
//
//   * which User row is the placeholder — and that there is exactly one;
//   * which Users have actually authenticated;
//   * which of them each parked mailbox belongs to;
//   * whether that mapping is unambiguous.
//
// The transfer is one UPDATE per table inside one transaction, so it either
// applies wholesale or not at all. That makes a wrong *destination* the only
// failure it cannot undo — the rows land under a real, active User and the
// evidence that they were ever parked is gone. So the destination is derived
// from the database and cross-checked against `--to`, rather than trusted from
// the command line.

// Markers written by 20260802020000_backfill_ownership. All three are checked,
// not just `googleSub`: a placeholder created by hand, or one whose sub was
// edited, still needs to be found — silently missing it would report "nothing
// parked" while the data sits there unreachable.
const LEGACY_SUB = "migration:legacy-owner";
const LEGACY_PUBLIC_ID = "00000000-0000-4000-8000-000000000001";
const LEGACY_EMAIL = "legacy-data-owner@migration.invalid";

const TABLES = [
  "GmailAccount",
  "Email",
  "Event",
  "EventUpdate",
  "EmailExtraction",
  "Attachment",
] as const;

type OwnedTable = (typeof TABLES)[number];

const USAGE = `
Usage: npm run migration:claim -- [options]

Reports what the legacy migration owner still holds, resolves which authenticated
User each parked mailbox belongs to, and transfers the records to them.
Nothing is written without --apply.

Options:
  --to <userId>   Numeric id of the User that should own the data
  --apply         Perform the transfer (default is a dry run)
  --help          Show this message
`;

type PlaceholderRow = {
  id: number;
  publicId: string;
  googleSub: string;
  email: string;
  status: string;
  deletedAt: Date | null;
};

// A mailbox parked under the placeholder. Its shape is the resolver's input
// contract, so the two cannot drift apart.
type LegacyMailbox = MailboxRef;

type TableHolding = {
  table: OwnedTable;
  count: number;
};

// A parked mailbox paired with whatever the resolver concluded about it.
type MailboxMapping = {
  mailbox: LegacyMailbox;
  resolution: MailboxOwnerResolution;
};

const parseArgs = (argv: string[]): { to?: number; apply: boolean } => {
  const args: { to?: number; apply: boolean } = { apply: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--to") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--to requires a positive integer User id");
      }
      args.to = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`Unrecognised argument: ${arg}\n${USAGE}`);
    }
  }

  return args;
};

// --- discovery -------------------------------------------------------------

// Every User row bearing any placeholder marker. Returns all matches rather
// than the first, so "more than one placeholder" is detectable instead of
// silently resolving to whichever sorted first.
const findPlaceholders = async (client: Client): Promise<PlaceholderRow[]> => {
  const { rows } = await client.query<PlaceholderRow>(
    `SELECT id, "publicId", "googleSub", email, status, "deletedAt"
       FROM "User"
      WHERE "googleSub" = $1 OR "publicId" = $2 OR email = $3
      ORDER BY id`,
    [LEGACY_SUB, LEGACY_PUBLIC_ID, LEGACY_EMAIL],
  );

  return rows;
};

const loadHoldings = async (
  client: Client,
  legacyId: number,
): Promise<TableHolding[]> => {
  const holdings: TableHolding[] = [];

  for (const table of TABLES) {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM "${table}" WHERE "userId" = $1`,
      [legacyId],
    );

    holdings.push({ table, count: Number(rows[0]?.count ?? 0) });
  }

  return holdings;
};

// Every User that is not the placeholder. Disabled and soft-deleted rows are
// included deliberately: they are not valid destinations, but they explain why
// a mailbox failed to map.
const loadCandidateUsers = async (
  client: Client,
  legacyId: number,
): Promise<CandidateUser[]> => {
  const { rows } = await client.query<CandidateUser>(
    `SELECT id, "publicId", "googleSub", email, status, "deletedAt"
       FROM "User"
      WHERE id <> $1
      ORDER BY id`,
    [legacyId],
  );

  return rows;
};

const loadLegacyMailboxes = async (
  client: Client,
  legacyId: number,
): Promise<LegacyMailbox[]> => {
  const { rows } = await client.query<LegacyMailbox>(
    `SELECT id, email FROM "GmailAccount" WHERE "userId" = $1 ORDER BY email`,
    [legacyId],
  );

  return rows;
};

// --- mapping ---------------------------------------------------------------

// Pair every parked mailbox with its resolution.
//
// How ownership is decided is not this script's concern — `resolveMailboxOwner`
// owns that, and replacing its strategy (provider subject, AuthIdentity, merged
// accounts) changes nothing here.
const mapMailboxes = (
  mailboxes: LegacyMailbox[],
  candidates: CandidateUser[],
): MailboxMapping[] =>
  mailboxes.map((mailbox) => ({
    mailbox,
    resolution: resolveMailboxOwner(mailbox, candidates),
  }));

// --- reporting -------------------------------------------------------------

const describeUser = (user: CandidateUser | PlaceholderRow): string => {
  const deleted = user.deletedAt === null ? "" : " (deleted)";
  return `id=${user.id}  ${user.email}  [${user.status}]${deleted}`;
};

const reportPlaceholder = (placeholder: PlaceholderRow): void => {
  console.log("Legacy placeholder");
  console.log(`  id         ${placeholder.id}`);
  console.log(`  publicId   ${placeholder.publicId}`);
  console.log(`  googleSub  ${placeholder.googleSub}`);
  console.log(`  email      ${placeholder.email}`);
  console.log(`  status     ${placeholder.status}`);
  console.log("");
};

const reportHoldings = (holdings: TableHolding[], total: number): void => {
  console.log("Records held by the placeholder");

  for (const holding of holdings) {
    console.log(`  ${holding.table.padEnd(16)} ${holding.count}`);
  }

  console.log(`  ${"".padEnd(16, "-")} ----`);
  console.log(`  ${"total".padEnd(16)} ${total}`);
  console.log("");
};

const reportCandidates = (candidates: CandidateUser[]): void => {
  console.log("Authenticated users");

  for (const candidate of candidates) {
    console.log(`  ${describeUser(candidate)}`);
  }

  console.log("");
};

const reportMappings = (mappings: MailboxMapping[]): void => {
  console.log("Mailbox ownership mapping");

  if (mappings.length === 0) {
    console.log("  (the placeholder holds no mailbox)");
    console.log("");
    return;
  }

  for (const mapping of mappings) {
    const label = `  ${mapping.mailbox.email.padEnd(32)}`;

    if (mapping.resolution.type === "mapped") {
      console.log(`${label} -> ${describeUser(mapping.resolution.user)}`);
    } else if (mapping.resolution.type === "ambiguous") {
      console.log(
        `${label} -> AMBIGUOUS (${mapping.resolution.users.length} users)`,
      );
    } else {
      console.log(`${label} -> UNMAPPED`);
    }
  }

  console.log("");
};

// --- validation ------------------------------------------------------------

// Reject anything that would make the destination a guess. Each of these is
// fatal on purpose: the transfer is a single irreversible re-attribution, so a
// question the data cannot answer has to stop the run, not be resolved by a
// default.
const assertSinglePlaceholder = (placeholders: PlaceholderRow[]): void => {
  if (placeholders.length <= 1) {
    return;
  }

  const listed = placeholders
    .map((row) => `  ${describeUser(row)}  googleSub=${row.googleSub}`)
    .join("\n");

  throw new Error(
    `Found ${placeholders.length} rows bearing legacy placeholder markers; expected exactly one.\n` +
      `${listed}\n\n` +
      `20260802020000_backfill_ownership creates one placeholder, keyed on\n` +
      `googleSub='${LEGACY_SUB}'. More than one means a row was created by hand or a\n` +
      `marker was reused. Which rows belong to which placeholder is not derivable here —\n` +
      `resolve it manually before claiming.`,
  );
};

const assertCandidatesExist = (
  candidates: CandidateUser[],
  total: number,
): void => {
  const eligible = candidates.filter(isEligibleOwner);

  if (eligible.length > 0) {
    return;
  }

  if (candidates.length === 0) {
    throw new Error(
      `No authenticated users exist, but the placeholder holds ${total} record(s).\n\n` +
        `There is nowhere for this data to go. Sign in through Google (GET /gmail/auth)\n` +
        `and re-run this command.`,
    );
  }

  const listed = candidates.map((user) => `  ${describeUser(user)}`).join("\n");

  throw new Error(
    `No active authenticated user exists, but the placeholder holds ${total} record(s).\n` +
      `${listed}\n\n` +
      `Every candidate is disabled or deleted. Transferring to one would leave the data\n` +
      `unreachable, which is the state this command exists to end.`,
  );
};

const assertMappingsResolvable = (mappings: MailboxMapping[]): void => {
  const ambiguous = mappings.filter((m) => m.resolution.type === "ambiguous");
  const unmapped = mappings.filter((m) => m.resolution.type === "unmapped");

  if (ambiguous.length === 0 && unmapped.length === 0) {
    return;
  }

  const lines: string[] = [];

  for (const mapping of ambiguous) {
    if (mapping.resolution.type !== "ambiguous") continue;

    lines.push(
      `Mailbox ${mapping.mailbox.email} maps to ${mapping.resolution.users.length} active users:`,
    );
    for (const user of mapping.resolution.users) {
      lines.push(`  ${describeUser(user)}`);
    }
    lines.push(
      `  User.email is deliberately not unique (RFC-001 §8.1 — identity is keyed on`,
    );
    lines.push(
      `  googleSub), so one address can appear on several rows. Which of them connected`,
    );
    lines.push(`  this mailbox is not recorded, so the owner cannot be derived.`);
    lines.push("");
  }

  for (const mapping of unmapped) {
    if (mapping.resolution.type !== "unmapped") continue;

    lines.push(`Mailbox ${mapping.mailbox.email} maps to no active authenticated user.`);

    if (mapping.resolution.ineligible.length > 0) {
      lines.push(`  Matched, but not eligible to receive data:`);
      for (const user of mapping.resolution.ineligible) {
        lines.push(`    ${describeUser(user)}`);
      }
    } else {
      lines.push(
        `  Nobody has signed in with the Google account that owns this mailbox.`,
      );
      lines.push(
        `  Sign in as ${mapping.mailbox.email} through Google (GET /gmail/auth), then re-run.`,
      );
    }

    lines.push("");
  }

  throw new Error(
    `Mailbox ownership could not be resolved.\n\n${lines.join("\n")}` +
      `Nothing was transferred.`,
  );
};

// The single User every parked mailbox points at, or null when the placeholder
// holds no mailbox at all.
//
// Two mailboxes resolving to two different people is fatal: `--to` takes one
// id, so no value of it is correct for both, and running the transfer would
// hand one person the other's mail history.
const resolveDestination = (
  mappings: MailboxMapping[],
): CandidateUser | null => {
  const owners = new Map<number, CandidateUser>();

  for (const mapping of mappings) {
    if (mapping.resolution.type === "mapped") {
      owners.set(mapping.resolution.user.id, mapping.resolution.user);
    }
  }

  if (owners.size === 0) {
    return null;
  }

  if (owners.size > 1) {
    const listed = [...owners.values()]
      .map((user) => `  ${describeUser(user)}`)
      .join("\n");

    const attribution = mappings
      .filter((m) => m.resolution.type === "mapped")
      .map((m) =>
        m.resolution.type === "mapped"
          ? `  ${m.mailbox.email} -> id=${m.resolution.user.id}`
          : "",
      )
      .join("\n");

    throw new Error(
      `The placeholder holds mailboxes belonging to ${owners.size} different users:\n` +
        `${listed}\n\n` +
        `${attribution}\n\n` +
        `A single --to cannot be correct for all of them, and this command transfers\n` +
        `every parked record to one destination. Splitting ownership per mailbox is not\n` +
        `something this command can do.`,
    );
  }

  return [...owners.values()][0]!;
};

// --- main ------------------------------------------------------------------

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig();

  await withClient(config.sourceUrl, async (client) => {
    const placeholders = await findPlaceholders(client);

    assertSinglePlaceholder(placeholders);

    const placeholder = placeholders[0];

    // No placeholder means nothing was ever parked — the backfill assigns root
    // rows to the sole real User when one exists, and only mints a placeholder
    // otherwise. Treated as success so a re-run after a completed claim, and a
    // freshly provisioned database, both exit clean; the command promises
    // idempotency and `migration:verify` depends on it.
    //
    // With --to it is an error instead: the operator asked to transfer
    // something, and there is nothing to transfer from.
    if (!placeholder) {
      if (args.to) {
        throw new Error(
          `No legacy migration owner exists, so there is nothing to transfer to User ${args.to}.\n\n` +
            `Either the backfill never parked anything (the sole-User case), or a previous\n` +
            `claim already completed and the placeholder was removed.`,
        );
      }

      console.log(
        "No legacy migration owner exists — nothing was ever parked. Nothing to do.",
      );
      return;
    }

    const holdings = await loadHoldings(client, placeholder.id);
    const total = holdings.reduce((sum, holding) => sum + holding.count, 0);

    reportPlaceholder(placeholder);
    reportHoldings(holdings, total);

    if (total === 0) {
      console.log("Nothing is owned by the legacy owner. Already claimed.");
      return;
    }

    const candidates = await loadCandidateUsers(client, placeholder.id);

    reportCandidates(candidates);

    assertCandidatesExist(candidates, total);

    const mailboxes = await loadLegacyMailboxes(client, placeholder.id);
    const mappings = mapMailboxes(mailboxes, candidates);

    reportMappings(mappings);

    assertMappingsResolvable(mappings);

    const derived = resolveDestination(mappings);

    if (derived) {
      console.log(`Resolved destination: ${describeUser(derived)}`);
    } else {
      // Every parked mailbox has been claimed already, or the placeholder never
      // held one — Events and pre-tracking Emails can be parked without any
      // mailbox to derive an owner from. `--to` is then the only signal.
      console.log(
        "Resolved destination: none derivable (no mailbox is parked) — --to is required.",
      );
    }

    console.log("");

    if (!args.to) {
      console.log(`${total} record(s) outstanding.`);

      if (derived) {
        console.log(
          `Re-run with --to ${derived.id} --apply to transfer them.`,
        );
      } else {
        console.log("Re-run with --to <userId> --apply to transfer them.");
      }

      return;
    }

    const destination = await client.query<{ id: number; status: string }>(
      `SELECT id, status FROM "User" WHERE id = $1 AND "deletedAt" IS NULL`,
      [args.to],
    );

    if (destination.rows.length === 0) {
      throw new Error(`User ${args.to} does not exist, or is deleted.`);
    }

    if (destination.rows[0]!.status !== "active") {
      throw new Error(
        `User ${args.to} is "${destination.rows[0]!.status}". Transferring to a non-active account would leave the data unreachable.`,
      );
    }

    if (args.to === placeholder.id) {
      throw new Error("Destination is the legacy owner itself.");
    }

    // The mailbox evidence outranks the command line. Disagreement means either
    // the wrong id was typed or the mailbox belongs to someone else; both end
    // with one person holding another's mail history, and neither is detectable
    // afterwards.
    if (derived && derived.id !== args.to) {
      throw new Error(
        `--to ${args.to} contradicts the mailbox evidence.\n\n` +
          `The parked mailbox resolves to ${describeUser(derived)}.\n` +
          `Transferring to User ${args.to} would give them a mailbox history that the\n` +
          `database attributes to somebody else.`,
      );
    }

    if (!args.apply) {
      console.log(`Dry run: would transfer ${total} record(s) to User ${args.to}.`);
      console.log("Re-run with --apply to perform it.");
      return;
    }

    // One transaction. The composite foreign keys added by
    // 20260802030000_require_ownership compare a child's owner against its
    // parent's, so a partially applied transfer would violate them — every
    // table has to move together or not at all.
    await client.query("BEGIN");

    try {
      // Parents first. The composite foreign keys are ON UPDATE CASCADE, so
      // moving a parent already drags its children along — a child table
      // reporting 0 moved here means the cascade got there first, not that
      // something was missed. The explicit updates remain because the cascade
      // is a property of the current constraints, not a guarantee of this
      // script.
      for (const table of TABLES) {
        const result = await client.query(
          `UPDATE "${table}" SET "userId" = $1 WHERE "userId" = $2`,
          [args.to, placeholder.id],
        );

        console.log(`  ${table.padEnd(16)} ${result.rowCount} moved`);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    console.log("");
    console.log(`Transferred ${total} record(s) to User ${args.to}.`);
    console.log(
      "The legacy owner row is left in place, disabled and owning nothing; it is harmless and records that a migration happened.",
    );
  });
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
