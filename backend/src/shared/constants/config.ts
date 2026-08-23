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