import {
  findByEventKey,
  findNearbyEvents,
  findByCompanyAndStage,
} from "../event/event.repository";

import { generateEventKey } from "../event/event.utils";

export const matchEventV2 = async (data: {
  company: string;
  stage: string;
  date: string;
}) => {
  // 1. Exact match
  const key = generateEventKey(data);
  const exact = await findByEventKey(key);

  if (exact) {
    return { event: exact, matchType: "exact", confidence: 1.0 };
  }

  // 2. Soft match
  const softMatches = await findNearbyEvents({
    company: data.company,
    date: data.date,
    windowDays: 3,
  });

  if (softMatches.length === 1) {
    return { event: softMatches[0], matchType: "soft", confidence: 0.8 };
  }

  // 3. Loose match
  const looseMatches = await findByCompanyAndStage({
    company: data.company,
    stage: data.stage,
  });

  if (looseMatches.length === 1) {
    return { event: looseMatches[0], matchType: "loose", confidence: 0.6 };
  }

  return null;
};
