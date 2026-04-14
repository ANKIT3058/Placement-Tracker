import { useState } from "react";
import { processEmail } from "../api/emailApi";

export default function EmailInput({ refresh }: { refresh: () => void }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setSuccess(false);
    try {
      await processEmail(text);
      setText("");
      setSuccess(true);
      refresh();
      setTimeout(() => setSuccess(false), 3000);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="email-section">
      <div>
        <h2>Process Placement Email</h2>
        <p className="email-hint">
          Paste the raw email content — AI will extract events automatically
        </p>
      </div>

      <textarea
        className="email-textarea"
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste placement email here..."
        disabled={loading}
      />

      <div className="email-footer">
        <button
          className="btn btn-primary"
          onClick={handleSubmit}
          disabled={loading || !text.trim()}
        >
          {loading ? "Processing..." : "Extract Events"}
        </button>
        {success && (
          <span className="success-msg">✓ Email processed successfully</span>
        )}
      </div>
    </div>
  );
}
