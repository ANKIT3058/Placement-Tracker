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