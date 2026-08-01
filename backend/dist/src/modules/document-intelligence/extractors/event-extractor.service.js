import { getOpenAIClient } from "../../extraction/extraction.service.js";
import { DOCUMENT_TYPE } from "../document-type.js";
import { EVENT_EXTRACTION_SYSTEM_PROMPT, buildEventExtractionUserPrompt, } from "../prompts/event-extraction.prompt.js";
// The document types that carry event-affecting information. Only these are sent
// to the model; any other classification short-circuits to an empty result.
const EVENT_DOCUMENT_TYPES = new Set([
    DOCUMENT_TYPE.JOB_DESCRIPTION,
    DOCUMENT_TYPE.INTERVIEW_SCHEDULE,
    DOCUMENT_TYPE.GENERAL_INSTRUCTIONS,
]);
// An empty EventInformation means "nothing understood". Returned for non-event
// documents and on any failure — every field is simply absent (leave-unchanged).
const EMPTY_EVENT_INFORMATION = {};
// Turns an event-related parsed document into EventInformation. It reuses the
// shared OpenAI client and NEVER modifies events, matches events, or persists
// anything — it only reads a document and returns the event fields it found.
//
// It fails independently: any error degrades to an empty EventInformation so the
// wider pipeline keeps running.
export class EventExtractor {
    async extract(parsed, classification) {
        // Only event documents produce event information.
        if (!EVENT_DOCUMENT_TYPES.has(classification.documentType)) {
            return EMPTY_EVENT_INFORMATION;
        }
        const text = parsed.text?.trim();
        if (!text) {
            return EMPTY_EVENT_INFORMATION;
        }
        try {
            const raw = await this.requestExtraction(text);
            return this.normalizeResult(raw);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            console.error("Event extraction failed:", message);
            return EMPTY_EVENT_INFORMATION;
        }
    }
    async requestExtraction(text) {
        const openai = getOpenAIClient();
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: EVENT_EXTRACTION_SYSTEM_PROMPT },
                { role: "user", content: buildEventExtractionUserPrompt(text) },
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
    // Keep only well-typed, present fields. Absent/null/empty values are dropped
    // so EventInformation carries "leave-unchanged" (undefined) rather than blanks.
    normalizeResult(raw) {
        const result = {};
        const company = this.cleanString(raw.company);
        if (company)
            result.company = company;
        const stage = this.cleanString(raw.stage);
        if (stage)
            result.stage = stage;
        const date = this.parseDate(raw.date);
        if (date)
            result.date = date;
        const time = this.cleanString(raw.time);
        if (time)
            result.time = time;
        const venue = this.cleanString(raw.venue);
        if (venue)
            result.venue = venue;
        return result;
    }
    cleanString(value) {
        if (typeof value !== "string")
            return undefined;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    // Parse the model's "YYYY-MM-DD" string into a Date, ignoring anything that
    // isn't a valid calendar date.
    parseDate(value) {
        const text = this.cleanString(value);
        if (!text)
            return undefined;
        const parsed = new Date(text);
        return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    }
}
// Shared singleton for callers that don't need their own instance.
export const eventExtractor = new EventExtractor();
//# sourceMappingURL=event-extractor.service.js.map