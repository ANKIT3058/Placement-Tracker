import OpenAI from "openai";
import { extractData } from "../email/email.parser";
import {
  mergeExtraction,
  calculateConfidence,
  getExtractionStatus,
  detectEstimatedTime,
} from "./extraction.utils";
import { saveExtraction } from "./extraction.repository";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const extractWithAI = async (text: string) => {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
You are an information extraction system.

Extract structured data from placement emails.

Rules:
- Convert dates like "20th Aug" → "YYYY-MM-DD"
- Assume current year if not provided
- Convert vague times:
  - "morning" → "10:00"
  - "afternoon" → "14:00"
  - "evening" → "18:00"
- If time is approximate, still return best guess (DO NOT return null)
- Extract platform as venue (e.g., HackerRank, Zoom)

Return STRICT JSON only:
{
  "company": string,
  "stage": "OA" | "Interview" | "PPT" | "Registration",
  "date": "YYYY-MM-DD",
  "time": string | null,
  "venue": string | null
}
`,
      },
      {
        role: "user",
        content: text,
      },
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

  try {
    return JSON.parse(cleanContent);
  } catch {
    throw new Error("Invalid JSON from OpenAI");
  }
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

  regexData = extractData(text);

  const merged = mergeExtraction(aiData || {}, regexData);

  const baseConfidence = calculateConfidence(merged);

  const confidence = aiData ? baseConfidence : baseConfidence * 0.7; // degrade confidence

  const status = getExtractionStatus(merged);

  const isTimeEstimated = detectEstimatedTime(text);

  // SAVE TO DB
  await saveExtraction({
    company: merged.company,
    stage: merged.stage,
    date: merged.date ? new Date(merged.date) : null,
    time: merged.time,
    venue: merged.venue,
    isTimeEstimated,
    confidence,
    status,
    rawText: text,
  });

  return {
    data: merged,
    confidence,
    status,
  };
};
