import {
  STAGE_BADGE,
  STATUS_TONE,
  confidenceMeta,
  formatDateTime,
  titleCase,
} from "../lib/eventDisplay";

interface Event {
  id: number;
  company: string;
  stage: string;
  date: string;
  venue: string | null;
  confidence: number;
  status: string;
}

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
  const {
    label: confLabel,
    tone: confClass,
    percent: confPercent,
  } = confidenceMeta(event.confidence);

  const badgeClass = STAGE_BADGE[event.stage] ?? "badge-default";
  const statusClass = STATUS_TONE[event.status] ?? "status-default";

  const company = titleCase(event.company);
  const { date, time } = formatDateTime(event.date);

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
        <span className={`event-badge ${badgeClass}`}>{event.stage}</span>
      </header>

      <div className="event-card__body">
        <p className="event-detail">
          <CalendarIcon />
          <span className="event-detail__content">
            <span className="event-detail__primary">{date}</span>
            {time && (
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
              <span className="event-detail__primary">{event.venue}</span>
            ) : (
              <span className="event-detail__placeholder">To be announced</span>
            )}
          </span>
        </p>
      </div>

      <footer className="event-card__footer">
        <span
          className={`event-confidence ${confClass}`}
          title={`AI extraction confidence: ${confPercent}%`}
        >
          <span className="event-confidence__meter" aria-hidden="true">
            <span
              className="event-confidence__fill"
              style={{ width: `${confPercent}%` }}
            />
          </span>
          <span className="event-confidence__text">
            {confLabel} · {confPercent}%
          </span>
        </span>

        <span className={`event-status ${statusClass}`}>
          <span className="event-status__dot" aria-hidden="true" />
          {event.status}
        </span>
      </footer>
    </article>
  );
}
