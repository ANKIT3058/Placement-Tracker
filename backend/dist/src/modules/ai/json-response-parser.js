import { MalformedResponseError } from "./ai-errors.js";
// Turns a model's raw text reply into a typed object. It performs the exact two
// steps every existing AI service does by hand — strip markdown code fences,
// then JSON.parse — and centralizes them so the behaviour is defined in one
// place. On parse failure it throws a typed MalformedResponseError (carrying the
// raw text) instead of a bare Error.
export class JsonResponseParser {
    // Parse raw model text into T. The type parameter is a caller-side assertion:
    // this method validates that the text is JSON, not that it matches T. Callers
    // that need field-level validation (as the current services do) still
    // normalize the result afterwards.
    parse(raw) {
        const clean = this.stripCodeFences(raw);
        try {
            return JSON.parse(clean);
        }
        catch (error) {
            throw new MalformedResponseError("Invalid JSON from AI provider", raw, {
                cause: error,
            });
        }
    }
    // Remove ```json / ``` markdown fences the model sometimes wraps around JSON.
    // Byte-for-byte identical to the inline cleanup the existing services use, so
    // migrating callers see no change:
    //   content.replace(/```json/g, "").replace(/```/g, "").trim()
    stripCodeFences(raw) {
        return raw
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();
    }
}
// Shared stateless instance for callers that don't need their own.
export const jsonResponseParser = new JsonResponseParser();
//# sourceMappingURL=json-response-parser.js.map