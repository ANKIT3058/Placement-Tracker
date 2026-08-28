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

/* A token carrying a dot with characters on BOTH sides — `naukri.com`,
   `d.e.shaw`. A trailing dot does not match, which is what keeps the
   abbreviation in "pvt. ltd" out of this branch. */
const HAS_INTERNAL_DOT = /[a-z0-9]\.[a-z0-9]/i;

/* How short an all-lowercase single-token name has to be before it is
   read as an initialism rather than a word. `ti` and `tpo` are the two
   in the data; `cowi` and `acies` are four and five, and there is no
   rule that separates the first from the second, so the threshold stops
   at three. Widening it would start shouting real words. */
const INITIALISM_MAX_LENGTH = 3;

/* How a company is shown, given that the database now stores it
   canonically — lower case, whitespace collapsed, no trailing period.
   That canonicalisation moved the casing decision here: this function is
   now the only thing standing between `american express` in a column and
   what a student reads on a card.

   The rule it replaces was `str.replace(/\b\w/g, upper)`, which
   capitalises after EVERY word boundary — including the one a dot
   creates. So `naukri.com` was rendered `Naukri.Com`, and `ti` became
   `Ti` rather than `TI`.

   Three rules, applied per whitespace-separated token so that one odd
   token cannot change how the rest of the name is treated:

     1. A token containing an internal dot is left exactly as stored.
        Domains are written lower case and any capitalisation of them is
        wrong; `d.e.shaw` is left alone for the same reason, which is
        conservative rather than ideal.
     2. A short all-lowercase name that is the WHOLE company is an
        initialism: `ti` → `TI`. Restricted to single-token values so
        that `bank of america` cannot become `Bank OF America`.
     3. Everything else: capitalise the first letter, leave the rest of
        the token untouched. `pvt.` → `Pvt.`, and an already-capitalised
        `Amazon India` survives unchanged. */
export function titleCase(str: string): string {
  /* Split on the separators themselves so runs of whitespace survive
     the round trip; the value should already be canonical, but this
     formats what it is given rather than quietly normalising it. */
  const parts = str.split(/(\s+)/);
  const tokens = parts.filter((part) => part.trim() !== "");

  if (
    tokens.length === 1 &&
    tokens[0]!.length <= INITIALISM_MAX_LENGTH &&
    /^[a-z]+$/.test(tokens[0]!)
  ) {
    return str.toUpperCase();
  }

  return parts
    .map((part) =>
      HAS_INTERNAL_DOT.test(part)
        ? part
        : part.replace(/[a-z]/i, (c) => c.toUpperCase()),
    )
    .join("");
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
