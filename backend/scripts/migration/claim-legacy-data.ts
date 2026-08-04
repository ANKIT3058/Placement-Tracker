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

Mailbox-linked records are resolved automatically and never need --to.

Options:
  --to <userId>   Operator destination for records whose mailbox ownership no
                  longer exists: Events, EventUpdates, and Emails ingested
                  before mailboxes were tracked. Nothing infers this — the
                  provenance was never recorded — so it is REQUIRED whenever
                  such records are parked, and ignored when none are.
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
// Distinct Users the parked mailboxes resolve to. Reporting only — it is never
// an input to any ownership decision.
//
// An earlier revision used a unanimous answer here to infer an owner for the
// records no mailbox accounts for. That inference is now removed: those records
// are Class C, their mailbox provenance was never recorded (Event has never
// carried a link to Email in any migration, and `Email.gmailAccountId` arrived
// only in 20260707111227, unbackfillable), and "the mailbox owner is probably
// also the owner of the orphans" is a guess. A guess that assigns one person's
// records to another is exactly what this command must not make, so the owner
// is now required explicitly via --to.
const distinctMailboxOwners = (
  assignments: MailboxAssignment[],
): CandidateUser[] => {
  const owners = new Map<number, CandidateUser>();

  for (const assignment of assignments) {
    owners.set(assignment.owner.id, assignment.owner);
  }

  return [...owners.values()];
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

// The operator pass: records whose mailbox provenance does not exist.
//
// Every statement is scoped to rows that are structurally mailbox-less, not
// merely to "whatever is left". Relying on execution order would make the
// operator's destination a catch-all — a mailbox row the earlier pass somehow
// missed would be swept up and silently reassigned. Scoped this way it cannot
// be: a missed mailbox row matches nothing here, stays with the placeholder,
// and `verifyPlaceholderReleased` fails the transaction.
//
//   Event, EventUpdate  — no link to a mailbox has ever existed in any migration
//   Email               — gmailAccountId IS NULL (pre-07-07 sync, or manual route)
//   EmailExtraction,
//   Attachment          — children of those mailbox-less Emails
const remainderStatements = (
  legacyId: number,
  ownerId: number,
): TransferStatement[] => {
  const params = [ownerId, legacyId];

  // Deliberately not filtered on the Email's owner: the Email UPDATE below runs
  // first and cascades onto its children, so by the time the child statements
  // run their parent has already moved. Selecting on `gmailAccountId IS NULL`
  // alone keeps them a meaningful safety net rather than guaranteed no-ops.
  const mailboxlessEmails = `SELECT id FROM "Email" WHERE "gmailAccountId" IS NULL`;

  return [
    {
      table: "Email",
      sql: `UPDATE "Email" SET "userId" = $1
             WHERE "userId" = $2 AND "gmailAccountId" IS NULL`,
      params,
    },
    {
      table: "EmailExtraction",
      sql: `UPDATE "EmailExtraction" SET "userId" = $1
             WHERE "userId" = $2 AND "emailId" IN (${mailboxlessEmails})`,
      params,
    },
    {
      table: "Attachment",
      sql: `UPDATE "Attachment" SET "userId" = $1
             WHERE "userId" = $2 AND "emailId" IN (${mailboxlessEmails})`,
      params,
    },
    {
      table: "Event",
      sql: `UPDATE "Event" SET "userId" = $1 WHERE "userId" = $2`,
      params,
    },
    {
      table: "EventUpdate",
      sql: `UPDATE "EventUpdate" SET "userId" = $1 WHERE "userId" = $2`,
      params,
    },
  ];
};

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

    // The operator pass. Snapshot first: the ids are what the post-transfer
    // check verifies against, and they must be read while the rows still belong
    // to the placeholder.
    let remainder: TableHolding[] = [];
    let snapshot: RemainderSnapshot | null = null;

    if (plan.remainderOwnerId !== null) {
      snapshot = await snapshotRemainder(client, plan.legacyId);

      remainder = await runStatements(
        client,
        remainderStatements(plan.legacyId, plan.remainderOwnerId),
      );
    }

    await verifyPlaceholderReleased(client, plan.legacyId);

    // Mailbox-linked ownership is unchanged by the operator pass. Re-running
    // the same per-mailbox check afterwards is what proves it: if the operator
    // statements had reached a mailbox row, its owner would no longer match the
    // resolver's attribution.
    for (const assignment of plan.assignments) {
      await verifyMailboxTransferred(client, assignment);
    }

    await verifyMailboxOwnershipMatchesResolver(client, plan.assignments);

    if (snapshot && plan.remainderOwnerId !== null) {
      await verifyRemainderTransferred(client, snapshot, plan.remainderOwnerId);
    }

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

const reportTransfer = (
  outcome: TransferOutcome,
  remainder: RemainderPlan,
): void => {
  console.log("Automatic transfer (mailbox-resolved) — applied");
  console.log("");

  if (outcome.perMailbox.length === 0) {
    console.log("  (no mailbox was parked)");
  }

  for (const result of outcome.perMailbox) {
    console.log(`  ${result.assignment.mailbox.email}`);
    console.log(`      -> user ${result.assignment.owner.id}`);
    console.log(`      ${summariseMoved(result.moved)}`);
    console.log(`      verified OK`);
  }

  console.log("");
  console.log(RULE);
  console.log("");
  console.log("Operator transfer — applied");
  console.log("");

  if (remainder.type === "operator") {
    console.log(`  ${remainder.count} legacy record(s)`);
    console.log(`      -> user ${remainder.userId}`);
    console.log(`      ${summariseMoved(outcome.remainder)}`);
    console.log(`      verified OK`);
    console.log("");
    console.log("  Reason:");
    console.log("      Mailbox ownership unavailable in historical schema.");
    console.log("      Operator explicitly selected destination.");
  } else {
    console.log("  (nothing — every parked record had a mailbox)");
  }

  console.log("");
  console.log(RULE);
  console.log("");
  console.log("Final verification (inside the transaction)");
  console.log("  placeholder owns nothing                    OK");
  console.log("  mailbox-linked ownership unchanged          OK");
  console.log("  mailbox owners match resolver output        OK");

  if (remainder.type === "operator") {
    console.log("  operator records owned by selected user     OK");
  }

  console.log("  children agree with their parents           OK");
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

// Who receives the records whose mailbox provenance does not exist.
//
// There is exactly one source: `--to`. Nothing is inferred, because there is
// nothing to infer from — the investigation established these records as
// Class C. `Event` has never carried a link to `Email` in any of the fourteen
// migrations, `Email.gmailAccountId` arrived only in 20260707111227 and could
// not be backfilled, and the recipient headers that would have identified the
// mailbox were never persisted (`parseMessage` keeps Subject, From and Date
// only). No column, index, or child row anywhere in the schema distinguishes
// which mailbox produced them.
//
// So this is not a resolution step. It records an operator decision, and
// refuses to proceed without one.
//
// Returned rather than thrown so a dry run can report the situation instead of
// failing on a read-only query. Only `--apply` turns it into an error.
type RemainderPlan =
  | { type: "none" }
  | { type: "operator"; userId: number; count: number }
  | { type: "undecidable"; reason: string };

const resolveRemainderOwner = (
  explicit: number | undefined,
  unreachable: number,
): RemainderPlan => {
  if (unreachable === 0) {
    return { type: "none" };
  }

  if (explicit) {
    return { type: "operator", userId: explicit, count: unreachable };
  }

  return {
    type: "undecidable",
    reason:
      `${unreachable} record(s) have no recoverable mailbox ownership.\n\n` +
      `These are Events, EventUpdates, and Emails whose originating mailbox was never\n` +
      `recorded: Event has never carried a link to Email, and Email.gmailAccountId was\n` +
      `introduced only in 20260707111227 without a backfill. Nothing in the schema can\n` +
      `identify which mailbox produced them, so the migration will not guess.\n\n` +
      `Name the destination explicitly:  npm run migration:claim -- --to <userId> --apply`,
  };
};

/**
 * The exact rows the operator pass will move, captured before it runs.
 *
 * Ids rather than counts, so the post-transfer check verifies that *these*
 * records reached the operator's User — not merely that some equal number of
 * rows did. Children (EmailExtraction, Attachment) are omitted deliberately:
 * they cascade from their Email and are covered by `verifyOwnershipConsistent`.
 */
type RemainderSnapshot = {
  eventIds: number[];
  eventUpdateIds: number[];
  emailIds: number[];
};

const snapshotRemainder = async (
  client: Client,
  legacyId: number,
): Promise<RemainderSnapshot> => {
  const idsOf = async (sql: string): Promise<number[]> => {
    const { rows } = await client.query<{ id: number }>(sql, [legacyId]);
    return rows.map((row) => row.id);
  };

  return {
    eventIds: await idsOf(
      `SELECT id FROM "Event" WHERE "userId" = $1 ORDER BY id`,
    ),
    eventUpdateIds: await idsOf(
      `SELECT id FROM "EventUpdate" WHERE "userId" = $1 ORDER BY id`,
    ),
    emailIds: await idsOf(
      `SELECT id FROM "Email" WHERE "userId" = $1 AND "gmailAccountId" IS NULL ORDER BY id`,
    ),
  };
};

// Every record the operator claimed is now owned by the User they named.
const verifyRemainderTransferred = async (
  client: Client,
  snapshot: RemainderSnapshot,
  ownerId: number,
): Promise<void> => {
  const checks: Array<[OwnedTable, number[]]> = [
    ["Event", snapshot.eventIds],
    ["EventUpdate", snapshot.eventUpdateIds],
    ["Email", snapshot.emailIds],
  ];

  const stray: string[] = [];

  for (const [table, ids] of checks) {
    if (ids.length === 0) {
      continue;
    }

    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::bigint AS count
         FROM "${table}"
        WHERE id = ANY($1::int[]) AND "userId" <> $2`,
      [ids, ownerId],
    );

    const count = Number(rows[0]?.count ?? 0);

    if (count > 0) {
      stray.push(`  ${table.padEnd(16)} ${count} of ${ids.length} not owned by user ${ownerId}`);
    }
  }

  if (stray.length > 0) {
    throw new Error(
      `Operator transfer incomplete:\n${stray.join("\n")}\n\n` +
        `Rolled back; nothing was changed.`,
    );
  }
};

const RULE = "-".repeat(64);

// The two halves are reported separately and labelled differently on purpose.
// One is derived from the data and reproducible; the other is a decision a
// person made and the database cannot justify. Presenting them in one
// undifferentiated list would hide which is which.
const reportPlan = (
  assignments: MailboxAssignment[],
  remainder: RemainderPlan,
): void => {
  console.log("Automatic transfer (mailbox-resolved)");
  console.log("");

  if (assignments.length === 0) {
    console.log("  (no mailbox is parked)");
  }

  for (const assignment of assignments) {
    console.log(`  ${assignment.mailbox.email}`);
    console.log(`      -> ${describeUser(assignment.owner)}`);
  }

  console.log("");
  console.log(RULE);
  console.log("");

  if (remainder.type === "none") {
    console.log("Operator transfer");
    console.log("");
    console.log("  (nothing — every parked record has a mailbox)");
    console.log("");
    return;
  }

  if (remainder.type === "undecidable") {
    console.log("Operator transfer");
    console.log("");
    console.log("  REQUIRED — no destination supplied");
    console.log("");
    return;
  }

  const owners = distinctMailboxOwners(assignments);
  const divergent = owners.length > 0 && !owners.some((o) => o.id === remainder.userId);

  console.log("Operator transfer");
  console.log("");
  console.log(`  ${remainder.count} legacy record(s)`);
  console.log(`      -> user ${remainder.userId}`);
  console.log("");
  console.log("  Reason:");
  console.log("      Mailbox ownership unavailable in historical schema.");
  console.log("      Operator explicitly selected destination.");

  if (divergent) {
    // Legitimate — the operator may deliberately place orphaned records with
    // someone who owns no parked mailbox — but unusual enough to state.
    console.log("");
    console.log(
      `      NOTE: user ${remainder.userId} owns none of the parked mailboxes.`,
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

    // Mailboxes carry their own destinations, resolved from the data. `--to`
    // never touches them: it is the operator's destination for the records
    // whose mailbox provenance no longer exists, and nothing else.
    const assignments = assignmentsOf(mappings);
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

      // No contradiction check against the mailbox owners. `--to` is not a
      // competing claim about a mailbox — mailbox-linked records never reach
      // it — so an operator placing orphaned records with someone who owns no
      // parked mailbox is a legitimate decision, not a mistake. It is reported
      // rather than refused.

      if (unreachable === 0) {
        console.log(
          `NOTE: --to ${args.to} was supplied, but every parked record has a mailbox.\n` +
            `      It has no effect and no operator transfer will run.`,
        );
        console.log("");
      }
    }

    const remainder = resolveRemainderOwner(args.to, unreachable);

    reportPlan(assignments, remainder);

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
      remainderOwnerId: remainder.type === "operator" ? remainder.userId : null,
    });

    reportTransfer(outcome, remainder);

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
