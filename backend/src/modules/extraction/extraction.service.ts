import { extractData } from "../email/email.parser.js";
import {
  mergeExtraction,
  getExtractionStatus,
  detectEstimatedTime,
  validateAIDate,
} from "./extraction.utils.js";
import { computeConfidence } from "./confidence.utils.js";
import { structuredCompletion, RetryPolicy } from "../ai/index.js";

// Re-exported, not redefined. The implementation moved to `ai/openai-client`
// so that `ai/openai-provider` could stop importing this module — that import
// closed a cycle (ai/index -> structured-completion -> openai-provider ->
// extraction.service -> ai/index) which is harmless under ESM but breaks under
// the CommonJS output ts-jest produces.
//
// The symbol stays exported from here on purpose: the document-intelligence
// extractors import it from this path, and several test suites mock this module
// to intercept it. Re-exporting keeps both working unchanged, and keeps the
// memoised client a single instance — there is still exactly one definition.
export { getOpenAIClient } from "../ai/openai-client.js";

// The structured JSON shape the extraction prompt asks the model to return.
// This is a compile-time assertion about the parsed JSON, not a runtime
// contract — the AI Core validates that the response IS JSON, while the
// business-level validation and normalization stay in `extract` /
// `mergeExtraction` below, exactly as before.
interface AIExtraction {
  company?: string;
  stage?: string;
  date?: string | null;
  time?: string | null;
  venue?: string | null;
}

// Single attempt, no backoff. The prior implementation made exactly one
// provider call and let `extract` fall back to regex on any failure; disabling
// the AI Core's default retries preserves that behaviour identically.
const NO_RETRY = new RetryPolicy({ maxAttempts: 1 });

export const extractWithAI = async (text: string): Promise<AIExtraction> => {
  // Provider interaction (client, request, fence-stripping, JSON parsing) now
  // lives in the AI Core. Prompt, model, and temperature are unchanged.
  return structuredCompletion<AIExtraction>({
    systemPrompt: `
You are an information extraction system.

Extract structured data from placement emails.

Rules:
- Convert dates like "20th Aug" → "YYYY-MM-DD"
- Use the explicit year from the email if present (e.g. "16th August 2025" → "2025-08-16")
- Assume current year ONLY if no year is given
- Only return a full date when the email provides sufficient evidence for the day and month.
  - A standalone year (e.g. "in 2027") is not a date — return null.
  - A month + year alone (e.g. "August 2027") is not a full date — return null.
  - Never invent a missing day or month merely to produce YYYY-MM-DD.
  - Return null when the date is incomplete or ambiguous.
- Convert vague times:
  - "morning" → "10:00"
  - "afternoon" → "14:00"
  - "evening" → "18:00"
- If time is approximate, still return best guess (DO NOT return null)
- Extract platform as venue (e.g., HackerRank, Zoom)
  - If multiple events exist:
  - Extract the most important one
  - Prefer Interview > Test > PPT
  - Ignore incomplete information

Return STRICT JSON only:
{
  "company": string,
  "stage": "OA" | "Interview" | "PPT" | "Registration",
  "date": "YYYY-MM-DD" | null,
  "time": string | null,
  "venue": string | null
}
`,
    userPrompt: text,
    // Preserve the exact model + temperature this service used before the AI
    // Core existed, independent of the Core's (possibly evolving) defaults.
    model: { model: "gpt-4o-mini", temperature: 0 },
    retryPolicy: NO_RETRY,
  });
};

export const extract = async (text: string) => {
  let aiData: any = null;
  let regexData = {};

  const useAI = process.env.USE_AI === "true";

  if (useAI) {
    try {
      aiData = await extractWithAI(text);
    } catch (e: any) {
      console.error("AI failed:", e.message);
    }
  }

  if (!aiData) {
    console.log("Using regex only (AI unavailable)");
  }

  if (aiData) {
    // A full "YYYY-MM-DD" is only trustworthy when the source actually names
    // that day and month; the AI can otherwise turn a standalone year or a
    // month+year into a plausible-looking but fabricated date. An unsupported
    // date is dropped here (not replaced) so `mergeExtraction` falls back to
    // the deterministic date exactly as it already does for any other
    // missing AI field.
    aiData.date = validateAIDate(aiData.date, text);
  }

  regexData = extractData(text);

  const merged = mergeExtraction(aiData || {}, regexData);

  const status = getExtractionStatus(merged);

  const isTimeEstimated = detectEstimatedTime(text);

  const { confidence, breakdown } = computeConfidence({
    company: merged.company,
    stage: merged.stage,
    date: merged.date ? new Date(merged.date) : null,
    time: merged.time,
    venueMeta: merged.venueMeta,
    isTimeEstimated,
    rawText: text,
  });

  let finalConfidence = confidence;
  let penalty = 0;

  // scoreCompany already returns 0 for "unknown"; small extra penalty signals low trust
  if (merged.company === "unknown") penalty += 0.1;
  // venue and time missing: venue is slightly more critical (location is harder to guess)
  if (!merged.venue) penalty += 0.15;
  if (!merged.time) penalty += 0.1;

  finalConfidence = Math.max(0, confidence - penalty);

  return {
    data: merged,
    confidence: finalConfidence,
    status,
    isTimeEstimated,
  };
};
