import type { VenueMeta } from "../email/email.parser";

type ExtractionInput = {
  company: string | null;
  date: Date | null;
  time: string | null;
  stage: string | null;
  venueMeta?: VenueMeta;
  isTimeEstimated?: boolean;
  rawText?: string; // optional for future improvements
};

type ConfidenceBreakdown = {
  company: number;
  date: number;
  time: number;
  stage: number;
  venue: number;
};

const WEIGHTS = {
  date: 0.35,
  time: 0.2,
  company: 0.25,
  stage: 0.1,
  venue: 0.1,
};

const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value));

/**
 * Core function
 */
export const computeConfidence = (
  data: ExtractionInput,
): {
  confidence: number;
  breakdown: ConfidenceBreakdown;
} => {
  const breakdown: ConfidenceBreakdown = {
    company: scoreCompany(data.company),
    date: scoreDate(data.date, data.rawText),
    time: scoreTime(data.time, data.isTimeEstimated, data.rawText),
    stage: scoreStage(data.stage),
    venue: scoreVenue(data.venueMeta),
  };

  let total =
    breakdown.company * WEIGHTS.company +
    breakdown.date * WEIGHTS.date +
    breakdown.time * WEIGHTS.time +
    breakdown.stage * WEIGHTS.stage +
    breakdown.venue * WEIGHTS.venue;

  // Completeness bonus
  if (data.company && data.date && data.stage) {
    total += 0.05;
  }

  return {
    confidence: clamp(total),
    breakdown,
  };
};

//
// ---------------- FIELD SCORERS ----------------
//

const scoreCompany = (company: string | null): number => {
  if (!company) return 0;

  // simple heuristic: longer names more reliable
  if (company.length > 2) return 1;

  return 0.7;
};

const scoreDate = (date: Date | null, rawText?: string): number => {
  if (!date) return 0;

  if (!rawText) return 1;

  const text = rawText.toLowerCase();

  if (text.includes("next week") || text.includes("coming week")) {
    return 0.5;
  }

  if (text.includes("tomorrow") || text.includes("today")) {
    return 0.8;
  }

  return 1;
};

const scoreTime = (
  time: string | null,
  isEstimated?: boolean,
  rawText?: string,
): number => {
  if (!time) return 0;

  let score = 1;

  if (isEstimated) {
    score *= 0.6;
  }

  if (rawText) {
    const text = rawText.toLowerCase();

    if (
      text.includes("evening") ||
      text.includes("morning") ||
      text.includes("afternoon")
    ) {
      score *= 0.8;
    }
  }

  return clamp(score);
};

const scoreStage = (stage: string | null): number => {
  if (!stage) return 0;

  return 1; // deterministic extraction → assume strong
};

const scoreVenue = (venueMeta?: VenueMeta): number => {
  if (!venueMeta) return 0.5;

  if (!venueMeta.isExplicit) {
    return 0.5; // neutral (important design decision)
  }

  if (!venueMeta.value) {
    return 0.3; // explicitly invalid
  }

  return 0.9;
};
