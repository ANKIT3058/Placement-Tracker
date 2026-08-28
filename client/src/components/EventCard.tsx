import {
  STAGE_BADGE,
  STATUS_TONE,
  formatDateTime,
  stageLabel,
  statusLabel,
  titleCase,
} from "../lib/eventDisplay";

import type { Event } from "../types/event";

/* Inline icons — no icon dependency, and they inherit `currentColor`
   so they follow the light/dark theme automatically. */
const iconProps = {
  className: "event-detail__icon",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function CalendarIcon() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg {...iconProps} className="event-detail__icon event-detail__icon--sm">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function VenueIcon() {
  return (
    <svg {...iconProps}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

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
        <p className="event-detail">
          <CalendarIcon />
          <span className="event-detail__content">
            <span className="event-detail__primary">{date}</span>
            {/* Unchanged behaviour: the compact card omits the row when no
                time is known rather than spending a line on "Not specified".
                The drawer states it explicitly. */}
            {hasTime && (
              <span className="event-detail__secondary">
                <ClockIcon />
                {time}
              </span>
            )}
          </span>
        </p>

        <p className="event-detail">
          <VenueIcon />
          <span className="event-detail__content">
            {event.venue ? (
              /* One weight below the date above it. Both rows were 600,
                 which made "where" compete with "when" — and when is
                 the thing a student scans a card for. Same size, same
                 colour, so the venue stays fully readable. */
              <span className="event-detail__primary event-detail__primary--venue">
                {event.venue}
              </span>
            ) : (
              <span className="event-detail__placeholder">To be announced</span>
            )}
          </span>
        </p>
      </div>

      {/* The footer is now the status alone. It keeps its rule and its
          `margin-top: auto` so footers still line up across a grid row
          whether or not the cards above them are the same height. */}
      <footer className="event-card__footer">
        <span className={`event-status ${statusClass}`}>
          <span className="event-status__dot" aria-hidden="true" />
          {statusLabel(event.status)}
        </span>
      </footer>
    </article>
  );
}
