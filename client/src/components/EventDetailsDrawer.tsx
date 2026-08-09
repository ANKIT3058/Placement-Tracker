import { useEffect, useRef } from "react";
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

function CloseIcon() {
  return (
    <svg
      className="btn-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/* Read-only detail view for a single event.
   Built on the native <dialog> with showModal(), which gives Escape
   handling, a focus trap, background inertness and focus restoration to
   the card that opened it — all of which would otherwise be hand-rolled
   effects and keydown listeners. */
export default function EventDetailsDrawer({
  event,
  onClose,
}: {
  event: Event;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const company = titleCase(event.company);
  const { date, time } = formatDateTime(event.date);
  const {
    label: confLabel,
    tone: confTone,
    percent: confPercent,
  } = confidenceMeta(event.confidence);
  const badgeClass = STAGE_BADGE[event.stage] ?? "badge-default";
  const statusClass = STATUS_TONE[event.status] ?? "status-default";

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby="drawer-title"
      /* `close` fires for the button, Escape and the backdrop alike, so
         unmounting is driven from one place. */
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <div className="drawer__panel">
        <header className="drawer__header">
          <div>
            <p className="drawer__eyebrow">Event details</p>
            <h2 className="drawer__title" id="drawer-title">
              {company}
            </h2>
          </div>
          <button
            type="button"
            className="drawer__close"
            onClick={() => ref.current?.close()}
            aria-label="Close event details"
          >
            <CloseIcon />
          </button>
        </header>

        <dl className="drawer__list">
          <div className="drawer__row">
            <dt className="drawer__label">Stage</dt>
            <dd className="drawer__value">
              <span className={`event-badge ${badgeClass}`}>{event.stage}</span>
            </dd>
          </div>

          <div className="drawer__row">
            <dt className="drawer__label">Date</dt>
            <dd className="drawer__value">{date}</dd>
          </div>

          <div className="drawer__row">
            <dt className="drawer__label">Time</dt>
            <dd className="drawer__value">
              {time ?? <span className="drawer__muted">Not specified</span>}
            </dd>
          </div>

          <div className="drawer__row">
            <dt className="drawer__label">Venue</dt>
            <dd className="drawer__value">
              {event.venue ?? (
                <span className="drawer__muted">To be announced</span>
              )}
            </dd>
          </div>

          <div className="drawer__row">
            <dt className="drawer__label">Status</dt>
            <dd className="drawer__value">
              <span className={`event-status ${statusClass}`}>
                <span className="event-status__dot" aria-hidden="true" />
                {event.status}
              </span>
            </dd>
          </div>

          <div className="drawer__row">
            <dt className="drawer__label">Confidence</dt>
            <dd className={`drawer__value ${confTone}`}>
              <span className="drawer__meter" aria-hidden="true">
                <span
                  className="drawer__meter-fill"
                  style={{ width: `${confPercent}%` }}
                />
              </span>
              <span className="drawer__conf-text">
                {confLabel} · {confPercent}%
              </span>
            </dd>
          </div>
        </dl>

        <p className="drawer__note">
          Details are read-only. Events needing correction appear in the
          Needs Review section.
        </p>
      </div>
    </dialog>
  );
}
