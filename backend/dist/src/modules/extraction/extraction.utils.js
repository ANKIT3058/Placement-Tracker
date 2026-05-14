export const mergeExtraction = (ai, regex) => {
    // AI returns a plain string; if AI extracted a venue, treat it as explicit.
    // Otherwise fall back to the VenueMeta from the regex layer.
    const venueMeta = ai.venue != null
        ? { value: ai.venue, isExplicit: true }
        : regex.venue;
    return {
        company: ai.company || regex.company,
        stage: ai.stage || regex.stage,
        date: ai.date || regex.date,
        time: ai.time ?? regex.time,
        venue: venueMeta.value, // plain string | null — used by DB writes & confidence scoring
        venueMeta, // carries isExplicit — used by update logic
    };
};
export const calculateConfidence = (data) => {
    let score = 0;
    if (data.company)
        score += 0.25;
    if (data.stage)
        score += 0.2;
    if (data.date)
        score += 0.3;
    if (data.time)
        score += 0.15;
    if (data.venue)
        score += 0.1;
    return score;
};
export const getExtractionStatus = (data) => {
    if (!data.company || !data.stage || !data.date)
        return "failed";
    if (!data.time || !data.venue)
        return "partial";
    return "complete";
};
export const detectEstimatedTime = (text) => {
    return /around|approx|morning|afternoon|evening/i.test(text);
};
//# sourceMappingURL=extraction.utils.js.map