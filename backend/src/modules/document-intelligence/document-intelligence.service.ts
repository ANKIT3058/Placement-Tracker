import type { ParsedAttachment } from "../attachment/parsers/parsed-attachment.types.js";
import type { DocumentInsights } from "./document-insights.types.js";
import {
  DocumentClassifier,
  documentClassifier as defaultClassifier,
} from "./classifier/document-classifier.service.js";
import {
  EventExtractor,
  eventExtractor as defaultEventExtractor,
} from "./extractors/event-extractor.service.js";
import {
  ParticipantExtractor,
  participantExtractor as defaultParticipantExtractor,
} from "./extractors/participant-extractor.service.js";
import {
  DocumentInsightsAssembler,
  documentInsightsAssembler as defaultAssembler,
} from "./document-insights-assembler.js";

// The entry point of the Document Intelligence layer: one parsed document in,
// one DocumentInsights out.
//
// It owns the ORDER of the pipeline and nothing else. Classification decides
// what the document is; that decision is then handed to both extractors, each of
// which self-gates on it; the assembler merges the three results. There is no AI
// logic here, no prompt, no provider, and no normalization — every one of those
// lives in the collaborator that owns it, which is what keeps this class a
// statement about sequence rather than a second place where document
// understanding is implemented.
//
// It does NOT persist. Writing the result is `saveDocumentIntelligence`'s job
// (document-intelligence.repository), and keeping the two apart is what lets
// this be exercised with no database at all — the boundary its tests pin.
//
// Collaborators are injected with the module singletons as defaults, the same
// shape DocumentProcessingService uses for its storage and parser registry.
// Production callers pass none; tests pass fakes.
export class DocumentIntelligenceService {
  private readonly classifier: DocumentClassifier;
  private readonly eventExtractor: EventExtractor;
  private readonly participantExtractor: ParticipantExtractor;
  private readonly assembler: DocumentInsightsAssembler;

  constructor(
    classifier: DocumentClassifier = defaultClassifier,
    eventExtractor: EventExtractor = defaultEventExtractor,
    participantExtractor: ParticipantExtractor = defaultParticipantExtractor,
    assembler: DocumentInsightsAssembler = defaultAssembler,
  ) {
    this.classifier = classifier;
    this.eventExtractor = eventExtractor;
    this.participantExtractor = participantExtractor;
    this.assembler = assembler;
  }

  // Understand one parsed document.
  //
  // Both extractors are invoked unconditionally and each decides for itself
  // whether the classification is one it handles — the routing rule lives with
  // the extractor that owns it, not here. Their type gates are disjoint
  // (job_description/interview_schedule/general_instructions vs
  // shortlist/seating_arrangement/result), so at most one of them reaches a
  // provider and the other returns its empty value without a network call.
  //
  // Sequential rather than concurrent, deliberately: since only one extractor
  // can do real work, awaiting them in turn costs effectively one round trip,
  // and a fixed order is easier to reason about than an interleaved one.
  //
  // No try/catch, deliberately. All three collaborators are contractually
  // no-throw — an unclassifiable or unextractable document is a normal outcome
  // that arrives as a degraded VALUE (unknown / {} / no participants), not as an
  // exception. Catching here would therefore only ever swallow a genuine defect,
  // such as a collaborator breaking that contract. The fail-soft policy for the
  // wider pipeline belongs at the call site that persists the result, which does
  // not exist yet.
  async analyze(parsed: ParsedAttachment): Promise<DocumentInsights> {
    const classification = await this.classifier.classify(parsed);

    const eventInformation = await this.eventExtractor.extract(
      parsed,
      classification,
    );

    const participantInformation = await this.participantExtractor.extract(
      parsed,
      classification,
    );

    return this.assembler.assemble(
      classification,
      eventInformation,
      participantInformation,
    );
  }
}

// Shared singleton for callers that don't need their own instance.
export const documentIntelligenceService = new DocumentIntelligenceService();
