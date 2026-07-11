import type { DocumentType } from "./document-type.js";
import type { EventInformation } from "./event-information.types.js";
import type { ParticipantInformation } from "./participant-information.types.js";

// The output of the Document Intelligence layer: the semantic understanding of a
// single parsed document. It is the last box in the conceptual pipeline
//
//   Attachment -> Parser -> ParsedAttachment -> Document Intelligence -> DocumentInsights
//
// A ParsedAttachment says WHAT text/structure a file contains; DocumentInsights
// says what that content MEANS. It is deliberately decoupled from email
// extraction, event matching, AI providers and persistence — it is a plain
// domain description that any of those layers can produce or consume.
export interface DocumentInsights {
  // Which kind of document this is understood to be. UNKNOWN when the content
  // is understood but fits no known category.
  classification: DocumentType;

  // How trustworthy the classification is, on a 0..1 scale (0 = no confidence,
  // 1 = certain). Consumers use this to decide whether to act automatically or
  // route the document for human review.
  confidence: number;

  // A short, human-readable synopsis of the document's content, independent of
  // classification — useful for review UIs and audit logs.
  summary: string;

  // Event-affecting facts the document revealed, present only when the document
  // actually carries them (a job description may carry none). Absent means "no
  // event information was understood", not "empty event".
  eventInformation?: EventInformation;

  // Participant-related content the document revealed (seating, shortlist,
  // panel, ...), present only when applicable.
  participantInformation?: ParticipantInformation;
}
