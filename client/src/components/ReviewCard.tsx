import { useState } from "react";
import { updateEvent } from "../api/eventApi";

interface ReviewEvent {
  id: number;
  company: string;
  stage: string;
  reviewReason?: string;
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
      await updateEvent(event.id, {
        company,
        stage,
        confidence: 1.0,
        status: "confirmed",
      });
      refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card card-review">
      <div className="review-header">
        <span className="review-label">Needs Review</span>
        {event.reviewReason && (
          <p className="review-reason">{event.reviewReason}</p>
        )}
      </div>

      <div className="review-fields">
        <label className="field-label">
          Company
          <input
            className="field-input"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
        </label>
        <label className="field-label">
          Stage
          <input
            className="field-input"
            value={stage}
            onChange={(e) => setStage(e.target.value)}
          />
        </label>
      </div>

      <button
        className="btn btn-confirm"
        onClick={handleConfirm}
        disabled={saving}
      >
        {saving ? "Saving..." : "Confirm & Save"}
      </button>
    </div>
  );
}
