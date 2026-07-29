import { structuredCompletion, RetryPolicy } from "../../ai/index.js";
import type { ParsedAttachment } from "../../attachment/parsers/parsed-attachment.types.js";
import { DOCUMENT_TYPE, type DocumentType } from "../document-type.js";
import type { ClassificationResult } from "./classification-result.types.js";
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  buildClassificationUserPrompt,
} from "./classification.prompt.js";

// The resilient fallback returned whenever classification cannot produce a
// trustworthy answer (AI disabled, provider error, malformed output, unknown
// label). Per the contract this layer NEVER throws — an unclassifiable document
// is a normal outcome, not an error.
const UNKNOWN_RESULT: ClassificationResult = {
  documentType: DOCUMENT_TYPE.UNKNOWN,
  confidence: 0,
  summary: "",
};

// Maps the model's returned label (the upper-cased DOCUMENT_TYPE keys the prompt
// asks for, e.g. "SHORTLIST") back to the DocumentType value ("shortlist").
// Built from DOCUMENT_TYPE so it stays in sync with the enum automatically.
const LABEL_TO_TYPE = new Map<string, DocumentType>(
  Object.entries(DOCUMENT_TYPE).map(([key, value]) => [key, value]),
);

// The shape we expect back from the model (before validation).
interface RawClassification {
  documentType?: unknown;
  confidence?: unknown;
  summary?: unknown;
}

// Single attempt, no backoff. Classification previously made exactly one
// provider call and degraded any failure to UNKNOWN_RESULT; disabling the AI
// Core's default retries preserves that behaviour identically.
const NO_RETRY = new RetryPolicy({ maxAttempts: 1 });

// Determines the semantic type of a parsed placement document. It ONLY decides
// the DocumentType, summarizes it and scores its confidence — it does not
// extract event fields or participants, modify events, or persist anything. Its
// output is meant to later route a document to a specialized extractor.
//
// It talks to the model through the shared AI Core (structuredCompletion)
// rather than constructing requests itself, so provider setup, code-fence
// stripping, and JSON parsing all live in one place.
export class DocumentClassifier {
  // Classify a parsed document. Always resolves to a ClassificationResult;
  // any failure degrades gracefully to UNKNOWN / confidence 0 / empty summary.
  async classify(parsed: ParsedAttachment): Promise<ClassificationResult> {
    const text = parsed.text?.trim();

    // Nothing to classify — a parser produced no text (e.g. an image-only PDF).
    if (!text) {
      return UNKNOWN_RESULT;
    }

    try {
      const raw = await this.requestClassification(text);
      return this.normalizeResult(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Document classification failed:", message);
      return UNKNOWN_RESULT;
    }
  }

  // Send the document to the shared AI Core and return its parsed JSON. The
  // provider interaction (client, request, fence-stripping, JSON parsing) now
  // lives in the AI Core; prompt, model, and temperature are unchanged.
  private requestClassification(text: string): Promise<RawClassification> {
    return structuredCompletion<RawClassification>({
      systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
      userPrompt: buildClassificationUserPrompt(text),
      // Preserve the exact model + temperature this service used before the AI
      // Core existed, independent of the Core's (possibly evolving) defaults.
      model: { model: "gpt-4o-mini", temperature: 0 },
      retryPolicy: NO_RETRY,
    });
  }

  // Coerce the model's loosely-typed output into a valid ClassificationResult.
  // Any field that is missing, wrong-typed or out of range falls back to the
  // safe default for that field so a partially-bad response never propagates.
  private normalizeResult(raw: RawClassification): ClassificationResult {
    const label =
      typeof raw.documentType === "string"
        ? raw.documentType.trim().toUpperCase()
        : "";
    const documentType = LABEL_TO_TYPE.get(label) ?? DOCUMENT_TYPE.UNKNOWN;

    const confidence =
      typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
        ? Math.min(1, Math.max(0, raw.confidence))
        : 0;

    const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";

    return { documentType, confidence, summary };
  }
}

// Shared singleton for callers that don't need their own instance.
export const documentClassifier = new DocumentClassifier();
