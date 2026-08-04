// Mailbox → owner resolution.
//
// Answers one question: given a parked mailbox and the Users who have
// authenticated, which of them owns it? Nothing else. The claim script asks and
// acts on the answer; it does not know how the answer is reached.
//
// That separation is the point. Today ownership is resolved by normalized email
// matching, because Google is the only provider and `User.email` is the only
// address this system records against an identity. That is a property of the
// current identity model, not of the migration, and it is expected to change —
// additional providers, matching on the immutable Google subject instead of the
// mutable address, a dedicated AuthIdentity table, account merges. Every one of
// those replaces the body of `resolveMailboxOwner` and touches no caller.
//
// The contract that makes this substitutable is the return type: three
// outcomes, one of which is "I could not decide". A resolver that returned
// `CandidateUser | null` would collapse "nobody" and "several" into one answer
// and force the caller to re-derive the difference — which is exactly the
// knowledge this module exists to hold.

/**
 * A User who might own a parked mailbox.
 *
 * `googleSub` is carried even though the current strategy does not read it: it
 * is the immutable identifier a provider-based strategy would match on
 * (RFC-001 §8.1), and having it here means such a strategy needs no change to
 * the caller or to the query that populates this.
 */
export type CandidateUser = {
  id: number;
  publicId: string;
  googleSub: string;
  email: string;
  status: string;
  deletedAt: Date | null;
};

/** The mailbox being resolved. Only what resolution needs, never the whole row. */
export type MailboxRef = {
  id: number;
  email: string;
};

/**
 * The outcome of resolving one mailbox.
 *
 * `ambiguous` and `unmapped` are distinct because they demand different fixes:
 * ambiguity is resolved by deciding between real people, absence by somebody
 * signing in. Collapsing them would make the caller's diagnostics guess.
 *
 * `unmapped.ineligible` carries matches that were rejected for being disabled
 * or deleted, which turns "maps to nobody" into "maps to someone who cannot
 * receive it" — again, a different fix.
 */
export type MailboxOwnerResolution =
  | { type: "mapped"; user: CandidateUser }
  | { type: "ambiguous"; users: CandidateUser[] }
  | { type: "unmapped"; ineligible: CandidateUser[] };

// Case-insensitive, but nothing more. Gmail's own canonicalisation (ignoring
// dots, truncating at "+") is deliberately NOT applied: it would make
// `a.b@gmail.com` and `ab@gmail.com` the same mailbox, and being wrong about
// that assigns one person's mail history to another.
const normalizeEmail = (value: string): string => value.trim().toLowerCase();

/**
 * May this User receive ownership of data?
 *
 * Exported because it is an ownership rule, not a resolution detail: callers
 * that ask "is there anyone at all who could own this?" have to apply the same
 * test, and a second copy of it would eventually disagree with this one.
 */
export const isEligibleOwner = (user: CandidateUser): boolean =>
  user.status === "active" && user.deletedAt === null;

/**
 * Resolve the owner of one mailbox.
 *
 * Pure and deterministic: no I/O, no logging, no mutation of its arguments. The
 * order of `users` and `ineligible` follows the order of `candidates`, so the
 * same inputs always produce the same output — including the order of the
 * diagnostics a caller renders from it.
 *
 * Current strategy: match the mailbox address against `User.email`,
 * case-insensitively, then keep only eligible owners. `User.email` is
 * deliberately not unique (RFC-001 §8.1 — identity is keyed on the immutable
 * `googleSub`, while an address is mutable and reassignable), so several rows
 * can legitimately carry one address. That is why more than one match resolves
 * to `ambiguous` rather than to whichever sorted first.
 */
export const resolveMailboxOwner = (
  mailbox: MailboxRef,
  candidates: readonly CandidateUser[],
): MailboxOwnerResolution => {
  const matches = candidates.filter(
    (user) => normalizeEmail(user.email) === normalizeEmail(mailbox.email),
  );

  const eligible = matches.filter(isEligibleOwner);

  if (eligible.length === 1) {
    return { type: "mapped", user: eligible[0]! };
  }

  if (eligible.length > 1) {
    return { type: "ambiguous", users: eligible };
  }

  return { type: "unmapped", ineligible: matches };
};
