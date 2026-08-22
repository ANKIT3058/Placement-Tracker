import type { VenueMeta } from "../email/email.parser.js";

// Where an Event sits relative to now.
//
// DERIVED, never persisted. It is a pure function of `date`, `time`,
// `isTimeEstimated` and the current instant, so there is no column to keep in
// step with the clock and no job to age rows out — an Event crosses from
// upcoming to expired without anything being written.
//
// Orthogonal to `status`, which records lifecycle (review / confirmed /
// rescheduled). A confirmed Event can be either temporal category.
export const TEMPORAL_STATUS = {
  UPCOMING: "upcoming",
  EXPIRED: "expired",
} as const;

export type TemporalStatus =
  (typeof TEMPORAL_STATUS)[keyof typeof TEMPORAL_STATUS];

// THE MANUAL REVIEW CONTRACT.
//
// The two fields the review UI lets a human correct (`ReviewCard.tsx`), and the
// only two `PATCH /event/:id` accepts. Everything else about an Event belongs to
// the server: ownership, identity, provenance timestamps, and the confirmation
// semantics themselves.
//
// Declared as its own type rather than `Partial<Event>` so that the accepted
// surface is a deliberate statement here, not a shadow of the schema. Under
// `Partial<Event>` every column added to the model would silently become
// client-writable — which is exactly how `userId` became writable.
export interface ManualEventUpdate {
  company?: string;
  stage?: string;
}

// The runtime half of the same statement, kept beside the type so the two
// cannot drift. Validation is an allowlist rather than a denylist of known-bad
// fields: a denylist protects only the fields someone thought to name, and
// leaves every future column exposed by default.
export const MANUAL_EVENT_UPDATE_FIELDS = ["company", "stage"] as const;

export interface CreateEventInput {
  company: string;
  stage: string;
  date: string; // will convert to Date later
  time?: string | null;
  venue?: string | null;
  venueMeta?: VenueMeta; // carries isExplicit; used by update logic to differentiate "no mention" vs "explicit null"
  confidence?: number;
  status?: "scheduled" | "rescheduled" | "review";
  reviewReason?: string;
}
