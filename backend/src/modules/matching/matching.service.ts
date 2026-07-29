import {
  findByEventKey,
  findNearbyEvents,
  findByCompanyAndStage,
} from "../event/event.repository.js";

import { generateEventKey } from "../event/event.utils.js";
import { scoreEventMatch } from "./matching.utils.js";
import { LOOSE_MATCH_WINDOW_DAYS } from "../../shared/constants/config.js";

export const matchEventV2 = async (data: {
  company: string;
  stage: string;
  date: string;
  confidence?: number;
}) => {
  // 1. Exact match
  const key = generateEventKey(data);
  const exact = await findByEventKey(key);

  if (exact) {
    console.log({
      company: data.company,
      stage: data.stage,
      date: data.date,
      matchType: "exact",
      confidence: 1.0,
    });
    return { event: exact, matchType: "exact", confidence: 1.0 };
  }

  // 2. Soft match (confidence-aware)
  const softMatches = await findNearbyEvents({
    company: data.company,
    date: data.date,
    windowDays: 3,
  });

  if (softMatches.length > 0) {
    let bestMatch = null;
    let bestScore = 0;
    let bestReason = "";

    for (const event of softMatches) {
      const { score, reason } = scoreEventMatch({
        event,
        incoming: data,
      });

      if (score > bestScore) {
        bestScore = score;
        bestMatch = event;
        bestReason = reason;
      }
    }

    // threshold to avoid bad matches
    if (bestMatch && bestScore >= 0.5) {
      console.log({
        company: data.company,
        stage: data.stage,
        date: data.date,
        matchType: "soft",
        confidence: bestScore,
        reason: bestReason,
      });
      return {
        event: bestMatch,
        matchType: "soft",
        confidence: bestScore,
        explanation: bestReason,
      };
    }
  }

  // 3. Loose match (bounded: uniqueness only implies identity within a plausible
  // date range — see LOOSE_MATCH_WINDOW_DAYS)
  const looseMatches = await findByCompanyAndStage({
    company: data.company,
    stage: data.stage,
    date: data.date,
    windowDays: LOOSE_MATCH_WINDOW_DAYS,
  });

  if (looseMatches.length === 1) {
    console.log({
      company: data.company,
      stage: data.stage,
      date: data.date,
      matchType: "loose",
      confidence: 0.6,
    });
    return { event: looseMatches[0], matchType: "loose", confidence: 0.6 };
  }

  console.log({
    company: data.company,
    stage: data.stage,
    date: data.date,
    matchType: "none",
  });

  return null;
};
