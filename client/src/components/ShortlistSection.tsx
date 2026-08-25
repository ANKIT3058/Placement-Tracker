import { useCallback, useEffect, useState } from "react";
import {
  getShortlistParticipation,
  type ShortlistParticipation,
} from "../api/userApi";

/* Inline icons — no icon dependency, and they inherit `currentColor` so they
   follow the light/dark theme automatically. Same set and classes the other
   sections use, so this reads as part of the same page. */
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

/* "Am I on this shortlist?" — the answer G-8.4 computes (G-8.4 frontend).
 *
 * FOUR DISTINCT ANSWERS, AND THEY MUST NOT BE COLLAPSED. This is the whole job
 * of the component:
 *
 *   1. no registration number      → we did not look, and here is how to enable it
 *   2. appearances found            → these are the lists you are on
 *   3. checked, none matched        → we looked at N and you were not on them
 *   4. nothing to check             → you have no shortlists yet, which is not
 *                                     the same as not being on one
 *
 * Cases 3 and 4 are the pair most easily lost. Both render an empty list, and
 * showing "no matches" for a student who simply has no shortlist documents yet
 * would tell them something false about their applications. `shortlistsChecked`
 * exists precisely so this component can tell them apart, and the tests assert
 * the wording differs.
 *
 * NOTHING ABOUT OTHER PARTICIPANTS IS RENDERED — because none is received. The
 * API answers with attachment ids the caller already owns and no participant
 * attribute at all, so there is nothing here to leak even by accident.
 *
 * A FAILED LOAD IS SILENT, matching StudentProfileSection: the Dashboard already
 * reports authentication state once, and a second banner saying the same thing
 * is noise. */
export default function ShortlistSection() {
  const [participation, setParticipation] =
    useState<ShortlistParticipation | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      setParticipation(await getShortlistParticipation());
    } catch {
      /* Swallowed on purpose — the section simply does not appear. */
      setParticipation(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || participation === null) {
    return null;
  }

  const { registrationNumber, shortlistsChecked, appearsOn } = participation;

  const hasRegistrationNumber =
    registrationNumber !== null && registrationNumber.trim() !== "";

  return (
    <section className="email-section" aria-labelledby="shortlist-title">
      <div className="email-section__header">
        <h2 id="shortlist-title">Shortlists</h2>
        <p className="email-hint">
          Whether your registration number appears on shortlists found in your
          own placement attachments.
        </p>
      </div>

      {/* 1. Nothing was looked up, because there is nothing to look up with.
             Phrased as what setting a number ENABLES rather than as something
             missing: the field is optional, and this must not read as a nag. */}
      {!hasRegistrationNumber && (
        <p className="email-status" role="status">
          Add your registration number above and shortlists will be checked for
          it automatically.
        </p>
      )}

      {/* 4. We looked, and there was nothing to look at. Kept distinct from
             case 3 below — telling a student "no match" when no shortlist has
             ever been processed would say something false about where they
             stand. */}
      {hasRegistrationNumber && shortlistsChecked === 0 && (
        <p className="email-status" role="status">
          No shortlists have been found in your attachments yet, so there was
          nothing to check.
        </p>
      )}

      {/* 3. We looked at real documents and the number was not on them. The
             count is stated so the answer is checkable rather than asserted. */}
      {hasRegistrationNumber &&
        shortlistsChecked > 0 &&
        appearsOn.length === 0 && (
          <p className="email-status" role="status">
            Your registration number was not found on{" "}
            {shortlistsChecked === 1
              ? "the 1 shortlist checked"
              : `any of the ${shortlistsChecked} shortlists checked`}
            .
          </p>
        )}

      {/* 2. Found. Identified by attachment — the caller's own — and by nothing
             about any participant, including themselves. */}
      {appearsOn.length > 0 && (
        <>
          <p className="email-message email-message--success" role="status">
            <CheckIcon />
            {appearsOn.length === 1
              ? "You appear on 1 shortlist"
              : `You appear on ${appearsOn.length} shortlists`}
            {shortlistsChecked > appearsOn.length &&
              ` of the ${shortlistsChecked} checked`}
            .
          </p>

          <ul className="shortlist-list">
            {appearsOn.map((appearance) => (
              <li key={appearance.attachmentId}>
                Attachment #{appearance.attachmentId}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
