// ---------------------------------------------------------------------------
// IDENTITY (categorical)  —  ADR-006: Identity Precedes Similarity
//
// Identity attributes are compared to one of three outcomes, never to a number.
// A score can only ever express "how much support"; identity also has to be able
// to express "this is a different thing", and a non-negative term in a weighted
// sum cannot. That gap is what produced D-1: a mismatched round contributed 0,
// which means "no support", and the date term alone already met the acceptance
// threshold — so a contradicted identity attribute could not prevent a match.
//
// UNKNOWN is deliberately NOT a contradiction. An observation that did not state
// a round has said nothing about identity, and the domain's `silence is not
// denial` rule forbids reading that as disagreement.
// ---------------------------------------------------------------------------
// Both extractors substitute this literal when no round can be resolved
// (`extractStage` in email.parser.ts, carried through by `mergeExtraction`).
// It is a marker for "not extracted", not a round any company runs, so it must
// never compare equal to itself.
const UNRESOLVED_ROUND = "unknown";
const resolveRound = (stage) => {
    if (typeof stage !== "string")
        return null;
    const normalized = stage.trim().toLowerCase();
    if (normalized.length === 0 || normalized === UNRESOLVED_ROUND)
        return null;
    return normalized;
};
export const classifyRoundIdentity = (candidateStage, incomingStage) => {
    const candidate = resolveRound(candidateStage);
    const incoming = resolveRound(incomingStage);
    // Either side unresolved: no claim either way. Not evidence of sameness, and
    // not evidence of difference.
    if (candidate === null || incoming === null)
        return "UNKNOWN";
    return candidate === incoming ? "AGREES" : "CONTRADICTS";
};
// The gate itself. Only a contradiction vetoes; everything else stays eligible
// and lets similarity rank it.
export const passesIdentityGate = (relation) => relation !== "CONTRADICTS";
// ---------------------------------------------------------------------------
// SIMILARITY (continuous)
//
// Unchanged by AC-2 — same weights, same date bands, same acceptance threshold.
// What changed is its authority: it may only be called with candidates that
// have already passed the identity gate above, so it now ranks eligible
// candidates rather than deciding which candidates are eligible.
// ---------------------------------------------------------------------------
export const scoreEventMatch = ({ event, incoming, }) => {
    let score = 0;
    const reasons = [];
    // 1. DATE PROXIMITY
    const eventDate = new Date(event.date);
    const incomingDate = new Date(incoming.date);
    const diffDays = Math.abs(eventDate.getTime() - incomingDate.getTime()) /
        (1000 * 60 * 60 * 24);
    let dateScore = 0;
    if (diffDays === 0) {
        dateScore = 1;
        reasons.push("Exact date match");
    }
    else if (diffDays <= 1) {
        dateScore = 0.7;
        reasons.push("Near date match (±1 day)");
    }
    else if (diffDays <= 3) {
        dateScore = 0.5;
        reasons.push("Near date match (±3 days)");
    }
    else {
        return { score: 0, reason: "Date too far" };
    }
    // 2. STAGE MATCH
    let stageScore = 0;
    if (event.stage?.toLowerCase() === incoming.stage?.toLowerCase()) {
        stageScore = 1;
        reasons.push("Stage matched");
    }
    else {
        reasons.push("Stage mismatch");
    }
    // 3. CONFIDENCE ALIGNMENT
    const confidenceScore = Math.min(incoming.confidence ?? 0, event.confidence ?? 0);
    if (confidenceScore > 0.7) {
        reasons.push("Strong confidence alignment");
    }
    else if (confidenceScore > 0.4) {
        reasons.push("Moderate confidence alignment");
    }
    else {
        reasons.push("Weak confidence alignment");
    }
    // FINAL SCORE
    score = dateScore * 0.5 + stageScore * 0.3 + confidenceScore * 0.2;
    return {
        score,
        reason: reasons.join(" + "),
    };
};
//# sourceMappingURL=matching.utils.js.map