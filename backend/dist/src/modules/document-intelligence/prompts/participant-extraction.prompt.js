// System prompt for PARTICIPANT extraction. It captures the people a document
// lists (a shortlist, seating arrangement, or result sheet) as generic
// attribute bags — NO student model, NO required fields. Whatever columns/labels
// the document uses become the attribute keys, verbatim. This keeps the layer
// honest ("we recorded what was written") and future-proof across document
// shapes.
//
// It is separate from the classification and event prompts so each stays focused
// on one task.
export const PARTICIPANT_EXTRACTION_SYSTEM_PROMPT = `
You are an information extraction system for a college placement tracker.

You are given the plain text of a single document that is already known to be
participant-related (a shortlist, seating arrangement, or result sheet). Extract
the list of people/parties it mentions.

Represent each participant as a bag of attributes:
- Use the document's OWN column headers or labels as the attribute keys.
- Copy values EXACTLY as they appear — do not reformat, translate or infer.
- There are NO required fields. Include only the attributes actually present for
  that participant. Different rows may have different attributes.
- Do NOT invent a name, id, or any field the document does not provide.
- Do NOT extract event-level details (company, date, venue of the event itself).

Return STRICT JSON only, no markdown, matching exactly:
{
  "participants": [
    { "attributes": { "<label>": "<value>", ... } }
  ]
}

If the document lists no participants, return { "participants": [] }.
`.trim();
// Participant documents (large tables) can be long; cap the input so token use
// and latency stay bounded. This is a coarse safeguard — a future version may
// page through very large tables instead of truncating.
export const MAX_PARTICIPANT_INPUT_CHARS = 12000;
export const buildParticipantExtractionUserPrompt = (text) => {
    const trimmed = text.slice(0, MAX_PARTICIPANT_INPUT_CHARS);
    return `Extract participants from the following document:\n\n${trimmed}`;
};
//# sourceMappingURL=participant-extraction.prompt.js.map