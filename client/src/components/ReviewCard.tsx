import { useState } from "react";
import { updateEvent } from "../api/eventApi";
import { ApiError } from "../api/http";

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

/* What to tell the reviewer when a confirmation is refused.
 *
 * The 400 case is the one that carries real information: the Event PATCH
 * allowlist answers with a message naming exactly which fields were refused and
 * which are editable, and nothing here could reconstruct that from the status
 * alone. It is shown verbatim — paraphrasing it would discard the field names,
 * which are the only part anyone can act on.
 *
 * 401, 500 and connectivity get wording rather than the raw message, matching
 * EmailInput: those defaults ("Request failed with status 500") describe the
 * transport, not the problem. Wording is kept in step with EmailInput by hand;
 * a third consumer of this shape would be the point at which extracting it
 * earns its keep. */
const messageForError = (error: unknown): string => {
  const status =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown }).status
      : undefined;

  if (typeof status !== "number") {
    return "Could not reach the server. Check your connection and try again.";
  }

  if (status === 401) {
    return "Your session has expired. Please sign in again.";
  }

  if (status === 400) {
    /* Only a message the SERVER wrote is worth showing. `ApiError` fills in
       "Request failed with status 400" when the body carried none, which
       describes the transport rather than the problem — compared against the
       class's own default so this stays correct if that wording changes. */
    const hasServerMessage =
      error instanceof ApiError && error.message !== new ApiError(400).message;

    return hasServerMessage
      ? (error as ApiError).message
      : "That change could not be saved. Check the fields and try again.";
  }

  return "The server could not save your changes. Please try again.";
};

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
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    /* The button is `disabled` in flight, so a second click cannot reach
       this — but the guard is what the two sibling handlers in this app
       (Dashboard's logout, StudentProfileSection's submit) already use,
       and it holds even if this is ever invoked without going through
       the button. Cheap insurance against a duplicate PATCH. */
    if (saving) {
      return;
    }

    setSaving(true);
    /* Cleared per attempt, so a stale failure never sits alongside a fresh
       retry. */
    setError(null);
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
    } catch (err) {
      /* Required, not defensive: updateEvent rejects on any non-2xx since
         PR-7B, and onClick does not await this handler — without a catch a
         refused save was an unhandled rejection that told the reviewer
         nothing. The refresh is deliberately skipped: re-fetching unchanged
         data would re-render the same card and read as a save that silently
         did nothing. The reviewer's edits stay in local state so the retry
         costs them nothing. */
      setError(messageForError(err));
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

      {/* `role="alert"` so a refused save is announced rather than only drawn —
          the reviewer's attention is on the fields they just corrected, not on
          the bottom of the card. Reuses the error styling EmailInput already
          uses for the same purpose. */}
      {error && (
        <p className="email-message email-message--error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
