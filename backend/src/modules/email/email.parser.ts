export type VenueMeta = { value: string | null; isExplicit: boolean };

type ExtractedData = {
  company: string;
  stage: string;
  date: string | null | undefined;
  time: string | null;
  venue: VenueMeta;
};

// ---------------- CLEAN ----------------
export const cleanEmail = (text: string): string => {
  return text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
};

// ---------------- DATE ----------------
export const extractExactDate = (text: string): Date | null => {
  const regex =
    /(\d{1,2})(st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

  const match = text.match(regex);
  if (!match) return null;

  if (!match || !match[1] || !match[3]) return null;

  const day = parseInt(match[1], 10);
  const monthStr = match[3].toLowerCase();

  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  const month = months[monthStr];
  if (month === undefined) return null;

  const now = new Date();
  let year = now.getUTCFullYear();

  const date = new Date(Date.UTC(year, month, day));
  if (date < now) year += 1;

  return new Date(Date.UTC(year, month, day));
};

export const extractRelativeDate = (text: string): Date | null => {
  const now = new Date();

  if (/tomorrow/i.test(text)) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }

  if (/next week/i.test(text)) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 7);
    return d;
  }

  return null;
};

export const resolveDate = (text: string): Date | null => {
  return extractExactDate(text) || extractRelativeDate(text);
};

// ---------------- COMPANY ----------------
export const extractCompany = (text: string): string => {
  const match = text.match(
    /([A-Z][a-zA-Z0-9&.\s]+?)\s+(OA|online assessment|interview|ppt)/i
  );

  if (match && match[1]) {
    return match[1].trim().toLowerCase();
  }

  return "unknown";
};

// ---------------- STAGE ----------------
export const extractStage = (text: string): string => {
  if (/online assessment|oa/i.test(text)) return "OA";
  if (/interview/i.test(text)) return "Interview";
  if (/ppt/i.test(text)) return "PPT";
  return "unknown";
};

// ---------------- TIME ----------------
export const extractTime = (text: string): string | null => {
  // Pattern 1: "at 10 AM", "5 PM", "around 3:30 pm"
  const ampmMatch = text.match(/\b(?:at\s+|around\s+)?(\d{1,2})(:\d{2})?\s*(am|pm)\b/i);
  if (ampmMatch?.[1] && ampmMatch?.[3]) {
    let hour = parseInt(ampmMatch[1], 10);
    const minutes = ampmMatch[2] ?? ":00";
    const period = ampmMatch[3].toLowerCase();
    if (period === "pm" && hour !== 12) hour += 12;
    if (period === "am" && hour === 12) hour = 0;
    return `${hour.toString().padStart(2, "0")}${minutes}`;
  }

  // Pattern 2a: "at 5 morning/afternoon/evening", "at 10 in the evening"
  const atContextMatch = text.match(
    /\b(?:at|around)\s+(\d{1,2})(:\d{2})?\s*(?:in\s+the\s+)?(morning|afternoon|evening)\b/i
  );
  if (atContextMatch?.[1] && atContextMatch?.[3]) {
    let hour = parseInt(atContextMatch[1], 10);
    const minutes = atContextMatch[2] ?? ":00";
    const context = atContextMatch[3].toLowerCase();
    if (context === "afternoon" || context === "evening") {
      if (hour !== 12) hour += 12;
    }
    return `${hour.toString().padStart(2, "0")}${minutes}`;
  }

  // Pattern 2b: "5 in the evening" (no leading "at")
  const inTheMatch = text.match(/\b(\d{1,2})(:\d{2})?\s+in\s+the\s+(morning|afternoon|evening)\b/i);
  if (inTheMatch?.[1] && inTheMatch?.[3]) {
    let hour = parseInt(inTheMatch[1], 10);
    const minutes = inTheMatch[2] ?? ":00";
    const context = inTheMatch[3].toLowerCase();
    if (context === "afternoon" || context === "evening") {
      if (hour !== 12) hour += 12;
    }
    return `${hour.toString().padStart(2, "0")}${minutes}`;
  }

  // Fallback: standalone time-of-day words
  if (/\bmorning\b/i.test(text)) return "10:00";
  if (/\bafternoon\b/i.test(text)) return "14:00";
  if (/\bevening\b/i.test(text)) return "18:00";

  return null;
};

// ---------------- VENUE ----------------
const VENUE_NOISE_WORDS = ["seating", "plan", "pfa", "please", "attached", "attachment", "find"];

export const extractVenue = (text: string): VenueMeta => {
  const lowerText = text.toLowerCase();

  // Known platforms are unambiguous and always explicit
  const knownMatch = lowerText.match(
    /(hackerrank|hackerearth|zoom|google meet|teams|online|offline|classroom|campus)/i
  );
  if (knownMatch) return { value: knownMatch[0], isExplicit: true };

  // "venue:" keyword is a strong explicit signal — even a rejected value is explicit
  const hasVenueKeyword = /\bvenue:/i.test(lowerText);

  const patternMatch = lowerText.match(
    /(?:at|venue:)\s*([a-zA-Z0-9]+(?:\s+[a-zA-Z0-9]+){0,2})/i
  );
  if (patternMatch) {
    const venue = patternMatch[1]?.trim();
    const words = venue?.split(/\s+/) ?? [];
    const isAmbiguous = VENUE_NOISE_WORDS.some((w) => words.includes(w));
    if (venue && !/\d/.test(venue) && !isAmbiguous) {
      return { value: venue, isExplicit: true };
    }
    // Value rejected — only treat as explicit when "venue:" was present.
    // Avoids "at 10 AM" incorrectly clearing an existing venue.
    if (hasVenueKeyword) {
      return { value: null, isExplicit: true };
    }
  }

  // Known physical locations without an explicit keyword
  const knownLocations = ["tpo", "auditorium", "seminar hall", "lecture hall", "room"];
  for (const loc of knownLocations) {
    if (lowerText.includes(loc)) return { value: loc, isExplicit: false };
  }

  return { value: null, isExplicit: false };
};

// ---------------- MAIN ----------------
export const extractData = (text: string): ExtractedData => {
  const cleaned = cleanEmail(text);

  const dateObj = resolveDate(cleaned);

  return {
    company: extractCompany(cleaned),
    stage: extractStage(cleaned),
    date: dateObj ? dateObj.toISOString().split("T")[0] : null,
    time: extractTime(cleaned),
    venue: extractVenue(cleaned), // VenueMeta
  };
};