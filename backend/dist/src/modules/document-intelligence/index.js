// Public surface of the Document Intelligence domain. It defines the vocabulary
// for understanding a parsed document (its type and its extracted meaning) plus
// the layers that produce it: classification, the event/participant extractors,
// and the assembler that merges their outputs into DocumentInsights. It is not
// yet wired into the attachment pipeline and persists nothing.
export { DOCUMENT_TYPE } from "./document-type.js";
export { DocumentClassifier, documentClassifier, } from "./classifier/document-classifier.service.js";
export { EventExtractor, eventExtractor, } from "./extractors/event-extractor.service.js";
export { ParticipantExtractor, participantExtractor, } from "./extractors/participant-extractor.service.js";
export { DocumentInsightsAssembler, documentInsightsAssembler, } from "./document-insights-assembler.js";
//# sourceMappingURL=index.js.map