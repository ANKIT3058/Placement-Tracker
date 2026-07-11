import { DOCUMENT_TYPE } from "../document-type.js";

// The system prompt that drives classification. Kept in its own file so the
// instruction wording can evolve independently of the service that sends it, and
// so it is obvious this layer ONLY classifies — the prompt never asks the model
// to extract companies, dates or participant lists.
//
// The allowed labels are derived from DOCUMENT_TYPE (upper-cased keys) rather
// than hand-written, so adding a new DocumentType automatically flows into the
// prompt and the two can never drift apart.
const ALLOWED_LABELS = Object.keys(DOCUMENT_TYPE).join("\n- ");

export const CLASSIFICATION_SYSTEM_PROMPT = `
You are a document classification system for a college placement tracker.

You are given the plain text of a single parsed document (originally a PDF or
spreadsheet attached to a placement email). Decide which ONE category best
describes the whole document.

Categories:
- ${ALLOWED_LABELS}

Category meanings:
- JOB_DESCRIPTION: a role/company posting — eligibility, CTC, responsibilities.
- INTERVIEW_SCHEDULE: a timetable of rounds, slots or interview timings.
- GENERAL_INSTRUCTIONS: guidance for participants (dress code, reporting rules).
- SEATING_ARRANGEMENT: a room/seat/lab allocation for a test or interview.
- SHORTLIST: a list of people advanced to a stage.
- RESULT: final or intermediate outcomes (selected / rejected / on-hold).
- UNKNOWN: understood, but fits none of the above, or you are not confident.

Rules:
- Choose exactly one label from the list, spelled EXACTLY as shown.
- Do NOT extract company names, dates, times, venues or participant lists.
- Judge only the document TYPE, not its details.
- Write a concise one- or two-sentence summary of the document's content.
- Give a confidence between 0 and 1 (0 = pure guess, 1 = certain).
- When genuinely unsure, use "UNKNOWN" with a low confidence rather than guessing.

Return STRICT JSON only, no markdown, matching exactly:
{
  "documentType": one of the categories above,
  "confidence": number between 0 and 1,
  "summary": string
}
`.trim();

// The document text can be large; classification only needs enough signal to
// recognize the type, so we cap what we send to keep token usage and latency
// bounded. The head of a document (title, headings, first rows) is the most
// type-revealing part, so a simple head truncation is sufficient.
export const MAX_CLASSIFICATION_INPUT_CHARS = 8000;

// Build the user-message content from a document's normalized text.
export const buildClassificationUserPrompt = (text: string): string => {
  const trimmed = text.slice(0, MAX_CLASSIFICATION_INPUT_CHARS);
  return `Classify the following document:\n\n${trimmed}`;
};
