import { useState } from "react";
import { updateEvent } from "../api/eventApi";

interface ReviewEvent {
  id: number;
  company: string;
  stage: string;
  /* Already present on the event payload the Dashboard passes down;
     surfaced here so the reviewer can see how unsure the extraction was. */
  confidence?: number;
  /* Nullable, not merely optional: the column is `String?`, so the API
     sends an explicit null. The truthy check at the render site already
     handled it — only the type was wrong. */
  reviewReason?: string | null;
}

/* Inline icons — no icon dependency, and they inherit `currentColor`
   so they follow the light/dark theme automatically. */
const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function AlertIcon() {
  return (
    <svg {...iconProps} className="review-badge__icon">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...iconProps} className="btn-icon">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export default function ReviewCard({
  event,
  refresh,
}: {
  event: ReviewEvent;
  refresh: () => void;
}) {
  const [company, setCompany] = useState(event.company);
  const [stage, setStage] = useState(event.stage);
  const [saving, setSaving] = useState(false);

  const handleConfirm = async () => {
    setSaving(true);
    try {
      /* Only the two fields the reviewer actually edits. Confirming an
         Event also sets confidence to 1.0, status to "confirmed" and
         clears reviewReason — but the server does that itself on this
         request, and its allowlist rejects a payload that so much as
         names those fields. Sending them was always redundant; since
         they became a 400, it was also the reason Confirm & Save
         silently stopped working. */
      await updateEvent(event.id, { company, stage });
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const { confidence } = event;
  const hasConfidence = typeof confidence === "number";
  const confLabel =
    !hasConfidence ? "" : confidence > 0.8 ? "High" : confidence > 0.5 ? "Medium" : "Low";
  const confClass =
    !hasConfidence ? "" : confidence > 0.8 ? "conf-high" : confidence > 0.5 ? "conf-medium" : "conf-low";
  const confPercent = hasConfidence ? Number((confidence * 100).toFixed(0)) : 0;

  return (
    <article className="card card-review">
      <header className="review-header">
        <span className="review-badge">
          <AlertIcon />
          Needs Review
        </span>

        {hasConfidence && (
          <span
            className={`review-confidence ${confClass}`}
            title={`AI extraction confidence: ${confPercent}%`}
          >
            <span className="review-confidence__meter" aria-hidden="true">
              <span
                className="review-confidence__fill"
                style={{ width: `${confPercent}%` }}
              />
            </span>
            <span className="review-confidence__text">
              {confLabel} · {confPercent}%
            </span>
          </span>
        )}
      </header>

      {event.reviewReason && (
        <p className="review-reason">{event.reviewReason}</p>
      )}

      <div className="review-fields">
        <label className="field-label">
          Company
          <input
            className="field-input"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            disabled={saving}
          />
        </label>
        <label className="field-label">
          Stage
          <input
            className="field-input"
            value={stage}
            onChange={(e) => setStage(e.target.value)}
            disabled={saving}
          />
        </label>
      </div>

      <div className="review-actions">
        <button
          className="btn btn-confirm"
          onClick={handleConfirm}
          disabled={saving}
          aria-busy={saving}
        >
          {saving ? (
            <>
              <span className="btn-spinner" aria-hidden="true" />
              Saving…
            </>
          ) : (
            <>
              <CheckIcon />
              Confirm &amp; Save
            </>
          )}
        </button>
        <p className="review-hint">
          Confirming moves this event to Upcoming Events.
        </p>
      </div>
    </article>
  );
}
