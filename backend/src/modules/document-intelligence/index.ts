// Public surface of the Document Intelligence domain. It defines the vocabulary
// for understanding a parsed document (its type and its extracted meaning) plus
// the layers that produce it: classification, the event/participant extractors,
// and the assembler that merges their outputs into DocumentInsights.
//
// `DocumentIntelligenceService` is the entry point most callers want — it runs
// that sequence end to end and returns the DocumentInsights. It is still not
// wired into the attachment pipeline, and it persists nothing: writing a result
// is `saveDocumentIntelligence`'s job, and it is exported separately so the two
// concerns stay separable at the call site.
export { DOCUMENT_TYPE, type DocumentType } from "./document-type.js";
export type { DocumentInsights } from "./document-insights.types.js";
export type { EventInformation } from "./event-information.types.js";
export type {
  Participant,
  ParticipantInformation,
} from "./participant-information.types.js";

export type { ClassificationResult } from "./classifier/classification-result.types.js";
export {
  DocumentClassifier,
  documentClassifier,
} from "./classifier/document-classifier.service.js";

export {
  EventExtractor,
  eventExtractor,
} from "./extractors/event-extractor.service.js";
export {
  ParticipantExtractor,
  participantExtractor,
} from "./extractors/participant-extractor.service.js";

export {
  DocumentInsightsAssembler,
  documentInsightsAssembler,
} from "./document-insights-assembler.js";

export {
  DocumentIntelligenceService,
  documentIntelligenceService,
} from "./document-intelligence.service.js";

export { saveDocumentIntelligence } from "./document-intelligence.repository.js";
