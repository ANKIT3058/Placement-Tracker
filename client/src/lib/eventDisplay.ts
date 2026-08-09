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

/* "15:00" → "3:00 PM".

   Parsed as text rather than through a Date, so no timezone conversion
   can reach it. Anything that isn't "HH:MM" passes through unchanged —
   showing the raw stored value beats rendering "Invalid Date". */
function formatClockTime(time: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return time;

  const hours = Number(match[1]);
  if (hours > 23) return time;

  const period = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  return `${hour12}:${match[2]} ${period}`;
}

/* Formats an event's date and time for display.

   The date column holds a calendar date persisted as UTC midnight, so it
   is formatted with `timeZone: "UTC"`. Reading it in the viewer's zone —
   which is what this function used to do — rolls the day backwards for
   anyone west of UTC and, worse, makes the midnight look like a real
   clock time (05:30 in IST).

   The time comes from the event's own `time` column. `hasTime` lets a
   caller decide whether to render the "Not specified" text or omit the
   row entirely, without re-deriving that from the string. */
export function formatDateTime(
  dateStr: string,
  time: string | null,
  isTimeEstimated: boolean,
): { date: string; time: string; hasTime: boolean } {
  const date = new Date(dateStr).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

  if (!time) {
    return { date, time: "Not specified", hasTime: false };
  }

  const formatted = formatClockTime(time);

  return {
    date,
    time: isTimeEstimated ? `${formatted} (estimated)` : formatted,
    hasTime: true,
  };
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
