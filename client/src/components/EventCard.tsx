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

function titleCase(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  const date = d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  if (!hasTime) return date;
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${date} • ${time}`;
}

export default function EventCard({ event }: { event: Event }) {
  const { confidence } = event;

  const confLabel =
    confidence > 0.8 ? "High" : confidence > 0.5 ? "Medium" : "Low";
  const confClass =
    confidence > 0.8 ? "conf-high" : confidence > 0.5 ? "conf-medium" : "conf-low";

  const badgeClass = STAGE_BADGE[event.stage] ?? "badge-default";

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-company">{titleCase(event.company)}</h3>
        <span className={`badge ${badgeClass}`}>{event.stage}</span>
      </div>

      <div className="card-body">
        <p className="card-meta">
          <span>📅</span>
          {formatDateTime(event.date)}
        </p>
        <p className="card-meta">
          <span>📍</span>
          {event.venue ?? "To be announced"}
        </p>
      </div>

      <div className="card-footer">
        <span className={`confidence-pill ${confClass}`}>
          {confLabel} · {(confidence * 100).toFixed(0)}%
        </span>
        <span className="card-status">{event.status}</span>
      </div>
    </div>
  );
}
