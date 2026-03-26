export const mergeExtraction = (ai: any, regex: any) => {
  return {
    company: ai.company || regex.company,
    stage: ai.stage || regex.stage,
    date: ai.date || regex.date,
    time: ai.time ?? regex.time,
    venue: ai.venue ?? regex.venue,
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