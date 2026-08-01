import OpenAI from "openai";
import { extractData } from "../email/email.parser.js";
import { mergeExtraction, getExtractionStatus, detectEstimatedTime, } from "./extraction.utils.js";
import { computeConfidence } from "./confidence.utils.js";
import { structuredCompletion, RetryPolicy } from "../ai/index.js";
let client = null;
// Lazily construct and memoize the single shared OpenAI client. Exported so
// other AI features (e.g. the DocumentClassifier) reuse the exact same provider
// instance and API-key handling instead of standing up a second client.
export const getOpenAIClient = () => {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY not set");
    }
    if (!client) {
        client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }
    return client;
};
// Single attempt, no backoff. The prior implementation made exactly one
// provider call and let `extract` fall back to regex on any failure; disabling
// the AI Core's default retries preserves that behaviour identically.
const NO_RETRY = new RetryPolicy({ maxAttempts: 1 });
export const extractWithAI = async (text) => {
    // Provider interaction (client, request, fence-stripping, JSON parsing) now
    // lives in the AI Core. Prompt, model, and temperature are unchanged.
    return structuredCompletion({
        systemPrompt: `
You are an information extraction system.

Extract structured data from placement emails.

Rules:
- Convert dates like "20th Aug" → "YYYY-MM-DD"
- Use the explicit year from the email if present (e.g. "16th August 2025" → "2025-08-16")
- Assume current year ONLY if no year is given
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
  "date": "YYYY-MM-DD",
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
export const extract = async (text) => {
    let aiData = null;
    let regexData = {};
    const useAI = process.env.USE_AI === "true";
    if (useAI) {
        try {
            aiData = await extractWithAI(text);
        }
        catch (e) {
            console.error("AI failed:", e.message);
        }
    }
    if (!aiData) {
        console.log("Using regex only (AI unavailable)");
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
    if (merged.company === "unknown")
        penalty += 0.1;
    // venue and time missing: venue is slightly more critical (location is harder to guess)
    if (!merged.venue)
        penalty += 0.15;
    if (!merged.time)
        penalty += 0.1;
    finalConfidence = Math.max(0, confidence - penalty);
    return {
        data: merged,
        confidence: finalConfidence,
        status,
        isTimeEstimated,
    };
};
//# sourceMappingURL=extraction.service.js.map