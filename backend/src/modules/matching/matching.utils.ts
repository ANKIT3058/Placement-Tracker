export const scoreEventMatch = ({
  event,
  incoming,
}: {
  event: any;
  incoming: any;
}) => {
  let score = 0;
  const reasons: string[] = [];

  // 1. DATE PROXIMITY
  const eventDate = new Date(event.date);
  const incomingDate = new Date(incoming.date);

  const diffDays =
    Math.abs(eventDate.getTime() - incomingDate.getTime()) /
    (1000 * 60 * 60 * 24);

  let dateScore = 0;

  if (diffDays === 0) {
    dateScore = 1;
    reasons.push("Exact date match");
  } else if (diffDays <= 1) {
    dateScore = 0.7;
    reasons.push("Near date match (±1 day)");
  } else if (diffDays <= 3) {
    dateScore = 0.5;
    reasons.push("Near date match (±3 days)");
  } else {
    return { score: 0, reason: "Date too far" };
  }

  // 2. STAGE MATCH
  let stageScore = 0;
  if (event.stage?.toLowerCase() === incoming.stage?.toLowerCase()) {
    stageScore = 1;
    reasons.push("Stage matched");
  } else {
    reasons.push("Stage mismatch");
  }

  // 3. CONFIDENCE ALIGNMENT
  const confidenceScore = Math.min(
    incoming.confidence ?? 0,
    event.confidence ?? 0,
  );

  if (confidenceScore > 0.7) {
    reasons.push("Strong confidence alignment");
  } else if (confidenceScore > 0.4) {
    reasons.push("Moderate confidence alignment");
  } else {
    reasons.push("Weak confidence alignment");
  }

  // FINAL SCORE
  score = dateScore * 0.5 + stageScore * 0.3 + confidenceScore * 0.2;

  return {
    score,
    reason: reasons.join(" + "),
  };
};
