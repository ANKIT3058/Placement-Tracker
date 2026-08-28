import {
  STAGE_BADGE,
  STATUS_TONE,
  formatDateTime,
  stageLabel,
  statusLabel,
  titleCase,
} from "../lib/eventDisplay";

import type { Event } from "../types/event";

/* NO ICONS ON THIS CARD, deliberately.
   A calendar glyph beside a date, a clock beside a time and a pin
   beside a venue each restate what the value already says, and three of
   them turned two short lines into a column of decorated rows. Removing
   them lets the date itself be the strongest thing under the company
   name — which is what a student scans a list of drives for. The drawer
   still labels every field explicitly for anything ambiguous. */

export default function EventCard({
  event,
  onSelect,
}: {
  event: Event;
  onSelect: () => void;
}) {
  /* NO CONFIDENCE HERE, deliberately.
     `event.confidence` is untouched on the payload and on the type; it
     is simply not something this card says. It measures how sure the
     extractor was, which is a fact about the pipeline rather than about
     the placement drive — and a red "Low · 44%" chip on a real event
     reads as though the EVENT is in doubt. Where it genuinely informs a
     decision it is still shown: EventDetailsDrawer states it in full,
     and ReviewCard puts it beside the fields it justifies. Low
     confidence is also not lost information here, because the
     low-confidence branch of email processing is exactly what routes an
     event to `status: "review"` in the first place. */

  /* Tone still keys off the RAW value — the class maps are the
     backend's vocabulary, and only the visible text is translated. */
  const badgeClass = STAGE_BADGE[event.stage] ?? "badge-default";
  const statusClass = STATUS_TONE[event.status] ?? "status-default";

  const company = titleCase(event.company);
  const { date, time, hasTime } = formatDateTime(
    event.date,
    event.time,
    event.isTimeEstimated,
  );

  return (
    /* role="button" rather than a real <button>: the card holds a heading
       and structured rows that a button would flatten. aria-label gives it
       a clean name instead of the whole card's text. */
    <article
      className="card event-card"
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label={`View details for ${company}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <header className="event-card__header">
        <h3 className="event-card__company" title={company}>
          {company}
        </h3>
        <span className={`event-badge ${badgeClass}`}>
          {stageLabel(event.stage)}
        </span>
      </header>

      <div className="event-card__body">
        {/* WHEN, as one phrase. Date and time were two stacked rows with
            an icon each, which split a single fact — "Sep 4, 10:00 AM" —
            across two lines and two glyphs. Read together they are one
            scannable line and the card's real anchor.

            The behaviour either side of it is unchanged: an unknown time
            still omits the separator and the value entirely rather than
            spending words on "Not specified" (the drawer states that
            explicitly), and an inferred time still arrives from
            `formatDateTime` carrying its own "(estimated)". */}
        <p className="event-when">
          <span className="event-when__date">{date}</span>
          {hasTime && (
            <>
              <span className="event-when__separator" aria-hidden="true">
                ·
              </span>
              <span className="event-when__time">{time}</span>
            </>
          )}
        </p>

        {/* WHERE, one step quieter than when. */}
        <p className="event-where">
          {event.venue ? (
            event.venue
          ) : (
            <span className="event-where__placeholder">To be announced</span>
          )}
        </p>
      </div>

      {/* Status alone, and no longer behind a rule: one small chip did
          not need a horizontal border to announce it. `margin-top: auto`
          still pins it, so footers line up across a grid row whatever
          the cards above them are doing. */}
      <footer className="event-card__footer">
        <span className={`event-status ${statusClass}`}>
          <span className="event-status__dot" aria-hidden="true" />
          {statusLabel(event.status)}
        </span>
      </footer>
    </article>
  );
}
