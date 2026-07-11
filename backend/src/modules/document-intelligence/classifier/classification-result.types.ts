import type { DocumentType } from "../document-type.js";

// The narrow output of the classification layer: WHAT a parsed document is,
// nothing about what it contains. This is intentionally a subset of
// DocumentInsights (documentType + confidence + summary) — the classifier never
// produces EventInformation or ParticipantInformation. Those are the job of
// later, type-specific extractors that run after classification has decided
// which extractor to invoke.
export interface ClassificationResult {
  // The document category the model decided on, or UNKNOWN when it could not
  // decide (or when classification failed).
  documentType: DocumentType;

  // How trustworthy the decision is, 0..1 (0 = none, 1 = certain). Always 0 on
  // failure.
  confidence: number;

  // A concise, human-readable synopsis of the document. Empty string on failure
  // or when the model returns nothing usable.
  summary: string;
}
