// Combines the outputs of the classification and extraction layers into the
// final DocumentInsights domain object. It owns NO AI logic and makes NO network
// calls — it is a pure, deterministic merge. Keeping this seam separate means the
// extractors stay single-purpose (each returns only its slice) and there is one
// obvious place that decides the final shape of a document's understanding.
//
// `classification`, `confidence` and `summary` come straight from the
// ClassificationResult. The optional event/participant slices are attached only
// when they actually carry content, so an empty extraction (the resilient
// fallback) leaves the corresponding field absent rather than attaching a hollow
// object.
export class DocumentInsightsAssembler {
    assemble(classification, eventInformation, participantInformation) {
        const insights = {
            classification: classification.documentType,
            confidence: classification.confidence,
            summary: classification.summary,
        };
        if (this.hasEventInformation(eventInformation)) {
            insights.eventInformation = eventInformation;
        }
        if (this.hasParticipantInformation(participantInformation)) {
            insights.participantInformation = participantInformation;
        }
        return insights;
    }
    // Event information is meaningful only if at least one field was understood.
    hasEventInformation(info) {
        return Object.values(info).some((value) => value !== undefined);
    }
    // Participant information is meaningful only if at least one participant exists.
    hasParticipantInformation(info) {
        return info.participants.length > 0;
    }
}
// Shared singleton for callers that don't need their own instance.
export const documentInsightsAssembler = new DocumentInsightsAssembler();
//# sourceMappingURL=document-insights-assembler.js.map