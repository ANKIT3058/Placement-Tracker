import {
  findByEventKey,
  findNearbyEvents,
  findByCompanyAndStage,
} from "../event/event.repository.js";

import { generateEventKey } from "../event/event.utils.js";
import {
  scoreEventMatch,
  classifyRoundIdentity,
  passesIdentityGate,
  type IdentityRelation,
} from "./matching.utils.js";
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
    // IDENTITY GATE (ADR-006). Runs to completion before any similarity work.
    // A candidate whose round contradicts the observation is vetoed here, so it
    // never reaches scoreEventMatch — it is never scored, never contributes a
    // confidence-alignment term, and never meets the acceptance threshold.
    // The candidate query above deliberately does not filter on round: the
    // engine has to see the contradicting candidate in order to refuse it and
    // to say that it did.
    const eligible: { event: any; identity: IdentityRelation }[] = [];

    for (const event of softMatches) {
      const identity = classifyRoundIdentity(event.stage, data.stage);

      if (!passesIdentityGate(identity)) {
        console.log({
          company: data.company,
          stage: data.stage,
          date: data.date,
          candidateId: event.id,
          candidateStage: event.stage,
          identity,
          outcome: "vetoed-before-similarity",
        });
        continue;
      }

      eligible.push({ event, identity });
    }

    // SIMILARITY RANKING — eligible candidates only.
    let bestMatch = null;
    let bestScore = 0;
    let bestReason = "";
    let bestIdentity: IdentityRelation | null = null;

    for (const { event, identity } of eligible) {
      const { score, reason } = scoreEventMatch({
        event,
        incoming: data,
      });

      if (score > bestScore) {
        bestScore = score;
        bestMatch = event;
        bestReason = reason;
        bestIdentity = identity;
      }
    }

    // threshold to avoid bad matches
    if (bestMatch && bestScore >= 0.5) {
      console.log({
        company: data.company,
        stage: data.stage,
        date: data.date,
        matchType: "soft",
        identity: bestIdentity,
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
