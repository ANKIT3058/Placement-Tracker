import type { VenueMeta } from "../email/email.parser.js";

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
