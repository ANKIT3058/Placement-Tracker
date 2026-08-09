/* Presentation helpers shared by EventCard and EventDetailsDrawer.
   Moved out of EventCard so the two render the same company casing,
   date format and tone classes without a second copy drifting.
   Pure formatting only — no fetching, no business rules. */

export const STAGE_BADGE: Record<string, string> = {
  OA: "badge-oa",
  "Online Assessment": "badge-oa",
  Interview: "badge-interview",
  "Tech Interview": "badge-interview",
  "HR Interview": "badge-interview",
  PPT: "badge-ppt",
  "Pre-Placement Talk": "badge-ppt",
};

/* Unknown values fall back to the neutral tone, so a new backend
   status never breaks a card. */
export const STATUS_TONE: Record<string, string> = {
  confirmed: "status-confirmed",
  scheduled: "status-scheduled",
  review: "status-review",
};

export function titleCase(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

/* Date and time are returned separately so a caller can present the date
   as the primary line and the time as a secondary one. `time` is null for
   midnight timestamps, i.e. dates the email carried without a clock time. */
export function formatDateTime(dateStr: string): {
  date: string;
  time: string | null;
} {
  const d = new Date(dateStr);
  const date = d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  if (!hasTime) return { date, time: null };
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return { date, time };
}

export function confidenceMeta(confidence: number) {
  return {
    label: confidence > 0.8 ? "High" : confidence > 0.5 ? "Medium" : "Low",
    tone:
      confidence > 0.8
        ? "conf-high"
        : confidence > 0.5
          ? "conf-medium"
          : "conf-low",
    percent: Number((confidence * 100).toFixed(0)),
  };
}
