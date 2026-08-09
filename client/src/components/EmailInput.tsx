import { useState } from "react";
import { processEmail } from "../api/emailApi";

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

function SparkIcon() {
  return (
    <svg {...iconProps} className="btn-icon">
      <path d="M12 3v4M12 17v4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M3 12h4M17 12h4M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...iconProps} className="email-message__icon">
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg {...iconProps} className="email-message__icon">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4.5M12 16h.01" />
    </svg>
  );
}

export default function EmailInput({ refresh }: { refresh: () => void }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setSuccess(false);
    setError(null);
    try {
      const result = await processEmail(text);

      /* The API answers { success, message }. Only an explicit `false` is
         treated as a failure, so an unexpected payload shape can never
         turn a successful request into a phantom error. */
      if (result && result.success === false) {
        setError(
          result.message || "Could not process that email. Please try again.",
        );
        return;
      }

      setText("");
      setSuccess(true);
      refresh();
      setTimeout(() => setSuccess(false), 3000);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const charCount = text.length;

  return (
    <section className="email-section" aria-labelledby="email-input-title">
      <div className="email-section__header">
        <h2 id="email-input-title">Process Placement Email</h2>
        <p className="email-hint" id="email-input-hint">
          Paste the raw email content — AI will extract events automatically
        </p>
      </div>

      <textarea
        id="email-input"
        className="email-textarea"
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste placement email here..."
        disabled={loading}
        spellCheck={false}
        aria-labelledby="email-input-title"
        aria-describedby="email-input-hint"
      />

      <div className="email-footer">
        <button
          className="btn btn-primary"
          onClick={handleSubmit}
          disabled={loading || !text.trim()}
          aria-busy={loading}
        >
          {loading ? (
            <>
              <span className="btn-spinner" aria-hidden="true" />
              Processing…
            </>
          ) : (
            <>
              <SparkIcon />
              Extract Events
            </>
          )}
        </button>

        <p className="email-status" role="status" aria-live="polite">
          {success && (
            <span className="email-message email-message--success">
              <CheckIcon />
              Email processed successfully
            </span>
          )}
        </p>

        {charCount > 0 && (
          <span className="email-count">
            {charCount.toLocaleString()} characters
          </span>
        )}
      </div>

      {error && (
        <p className="email-message email-message--error" role="alert">
          <AlertIcon />
          {error}
        </p>
      )}
    </section>
  );
}
