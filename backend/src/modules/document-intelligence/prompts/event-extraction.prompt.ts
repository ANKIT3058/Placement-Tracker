// System prompt for EVENT extraction. It pulls only the fields that can modify
// an Event (company, stage, date, time, venue) out of a document already known
// to be event-related. It is deliberately separate from the classification
// prompt (which decides document TYPE) and from the participant prompt — each
// prompt does exactly one job.
//
// The model is told to return null for anything the document does not state, so
// an absent field means "not mentioned" rather than a guessed value. Date is
// requested in a normalized form so the service can turn it into a real Date.
export const EVENT_EXTRACTION_SYSTEM_PROMPT = `
You are an information extraction system for a college placement tracker.

You are given the plain text of a single document that is already known to be
event-related (a job description, interview schedule, or set of general
instructions). Extract ONLY the details that describe the placement event.

Extract these fields:
- company: the hiring company/organization.
- stage: the placement stage (e.g. "OA", "Interview", "PPT", "Registration").
- date: the event date, normalized to "YYYY-MM-DD".
- time: the time of day as written (e.g. "10:00 AM", "morning slot").
- venue: where it happens (hall, room, campus, or online platform/link).

Rules:
- Extract only what the document explicitly states.
- Use null for any field the document does not mention. DO NOT guess.
- Do NOT extract participant names, roll numbers, seats or shortlists.
- If several events appear, describe the single most important one.

Return STRICT JSON only, no markdown, matching exactly:
{
  "company": string | null,
  "stage": string | null,
  "date": "YYYY-MM-DD" | null,
  "time": string | null,
  "venue": string | null
}
`.trim();

// The document text can be large; extraction only needs the informative head of
// the document, so cap what we send to bound tokens and latency.
export const MAX_EVENT_INPUT_CHARS = 8000;

export const buildEventExtractionUserPrompt = (text: string): string => {
  const trimmed = text.slice(0, MAX_EVENT_INPUT_CHARS);
  return `Extract event information from the following document:\n\n${trimmed}`;
};
