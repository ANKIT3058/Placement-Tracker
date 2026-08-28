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
   status never breaks a card.

   `rescheduled` is mapped here because it was reaching that neutral
   fallback — which made a known, meaningful state look exactly like a
   value the frontend had never heard of, and left grey meaning two
   different things at once. It borrows the `scheduled` tone rather than
   getting one of its own: a rescheduled drive IS scheduled, only moved,
   and nothing is being asked of the student. Amber would say otherwise.
   The word carries the difference; the tone carries the family. */
export const STATUS_TONE: Record<string, string> = {
  confirmed: "status-confirmed",
  scheduled: "status-scheduled",
  rescheduled: "status-scheduled",
  review: "status-review",
};

/* ── User-facing wording ────────────────────────────────────────────
   The API sends lifecycle and stage values in the vocabulary the
   backend reasons in. Those are storage values, not sentences, and two
   of them are actively wrong to show a student: `review` names an
   internal queue, and `unknown` is the literal sentinel
   `extractStage` returns when it could not read a round from an email.

   Translation happens HERE rather than in a component, so EventCard and
   EventDetailsDrawer cannot drift into wording the other does not use,
   and so the raw value keeps flowing untouched through filtering,
   sorting and the PATCH contract. Nothing below is ever sent back to
   the server. */

/* Anything not in a map above still has to read like a word.

   Separators become spaces and the first letter is raised; the REST OF
   THE STRING IS LEFT ALONE, deliberately. Lower-casing the remainder
   would turn a future `OA_PENDING` into `Oa pending`, and this function
   exists precisely for values nobody has seen yet. Same restraint as
   `titleCase`'s third rule. */
const humanise = (raw: string): string => {
  const words = raw.replace(/[_-]+/g, " ").trim().replace(/\s+/g, " ");

  /* A blank value must never reach the screen as a blank chip. A chip
     with no text is indistinguishable from a rendering bug, and it
     leaves a screen reader announcing nothing at all. */
  if (words === "") {
    return "Unknown";
  }

  return words.charAt(0).toUpperCase() + words.slice(1);
};

/* The lifecycle values this backend actually writes, and what each one
   says to a student.

   Exactly four, because exactly four are reachable: `scheduled` is the
   column default, `rescheduled` comes from the automated update path,
   `confirmed` from a human confirmation, and `review` from the
   low-confidence branch of email processing. Values the system does not
   produce — `cancelled` among them — are deliberately NOT pre-mapped:
   inventing a label for a state that cannot occur would be guessing at
   wording for a feature that does not exist, and `humanise` already
   renders any newcomer safely ("Cancelled", as it happens).

   `review` is the one real translation. It is a queue name on the
   server; to the person reading it, it is the reason this event is
   waiting. */
const STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  rescheduled: "Rescheduled",
  review: "Needs review",
};

/* How a lifecycle status reads on screen.

   The CSS used to do this with `text-transform: capitalize`, which can
   only ever change letter case — it cannot turn `review` into "Needs
   review", it leaves the DOM text lower case for anyone reading the
   accessibility tree, and on a hyphenated future value it capitalises
   only the first word. The mapping replaced it; the transform is gone. */
export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? humanise(status);
}

/* The sentinel `extractStage` returns when no round could be read from
   an email. It is a real, stored `Event.stage` value — not a null — so
   it reaches the badge like any other stage. */
const UNRESOLVED_STAGE = "unknown";

/* How a stage reads on the badge.

   PASS-THROUGH BY DEFAULT, and that is the point: stages are free text
   (the extractor emits four canonical ones, and ReviewCard lets a human
   retype the field freehand), so this must not become a dictionary that
   silently drops any round it has not been taught. The badge's CSS
   already uppercases, which settles casing without a rule here.

   The one substitution is the sentinel. `UNKNOWN` shouted in a badge
   reads as a failure the student caused; "Other" says the same thing —
   we have no round for this — without blaming anyone or exposing the
   extractor's vocabulary. A blank stage lands here too.

   The RAW value is what filtering still matches on: `STAGE_FILTERS` in
   Dashboard tests `event.stage`, never this. */
export function stageLabel(stage: string): string {
  const trimmed = stage.trim();

  return trimmed === "" || trimmed.toLowerCase() === UNRESOLVED_STAGE
    ? "Other"
    : stage;
}

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
