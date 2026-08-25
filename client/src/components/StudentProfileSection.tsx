import { useCallback, useEffect, useState } from "react";
import {
  getStudentProfile,
  updateStudentProfile,
} from "../api/userApi";

/* Inline icons — no icon dependency, and they inherit `currentColor` so they
   follow the light/dark theme automatically. Same set and same classes
   EmailInput uses, so this section reads as part of the same page. */
const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

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

/* What to tell the user when saving fails.
 *
 * `requestJson` rejects with an `ApiError` carrying the HTTP status for any
 * non-2xx response and lets a genuine network failure through untouched, so a
 * numeric `status` is the line between "the server answered and refused" and
 * "the server was never reached" — the same distinction EmailInput draws, for
 * the same reason.
 *
 * 409 IS THE ONE THAT NEEDED CARE. A registration number is globally unique in
 * this deployment, so a duplicate is a real and reachable outcome, and the user
 * must be told their save did not happen. What must NOT be said is who holds
 * it: the server's own message identifies no one, and nothing is added here.
 * Naming the other account — or even confirming one exists beyond "in use" —
 * would turn this field into a way to test registration numbers against the
 * user base one submission at a time. */
const messageForError = (error: unknown): string => {
  const status =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown }).status
      : undefined;

  if (typeof status !== "number") {
    return "Could not reach the server. Check your connection and try again.";
  }

  if (status === 409) {
    return "That registration number is already in use.";
  }

  if (status === 401) {
    return "Your session has expired. Please sign in again.";
  }

  return "Could not save your registration number. Please try again.";
};

/* The student's own registration number — optional campus information, and
 * nothing the rest of the application depends on (G-8.3).
 *
 * DELIBERATELY NOT A GATE. This renders as one ordinary section among others: it
 * blocks nothing, prompts nothing, and an empty value is presented as a normal
 * state rather than something to fix. Off-campus opportunities carry no
 * registration number at all, so a student who never sets one must see an
 * application that behaves identically — anything that nags or interrupts would
 * contradict the reason the field is optional.
 *
 * A FAILED LOAD IS SILENT, and that is the point. If GET fails — including the
 * 401 a signed-out session produces — this section shows nothing rather than an
 * error, because the Dashboard already reports authentication state once and a
 * second banner saying the same thing is noise. The section is only useful to
 * someone signed in; when it cannot know, it stays out of the way.
 *
 * NO CLIENT-SIDE FORMAT VALIDATION. The server accepts arbitrary strings by
 * design, and it owns the trimming. A rule here would be a second
 * implementation of a decision made once, and it would refuse students whose
 * number is perfectly valid at their institution. */
export default function StudentProfileSection() {
  /* `undefined` means "not known yet", `null` means "known to be unset". The
     two must not collapse: the first hides the section, the second shows it
     with an empty field, and treating them alike would flash an empty form
     before the real value arrives. */
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const profile = await getStudentProfile();

      setSaved(profile.registrationNumber);
      setDraft(profile.registrationNumber ?? "");
      setAvailable(true);
    } catch {
      /* Swallowed on purpose — see the note above. The Dashboard owns
         reporting session state, and this section simply does not appear. */
      setAvailable(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* One write path for both saving and clearing, because they are the same
     request with a different value. `null` clears; the server treats an omitted
     field as "change nothing", so a clear has to say `null` explicitly rather
     than send an empty body. */
  const submit = async (value: string | null, confirmation: string) => {
    if (saving) {
      return;
    }

    setSaving(true);
    setSuccess(null);
    setError(null);

    try {
      const profile = await updateStudentProfile(value);

      /* The server's response is the source of truth for what was stored, not
         the string that was typed: it trims, so echoing the draft back would
         show something subtly different from what is saved. */
      setSaved(profile.registrationNumber);
      setDraft(profile.registrationNumber ?? "");
      setSuccess(confirmation);
    } catch (err) {
      setError(messageForError(err));
    } finally {
      setSaving(false);
    }
  };

  /* USED ONLY TO DECIDE WHETHER SAVING IS MEANINGFUL — never to build the
     value that is sent.

     The server owns trimming, and it is the only thing that should: trimming
     here as well would be a second implementation of one rule, free to drift
     from the first, and it would mean the client normalizes a field the
     architecture says it must not touch. So `draft` goes to the API exactly as
     typed, and this trimmed copy answers two local questions only — is there
     anything in the box, and does it already match what is stored. */
  const trimmedDraft = draft.trim();

  const unchanged = trimmedDraft === (saved ?? "").trim();

  if (loading || !available) {
    return null;
  }

  return (
    <section className="email-section" aria-labelledby="student-profile-title">
      <div className="email-section__header">
        <h2 id="student-profile-title">Student Profile</h2>
        <p className="email-hint" id="student-profile-hint">
          Your college registration number. Optional — everything works without
          it, and off-campus opportunities never need one.
        </p>
      </div>

      <input
        id="registration-number"
        type="text"
        className="email-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Not set"
        disabled={saving}
        spellCheck={false}
        autoComplete="off"
        aria-labelledby="student-profile-title"
        aria-describedby="student-profile-hint"
      />

      <div className="email-footer">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => submit(draft, "Registration number saved")}
          disabled={saving || unchanged || trimmedDraft === ""}
          aria-busy={saving}
        >
          {saving ? (
            <>
              <span className="btn-spinner" aria-hidden="true" />
              Saving…
            </>
          ) : (
            "Save"
          )}
        </button>

        {/* Offered only when there is something to clear. A clear button beside
            an already-empty field is an action that cannot change anything. */}
        {saved !== null && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => submit(null, "Registration number cleared")}
            disabled={saving}
            aria-busy={saving}
          >
            Clear
          </button>
        )}

        <p className="email-status" role="status" aria-live="polite">
          {success && (
            <span className="email-message email-message--success">
              <CheckIcon />
              {success}
            </span>
          )}
        </p>
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
