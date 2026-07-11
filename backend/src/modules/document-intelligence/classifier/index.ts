// Public surface of the document classification layer. It answers only "what
// kind of document is this?" — the decision that will later route a document to
// a type-specific extractor. It performs no extraction, no event updates and no
// persistence.
export type { ClassificationResult } from "./classification-result.types.js";
export {
  DocumentClassifier,
  documentClassifier,
} from "./document-classifier.service.js";
