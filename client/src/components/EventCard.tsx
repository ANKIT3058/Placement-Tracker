interface Event {
  id: number;
  company: string;
  stage: string;
  date: string;
  venue: string | null;
  confidence: number;
  status: string;
}

const STAGE_BADGE: Record<string, string> = {
  OA: "badge-oa",
  "Online Assessment": "badge-oa",
  Interview: "badge-interview",
  "Tech Interview": "badge-interview",
  "HR Interview": "badge-interview",
  PPT: "badge-ppt",
  "Pre-Placement Talk": "badge-ppt",
};

/* Presentation-only tone for the status chip. Unknown values fall back
   to the neutral tone, so a new backend status never breaks the card. */
const STATUS_TONE: Record<string, string> = {
  confirmed: "status-confirmed",
  scheduled: "status-scheduled",
  review: "status-review",
};

function titleCase(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

/* Date and time are returned separately so the card can present the date
   as the primary line and the time as a secondary one. `time` is null for
   midnight timestamps, i.e. dates the email carried without a clock time. */
function formatDateTime(dateStr: string): { date: string; time: string | null } {
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

export default function EventCard({ event }: { event: Event }) {
  const { confidence } = event;

  const confLabel =
    confidence > 0.8 ? "High" : confidence > 0.5 ? "Medium" : "Low";
  const confClass =
    confidence > 0.8 ? "conf-high" : confidence > 0.5 ? "conf-medium" : "conf-low";
  const confPercent = Number((confidence * 100).toFixed(0));

  const badgeClass = STAGE_BADGE[event.stage] ?? "badge-default";
  const statusClass = STATUS_TONE[event.status] ?? "status-default";

  const company = titleCase(event.company);
  const { date, time } = formatDateTime(event.date);

  return (
    <article className="card event-card">
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
