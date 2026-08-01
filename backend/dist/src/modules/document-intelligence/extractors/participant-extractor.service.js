import { getOpenAIClient } from "../../extraction/extraction.service.js";
import { DOCUMENT_TYPE } from "../document-type.js";
import { PARTICIPANT_EXTRACTION_SYSTEM_PROMPT, buildParticipantExtractionUserPrompt, } from "../prompts/participant-extraction.prompt.js";
// The document types that describe participants. Only these are sent to the
// model; any other classification short-circuits to an empty result.
const PARTICIPANT_DOCUMENT_TYPES = new Set([
    DOCUMENT_TYPE.SHORTLIST,
    DOCUMENT_TYPE.SEATING_ARRANGEMENT,
    DOCUMENT_TYPE.RESULT,
]);
// An empty ParticipantInformation means "no participants understood". Returned
// for non-participant documents and on any failure.
const EMPTY_PARTICIPANT_INFORMATION = {
    participants: [],
};
// Turns a participant-related parsed document into ParticipantInformation. It
// reuses the shared OpenAI client and infers NO student model — it preserves
// whatever attributes the document listed, verbatim, with no required fields.
//
// It fails independently: any error degrades to an empty ParticipantInformation
// so the wider pipeline keeps running.
export class ParticipantExtractor {
    async extract(parsed, classification) {
        // Only participant documents produce participant information.
        if (!PARTICIPANT_DOCUMENT_TYPES.has(classification.documentType)) {
            return EMPTY_PARTICIPANT_INFORMATION;
        }
        const text = parsed.text?.trim();
        if (!text) {
            return EMPTY_PARTICIPANT_INFORMATION;
        }
        try {
            const raw = await this.requestExtraction(text);
            return this.normalizeResult(raw);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            console.error("Participant extraction failed:", message);
            return EMPTY_PARTICIPANT_INFORMATION;
        }
    }
    async requestExtraction(text) {
        const openai = getOpenAIClient();
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: PARTICIPANT_EXTRACTION_SYSTEM_PROMPT },
                { role: "user", content: buildParticipantExtractionUserPrompt(text) },
            ],
            temperature: 0,
        });
        const content = response.choices?.[0]?.message?.content;
        if (!content) {
            throw new Error("Empty response from OpenAI");
        }
        const cleanContent = content
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();
        return JSON.parse(cleanContent);
    }
    // Coerce the model's output into valid ParticipantInformation. Non-array
    // participants become []; each entry keeps only string attributes with
    // non-empty keys. Nothing is assumed to be required — an entry with no usable
    // attributes is dropped.
    normalizeResult(raw) {
        if (!Array.isArray(raw.participants)) {
            return { participants: [] };
        }
        const participants = [];
        for (const entry of raw.participants) {
            const attributes = this.normalizeAttributes(entry);
            if (Object.keys(attributes).length > 0) {
                participants.push({ attributes });
            }
        }
        return { participants };
    }
    // Extract the string-valued attributes from one raw entry. Accepts either
    // `{ attributes: {...} }` or a bare `{...}` object, coercing scalar values to
    // strings and skipping nulls/objects so a bad cell never breaks the row.
    normalizeAttributes(entry) {
        if (entry === null || typeof entry !== "object")
            return {};
        const source = entry.attributes;
        const bag = source !== null && typeof source === "object"
            ? source
            : entry;
        const attributes = {};
        for (const [key, value] of Object.entries(bag)) {
            const label = key.trim();
            if (!label)
                continue;
            if (typeof value === "string") {
                const v = value.trim();
                if (v)
                    attributes[label] = v;
            }
            else if (typeof value === "number" || typeof value === "boolean") {
                attributes[label] = String(value);
            }
        }
        return attributes;
    }
}
// Shared singleton for callers that don't need their own instance.
export const participantExtractor = new ParticipantExtractor();
//# sourceMappingURL=participant-extractor.service.js.map