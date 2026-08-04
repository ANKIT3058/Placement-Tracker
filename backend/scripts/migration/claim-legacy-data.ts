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

// Every ownership-bound table, parents before children.
//
// This is the complete set carrying a `userId` column in schema.prisma —
// Event, EventUpdate, Email, Attachment, EmailExtraction, GmailAccount — i.e.
// the six tables 20260802030000_require_ownership made NOT NULL. `User` is the
// owner side and is never transferred; nothing else in the schema is
// user-owned, so nothing else is touched here.
//
// Order is load-bearing. The composite foreign keys are ON UPDATE CASCADE, so
// updating a parent already moves its children; running children first would
// move rows that the parent's cascade then moves again.
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
User each parked mailbox belongs to, and transfers each mailbox's records to its
own owner. Nothing is written without --apply.

Options:
  --to <userId>   Owner for records that belong to no mailbox: Events,
                  EventUpdates, and Emails ingested before mailboxes were
                  tracked. Only required when it cannot be derived — with a
                  single mailbox owner it is inferred.
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

// Do the parked mailboxes agree on a single owner?
//
// Previously a divided answer was fatal, because the transfer moved everything
// to one `--to`. Transfer is now mailbox-scoped, so division is an ordinary
// outcome: each mailbox goes to its own owner. Consensus still matters for the
// records no mailbox can account for — see `resolveRemainderOwner`.
type OwnerConsensus =
  | { type: "none" }
  | { type: "unanimous"; user: CandidateUser }
  | { type: "divided"; users: CandidateUser[] };

const resolveOwnerConsensus = (mappings: MailboxMapping[]): OwnerConsensus => {
  const owners = new Map<number, CandidateUser>();

  for (const mapping of mappings) {
    if (mapping.resolution.type === "mapped") {
      owners.set(mapping.resolution.user.id, mapping.resolution.user);
    }
  }

  if (owners.size === 0) {
    return { type: "none" };
  }

  if (owners.size === 1) {
    return { type: "unanimous", user: [...owners.values()][0]! };
  }

  return { type: "divided", users: [...owners.values()] };
};

// --- transfer --------------------------------------------------------------

/** One mailbox and the User the resolver attributed it to. */
type MailboxAssignment = {
  mailbox: LegacyMailbox;
  owner: CandidateUser;
};

type TransferPlan = {
  legacyId: number;
  assignments: MailboxAssignment[];
  /**
   * Owner for records no mailbox can account for. Null when there are none, in
   * which case the remainder pass is skipped entirely.
   */
  remainderOwnerId: number | null;
};

/** One UPDATE, and which table it targets. The unit the engine executes. */
type TransferStatement = {
  table: OwnedTable;
  sql: string;
  params: unknown[];
};

type MailboxTransferResult = {
  assignment: MailboxAssignment;
  moved: TableHolding[];
};

type TransferOutcome = {
  perMailbox: MailboxTransferResult[];
  remainder: TableHolding[];
};

// Only mailboxes the resolver could attribute. `assertMappingsResolvable` has
// already refused the run if any mailbox was ambiguous or unmapped, so by the
// time this is called it is every parked mailbox — but it is derived from the
// mapping rather than assumed, so the transfer can never widen past what was
// validated.
const assignmentsOf = (mappings: MailboxMapping[]): MailboxAssignment[] =>
  mappings.flatMap((mapping) =>
    mapping.resolution.type === "mapped"
      ? [{ mailbox: mapping.mailbox, owner: mapping.resolution.user }]
      : [],
  );

// Records reachable from one mailbox, scoped to that mailbox and to the
// placeholder.
//
// `Event` and `EventUpdate` are absent by necessity, not oversight: `Event`
// carries no column linking it to the Email — or the mailbox — that produced
// it, which 20260802020000_backfill_ownership records as the same constraint
// ("Events carry no link to the Email that produced them"). Nothing here can
// attribute an Event to a mailbox, so they are left to the remainder pass.
const mailboxStatements = (
  legacyId: number,
  assignment: MailboxAssignment,
): TransferStatement[] => {
  // $1 destination, $2 placeholder, $3 mailbox
  const params = [assignment.owner.id, legacyId, assignment.mailbox.id];

  return [
    {
      table: "GmailAccount",
      sql: `UPDATE "GmailAccount" SET "userId" = $1 WHERE "userId" = $2 AND id = $3`,
      params,
    },
    {
      table: "Email",
      sql: `UPDATE "Email" SET "userId" = $1 WHERE "userId" = $2 AND "gmailAccountId" = $3`,
      params,
    },
    {
      table: "EmailExtraction",
      sql: `UPDATE "EmailExtraction" SET "userId" = $1
             WHERE "userId" = $2
               AND "emailId" IN (SELECT id FROM "Email" WHERE "gmailAccountId" = $3)`,
      params,
    },
    {
      table: "Attachment",
      sql: `UPDATE "Attachment" SET "userId" = $1
             WHERE "userId" = $2
               AND "emailId" IN (SELECT id FROM "Email" WHERE "gmailAccountId" = $3)`,
      params,
    },
  ];
};

// Whatever the mailbox passes could not reach: Events, EventUpdates, and Emails
// ingested before mailboxes were tracked (`gmailAccountId IS NULL`) together
// with their extractions and attachments. Unscoped by design — by this point
// the mailbox-reachable rows have already moved, so "still owned by the
// placeholder" is exactly the remainder.
const remainderStatements = (
  legacyId: number,
  ownerId: number,
): TransferStatement[] =>
  TABLES.map((table) => ({
    table,
    sql: `UPDATE "${table}" SET "userId" = $1 WHERE "userId" = $2`,
    params: [ownerId, legacyId],
  }));

const runStatements = async (
  client: Client,
  statements: TransferStatement[],
): Promise<TableHolding[]> => {
  const moved: TableHolding[] = [];

  for (const statement of statements) {
    const result = await client.query(statement.sql, statement.params);
    moved.push({ table: statement.table, count: result.rowCount ?? 0 });
  }

  return moved;
};

// The post-condition the whole command exists to establish: the placeholder
// owns nothing.
//
// Run inside the transaction, before COMMIT, so a failure rolls the transfer
// back rather than reporting a problem that is already durable. This is the
// same shape the backfill migration uses — verify, then let the exception undo
// the work — and it is what makes "no partial ownership transfer" true rather
// than merely intended.
const verifyPlaceholderReleased = async (
  client: Client,
  legacyId: number,
): Promise<void> => {
  const retained: string[] = [];

  for (const table of TABLES) {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM "${table}" WHERE "userId" = $1`,
      [legacyId],
    );

    const count = Number(rows[0]?.count ?? 0);

    if (count > 0) {
      retained.push(`  ${table.padEnd(16)} ${count}`);
    }
  }

  if (retained.length > 0) {
    throw new Error(
      `Transfer incomplete — the placeholder still owns records:\n` +
        `${retained.join("\n")}\n\n` +
        `Rolled back; nothing was changed.`,
    );
  }
};

// Every mailbox the resolver attributed is now owned by the User it was
// attributed to. Checks the destination directly rather than inferring it from
// "the placeholder holds nothing", which would also be satisfied by rows having
// gone somewhere else entirely.
// Run after each mailbox, inside the transaction. Confirms the mailbox row and
// every Email hanging off it now belong to the User this mailbox was assigned
// to — catching a scoped UPDATE that matched less than it should have, at the
// mailbox that caused it rather than at the end of the run.
const verifyMailboxTransferred = async (
  client: Client,
  assignment: MailboxAssignment,
): Promise<void> => {
  const { rows } = await client.query<{ mailboxOwner: number; strayEmails: string }>(
    `SELECT ga."userId" AS "mailboxOwner",
            (SELECT count(*)::bigint
               FROM "Email" e
              WHERE e."gmailAccountId" = ga.id
                AND e."userId" <> $2) AS "strayEmails"
       FROM "GmailAccount" ga
      WHERE ga.id = $1`,
    [assignment.mailbox.id, assignment.owner.id],
  );

  const row = rows[0];

  if (!row) {
    throw new Error(
      `Transfer incomplete — mailbox ${assignment.mailbox.email} (id=${assignment.mailbox.id}) disappeared mid-transfer.\n\n` +
        `Rolled back; nothing was changed.`,
    );
  }

  if (row.mailboxOwner !== assignment.owner.id) {
    throw new Error(
      `Transfer incomplete — mailbox ${assignment.mailbox.email} is owned by user ${row.mailboxOwner}, expected ${assignment.owner.id}.\n\n` +
        `Rolled back; nothing was changed.`,
    );
  }

  const stray = Number(row.strayEmails);

  if (stray > 0) {
    throw new Error(
      `Transfer incomplete — ${stray} Email(s) under ${assignment.mailbox.email} are not owned by user ${assignment.owner.id}.\n\n` +
        `Rolled back; nothing was changed.`,
    );
  }
};

// Run once after every mailbox has been transferred. Re-derives the check from
// the resolver's output rather than from the transfer's own bookkeeping, so a
// mailbox that moved to the wrong owner is caught even if each individual
// UPDATE reported success.
const verifyMailboxOwnershipMatchesResolver = async (
  client: Client,
  assignments: MailboxAssignment[],
): Promise<void> => {
  const mismatched: string[] = [];

  for (const assignment of assignments) {
    const { rows } = await client.query<{ userId: number }>(
      `SELECT "userId" FROM "GmailAccount" WHERE id = $1`,
      [assignment.mailbox.id],
    );

    const actual = rows[0]?.userId;

    if (actual !== assignment.owner.id) {
      mismatched.push(
        `  ${assignment.mailbox.email.padEnd(32)} is owned by ${actual ?? "nobody"}, resolver said ${assignment.owner.id}`,
      );
    }
  }

  if (mismatched.length > 0) {
    throw new Error(
      `Mailbox ownership does not match the resolver's output:\n` +
        `${mismatched.join("\n")}\n\n` +
        `Rolled back; nothing was changed.`,
    );
  }
};

// No child disagrees with its parent's owner.
//
// The composite foreign keys already make this unrepresentable, so this should
// be impossible rather than merely unlikely. It is asserted anyway because the
// cost is one query and the guarantee is a property of the current constraints,
// not of this script — the same reasoning that keeps the explicit child UPDATEs
// alongside the cascade.
const verifyOwnershipConsistent = async (client: Client): Promise<void> => {
  const { rows } = await client.query<{ relation: string; violations: string }>(
    `SELECT 'Email -> GmailAccount' AS relation, count(*)::bigint AS violations
       FROM "Email" e JOIN "GmailAccount" ga ON ga.id = e."gmailAccountId"
      WHERE e."userId" IS DISTINCT FROM ga."userId"
     UNION ALL
     SELECT 'EventUpdate -> Event', count(*)
       FROM "EventUpdate" eu JOIN "Event" ev ON ev.id = eu."eventId"
      WHERE eu."userId" IS DISTINCT FROM ev."userId"
     UNION ALL
     SELECT 'EmailExtraction -> Email', count(*)
       FROM "EmailExtraction" ex JOIN "Email" em ON em.id = ex."emailId"
      WHERE ex."userId" IS DISTINCT FROM em."userId"
     UNION ALL
     SELECT 'Attachment -> Email', count(*)
       FROM "Attachment" a JOIN "Email" em ON em.id = a."emailId"
      WHERE a."userId" IS DISTINCT FROM em."userId"`,
  );

  const violations = rows.filter((row) => Number(row.violations) > 0);

  if (violations.length > 0) {
    const listed = violations
      .map((row) => `  ${row.relation.padEnd(26)} ${row.violations}`)
      .join("\n");

    throw new Error(
      `Transfer produced records whose owner disagrees with their parent's:\n` +
        `${listed}\n\n` +
        `Rolled back; nothing was changed.`,
    );
  }
};

// Move every record the placeholder owns to the resolved destination.
//
// One transaction for all six tables. The composite foreign keys compare a
// child's owner against its parent's, so a partially applied transfer would
// violate them — every table has to move together or not at all. Verification
// runs inside the same transaction, so the only two outcomes are "fully
// transferred and checked" and "nothing happened".
const executeTransfer = async (
  client: Client,
  plan: TransferPlan,
): Promise<TransferOutcome> => {
  await client.query("BEGIN");

  try {
    const perMailbox: MailboxTransferResult[] = [];

    // One mailbox at a time, each to its own resolved owner. Parents first
    // within a mailbox: the composite foreign keys are ON UPDATE CASCADE, so
    // moving the GmailAccount already drags its Emails — and their extractions
    // and attachments — along. A child reporting 0 moved means the cascade got
    // there first, not that something was missed. The explicit updates remain
    // because the cascade is a property of the current constraints, not a
    // guarantee of this script.
    for (const assignment of plan.assignments) {
      const moved = await runStatements(
        client,
        mailboxStatements(plan.legacyId, assignment),
      );

      await verifyMailboxTransferred(client, assignment);

      perMailbox.push({ assignment, moved });
    }

    // Everything the mailbox passes could not reach.
    const remainder =
      plan.remainderOwnerId === null
        ? []
        : await runStatements(
            client,
            remainderStatements(plan.legacyId, plan.remainderOwnerId),
          );

    await verifyPlaceholderReleased(client, plan.legacyId);
    await verifyMailboxOwnershipMatchesResolver(client, plan.assignments);
    await verifyOwnershipConsistent(client);

    await client.query("COMMIT");

    return { perMailbox, remainder };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
};

const summariseMoved = (moved: TableHolding[]): string =>
  moved
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.table} ${entry.count}`)
    .join(", ") || "nothing moved directly (cascade)";

const reportTransfer = (outcome: TransferOutcome): void => {
  console.log("Ownership transferred");

  for (const result of outcome.perMailbox) {
    console.log(
      `  ${result.assignment.mailbox.email.padEnd(32)} -> user ${result.assignment.owner.id}`,
    );
    console.log(`      ${summariseMoved(result.moved)}`);
    console.log(`      verified OK`);
  }

  if (outcome.remainder.length > 0) {
    console.log(`  ${"(records with no mailbox)".padEnd(32)}`);
    console.log(`      ${summariseMoved(outcome.remainder)}`);
  }

  console.log("");
  console.log("Final verification (inside the transaction)");
  console.log("  placeholder owns nothing                OK");
  console.log("  mailbox owners match resolver output    OK");
  console.log("  children agree with their parents       OK");
  console.log("");
};

// Records the mailbox passes cannot reach: Events, EventUpdates, and Emails
// ingested before mailboxes were tracked. Counting Email alone is enough for
// the decision — its extractions and attachments cascade with it.
const loadUnreachableCount = async (
  client: Client,
  legacyId: number,
): Promise<number> => {
  const { rows } = await client.query<{ count: string }>(
    `SELECT (
       (SELECT count(*) FROM "Event"       WHERE "userId" = $1)
     + (SELECT count(*) FROM "EventUpdate" WHERE "userId" = $1)
     + (SELECT count(*) FROM "Email"       WHERE "userId" = $1 AND "gmailAccountId" IS NULL)
     )::bigint AS count`,
    [legacyId],
  );

  return Number(rows[0]?.count ?? 0);
};

// Who receives the records no mailbox accounts for.
//
// `--to` wins when supplied — with several mailbox owners it is the only way to
// name one. Otherwise a unanimous mailbox owner is used. A divided mapping with
// no `--to` is refused rather than guessed: an Event cannot be attributed to a
// mailbox, so nothing in the data says which of the owners should hold it.
// Returned rather than thrown, so a dry run can report an undecidable
// remainder as information instead of failing on a read-only query. Only
// `--apply` turns it into an error.
type RemainderPlan =
  | { type: "none" }
  | { type: "owner"; userId: number }
  | { type: "undecidable"; reason: string };

const resolveRemainderOwner = (
  explicit: number | undefined,
  consensus: OwnerConsensus,
  unreachable: number,
): RemainderPlan => {
  if (unreachable === 0) {
    return { type: "none" };
  }

  if (explicit) {
    return { type: "owner", userId: explicit };
  }

  if (consensus.type === "unanimous") {
    return { type: "owner", userId: consensus.user.id };
  }

  if (consensus.type === "divided") {
    const listed = consensus.users
      .map((user) => `  ${describeUser(user)}`)
      .join("\n");

    return {
      type: "undecidable",
      reason:
        `${unreachable} record(s) belong to no mailbox — Events, EventUpdates, and Emails\n` +
        `ingested before mailboxes were tracked — and the parked mailboxes resolve to\n` +
        `${consensus.users.length} different users:\n${listed}\n\n` +
        `An Event carries no link to the mailbox that produced it, so nothing in the data\n` +
        `says which of them should own these. Name the owner explicitly with --to <userId>.`,
    };
  }

  return {
    type: "undecidable",
    reason:
      `${unreachable} record(s) belong to no mailbox, and no mailbox is parked to derive\n` +
      `an owner from. Name the owner explicitly with --to <userId>.`,
  };
};

const reportPlan = (
  assignments: MailboxAssignment[],
  remainder: RemainderPlan,
  unreachable: number,
): void => {
  console.log("Transfer plan");

  for (const assignment of assignments) {
    console.log(
      `  ${assignment.mailbox.email.padEnd(32)} -> ${describeUser(assignment.owner)}`,
    );
  }

  if (remainder.type === "owner") {
    console.log(
      `  ${"(records with no mailbox)".padEnd(32)} -> user ${remainder.userId}  [${unreachable} record(s)]`,
    );
  } else if (remainder.type === "undecidable") {
    console.log(
      `  ${"(records with no mailbox)".padEnd(32)} -> UNDECIDABLE  [${unreachable} record(s)]`,
    );
  }

  console.log("");
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

    // Each mailbox carries its own destination now, so `--to` no longer names
    // "the" destination — it names the owner for records no mailbox accounts
    // for, and is only needed when that cannot be derived.
    const assignments = assignmentsOf(mappings);
    const consensus = resolveOwnerConsensus(mappings);
    const unreachable = await loadUnreachableCount(client, placeholder.id);

    if (args.to) {
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

      // The mailbox evidence outranks the command line, but only where the
      // evidence is unanimous. With several mailbox owners `--to` is not a
      // competing claim about a mailbox — it names the owner for the records no
      // mailbox can account for — so it is not a contradiction.
      if (consensus.type === "unanimous" && consensus.user.id !== args.to) {
        throw new Error(
          `--to ${args.to} contradicts the mailbox evidence.\n\n` +
            `Every parked mailbox resolves to ${describeUser(consensus.user)}.\n` +
            `Transferring to User ${args.to} would give them a mailbox history that the\n` +
            `database attributes to somebody else.`,
        );
      }
    }

    const remainder = resolveRemainderOwner(args.to, consensus, unreachable);

    reportPlan(assignments, remainder, unreachable);

    if (!args.apply) {
      if (remainder.type === "undecidable") {
        console.log(remainder.reason);
        console.log("");
      }

      console.log(`Dry run: ${total} record(s) outstanding, nothing was changed.`);
      console.log("Re-run with --apply to perform the transfer.");
      return;
    }

    if (remainder.type === "undecidable") {
      throw new Error(remainder.reason);
    }

    const outcome = await executeTransfer(client, {
      legacyId: placeholder.id,
      assignments,
      remainderOwnerId: remainder.type === "owner" ? remainder.userId : null,
    });

    reportTransfer(outcome);

    console.log(`Transferred ${total} record(s).`);
    console.log(
      "The legacy owner row is left in place, disabled and owning nothing; it is harmless and records that a migration happened.",
    );
  });
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
