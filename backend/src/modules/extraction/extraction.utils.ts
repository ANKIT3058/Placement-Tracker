import { cleanEmail, findDateEvidence, type VenueMeta } from "../email/email.parser.js";

// A full calendar date is only trustworthy when the source text actually says
// which day and month it is. The AI can turn a standalone year ("in 2027") or
// a month+year ("August 2027") into a plausible-looking "YYYY-MM-DD" by
// inventing the missing day (and/or month), and syntactic validity alone
// can't catch that — "2027-01-01" is a well-formed date whether or not
// January 1st was ever mentioned. This checks the AI's specific candidate
// against every day+month mention in the source (not just the first one),
// so a later date in a multi-date email is still recognised as supported.
//
// `sourceText` is run through `cleanEmail` before scanning, the same way
// `extractData` does, so a date that appears only in a quoted/forwarded
// thread (a real date, just belonging to a different email) can't authorize
// the AI's candidate for the current message.
export const validateAIDate = (
  candidateDate: string | null | undefined,
  sourceText: string,
): string | null => {
  if (!candidateDate) return null;

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidateDate);
  if (!isoMatch) return null;

  const year = parseInt(isoMatch[1]!, 10);
  const month = parseInt(isoMatch[2]!, 10) - 1;
  const day = parseInt(isoMatch[3]!, 10);
  const currentYear = new Date().getUTCFullYear();

  const isSupported = findDateEvidence(cleanEmail(sourceText)).some(
    (evidence) =>
      evidence.day === day &&
      evidence.month === month &&
      // An evidence mention with no year matches a candidate year only when
      // that candidate is the same current-year default the deterministic
      // extractor itself would have applied (see `extractExactDate`).
      (evidence.year === year ||
        (evidence.year === null && year === currentYear)),
  );

  return isSupported ? candidateDate : null;
};

export const mergeExtraction = (ai: any, regex: any) => {
  // AI returns a plain string; if AI extracted a venue, treat it as explicit.
  // Otherwise fall back to the VenueMeta from the regex layer.
  const venueMeta: VenueMeta =
    ai.venue != null
      ? { value: ai.venue as string, isExplicit: true }
      : (regex.venue as VenueMeta);

  return {
    company: ai.company || regex.company,
    stage: ai.stage || regex.stage,
    date: ai.date || regex.date,
    time: ai.time ?? regex.time,
    venue: venueMeta.value,   // plain string | null — used by DB writes & confidence scoring
    venueMeta,                // carries isExplicit — used by update logic
  };
};

export const calculateConfidence = (data: any) => {
  let score = 0;

  if (data.company) score += 0.25;
  if (data.stage) score += 0.2;
  if (data.date) score += 0.3;
  if (data.time) score += 0.15;
  if (data.venue) score += 0.1;

  return score;
};

export const getExtractionStatus = (data: any) => {
  if (!data.company || !data.stage || !data.date) return "failed";
  if (!data.time || !data.venue) return "partial";
  return "complete";
};

export const detectEstimatedTime = (text: string) => {
  return /around|approx|morning|afternoon|evening/i.test(text);
};