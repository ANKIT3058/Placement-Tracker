export const CONFIDENCE_THRESHOLD = 0.6;

// Maximum distance, in days, over which the loose (weakest) recognition tier may
// treat a sole company+stage candidate as the same real-world event.
//
// That tier infers identity from uniqueness alone, and uniqueness is only
// meaningful inside a plausible range: over unbounded time a company's first
// round of a given type is trivially unique, so the tier fired most confidently
// where it had least evidence and merged rounds months apart into a single
// "reschedule" (AC-1 / D-2).
//
// 30 days is wider than the soft tier's ±3-day window — so the loose tier keeps
// its purpose of catching reschedules that moved further than soft matching
// allows — while excluding the cross-cycle collisions that produced false
// merges. Candidates outside the window yield no match, which creates a
// duplicate rather than corrupting an existing event: the recoverable failure.
export const LOOSE_MATCH_WINDOW_DAYS = 30;

// How often the background Gmail scheduler triggers a sync of all accounts.
export const GMAIL_SYNC_INTERVAL_MS =
  Number(process.env.GMAIL_SYNC_INTERVAL_MS) || 120000;

// Reads a millisecond duration from the environment, falling back whenever the
// value is not a finite positive number.
//
// `Number(raw) || fallback` is the shorter idiom and it is not sufficient here.
// Both `-1` and `Infinity` are truthy, so they survive it and reach
// `AbortSignal.timeout()`, which rejects them with a RangeError BEFORE the
// request is dispatched — turning one mistyped variable into an immediate,
// total failure of every Gmail request rather than a merely slower one.
//
// Invalid input falls back to the default rather than being clamped into range.
// A clamp would silently honour a value the operator plainly did not mean; the
// default is the documented, working behaviour and is the safer thing to
// resume. `0` counts as invalid: it reads as "no timeout", which is the exact
// condition this constant exists to remove.
const positiveMillis = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// The same contract as `positiveMillis` for a COUNT rather than a duration:
// invalid input falls back rather than being clamped, and `0` is invalid
// because it reads as "no work", which is never a value an operator means.
//
// Separate from `positiveMillis` rather than a reuse of it, because a count
// must additionally be a whole number: a fractional `take` reaches Prisma and
// fails the query at run time, turning one mistyped variable into a sweep that
// can never run.
const positiveCount = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Deadline for a single outbound Gmail or Google OAuth HTTP request.
//
// Without one there is none: gaxios attaches a bound only when `opts.timeout`
// is supplied, and neither googleapis nor google-auth-library supplies it. An
// unanswered request then waits forever, and because the scheduler awaits each
// account in sequence and clears `isRunning` only in a `finally`, one stalled
// socket stops Gmail sync for EVERY user until the process restarts.
//
// PER ATTEMPT, not per operation. gaxios re-arms the timeout on each retry and
// caps retries independently (2 for a no-response failure), so the worst case
// for one HTTP operation is roughly three attempts plus ~0.6s of backoff —
// about 30s here. That is comfortably inside the 120s sync interval, so a
// stalled mailbox is detected and the cycle finishes within one period.
//
// 10s is far above real Gmail latency (sub-second in normal operation), so this
// only ever fires on a genuine stall, never on a slow-but-working request.
export const GMAIL_REQUEST_TIMEOUT_MS = positiveMillis(
  process.env.GMAIL_REQUEST_TIMEOUT_MS,
  10000,
);

// How often the email reconciler sweeps for Emails that were persisted but
// never handed to the queue (F-3e).
//
// Its own interval, and its own scheduler, deliberately. Reconciliation exists
// to recover from the moment ingestion fails, so tying it to the Gmail
// scheduler would make recovery depend on the component most likely to be
// unhealthy at the time.
//
// 60s: an orphan is invisible until the sweep finds it, and the sweep is one
// indexed-ish query that usually returns nothing, so running it more often than
// the Gmail cycle costs little and shortens the window in which a lost email
// goes unnoticed.
export const EMAIL_RECONCILE_INTERVAL_MS = positiveMillis(
  process.env.EMAIL_RECONCILE_INTERVAL_MS,
  60000,
);

// How long an Email may sit `pending` before the reconciler treats it as never
// having been queued.
//
// A row stays `pending` until a worker picks it up, so a legitimately queued
// email is indistinguishable from an orphan until this much time has passed.
// The email worker runs at BullMQ's default concurrency of 1, and a Gmail cycle
// can enqueue up to a page of messages per mailbox, so a healthy backlog can
// take minutes to drain — the cutoff has to clear that or the sweep would chase
// work already in flight.
//
// 5 minutes is comfortably past normal drain time while still well inside the
// window where a lost placement email matters. Getting it wrong is cheap in one
// direction only, and it is the safe one: every enqueue carries
// `jobId: email-${id}`, so re-enqueueing a row that already has a job collapses
// into the existing job rather than duplicating it. Too short wastes a little
// Redis traffic; too long delays recovery.
export const EMAIL_RECONCILE_MIN_AGE_MS = positiveMillis(
  process.env.EMAIL_RECONCILE_MIN_AGE_MS,
  300000,
);

// How often the attachment reconciler sweeps for attachments whose durable
// state says the pipeline is unfinished but which no BullMQ job represents
// (G-7.3).
//
// Its own interval and its own scheduler, for the same reason the email
// reconciler has its own: recovery must not be coupled to the component whose
// failure creates the work it recovers.
//
// 60s, matching EMAIL_RECONCILE_INTERVAL_MS. The sweep is one bounded query
// that usually returns nothing to act on, so running it often costs little and
// shortens the window in which stranded attachment work goes unnoticed.
export const ATTACHMENT_RECONCILE_INTERVAL_MS = positiveMillis(
  process.env.ATTACHMENT_RECONCILE_INTERVAL_MS,
  60000,
);

// How long an attachment may look unfinished before the reconciler treats it as
// stranded.
//
// DELIBERATELY LONGER THAN THE EMAIL EQUIVALENT (5 minutes), and the difference
// is not arbitrary. An email job is a regex extraction; an attachment job is a
// Gmail download followed by a full PDF or spreadsheet parse, at BullMQ's
// default concurrency of 1. The cutoff has to clear a realistic drain of that
// work, or the sweep would chase jobs that are simply still running.
//
// Getting it wrong is cheap in one direction only, and it is the safe one:
// every enqueue carries `jobId: attachment-${id}`, so re-enqueueing a row that
// still has a job collapses into that job instead of duplicating it. Too short
// wastes a little Redis traffic; too long delays recovery.
export const ATTACHMENT_RECONCILE_MIN_AGE_MS = positiveMillis(
  process.env.ATTACHMENT_RECONCILE_MIN_AGE_MS,
  900000,
);

// How many stale attachments one sweep may enqueue.
//
// NO EMAIL EQUIVALENT EXISTS, and that asymmetry is the point. An orphaned
// email requires a failed enqueue to exist at all, so that sweep normally finds
// nothing. Attachment jobs currently have no production consumer, so
// `attachment-processing` holds a standing backlog of legitimately queued work
// — every row of which the recovery predicate deliberately over-selects (the
// deterministic job id, not the query, is what makes that safe). Unbounded, a
// sweep would attempt one Redis round trip per backlogged row every interval.
//
// The bound costs nothing in correctness: rows beyond it stay eligible and are
// picked up by the next sweep, because the reconciler never marks anything
// done.
export const ATTACHMENT_RECONCILE_BATCH_SIZE = positiveCount(
  process.env.ATTACHMENT_RECONCILE_BATCH_SIZE,
  100,
);
