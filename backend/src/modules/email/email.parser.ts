export type VenueMeta = { value: string | null; isExplicit: boolean };

type ExtractedData = {
  company: string;
  stage: string;
  date: string | null | undefined;
  time: string | null;
  venue: VenueMeta;
};

// ---------------- CLEAN ----------------

// Where the message being read stops and the thread it replies to begins.
//
// A reply carries the full history below it, and that history is full of real,
// well-formed dates belonging to OTHER events. Both extractors read the whole
// body, so those dates are indistinguishable from the current one: a Bajaj Auto
// reply whose only explicit year lived in its quoted header
// ("On Tue, Jul 29, 2025 at 2:30 PM ... wrote:") produced an Interview event on
// 2025-07-29, a date that appears nowhere in the message anyone actually sent.
//
// The alternatives, in order:
//   1. Gmail / Apple Mail attribution. `[\s\S]{0,300}?` spans newlines because
//      the line wraps in practice — the real Bajaj body broke immediately
//      before "wrote:", so a single-line `^On .* wrote:$` misses it. Lazy and
//      bounded so it cannot run away across an entire body.
//   2. Gmail forward separator ("---------- Forwarded message ---------").
//   3. Outlook original-message separator ("-----Original Message-----").
//   4. Outlook header block: a "From:" line followed shortly by "Sent:"/"Date:".
//      Requiring the second line keeps a prose "From:" from cutting the body.
//   5. Any quoted line, and the RFC 3676 signature delimiter ("-- ").
//
// This must run BEFORE the newline collapse below: every alternative is
// line-anchored, and flattening newlines destroys the structure it needs.
const QUOTE_BOUNDARY = new RegExp(
  [
    String.raw`^On\s[\s\S]{0,300}?\bwrote:`,
    String.raw`^\s*-{2,}\s*Forwarded message`,
    String.raw`^\s*-{2,}\s*Original Message\s*-{2,}`,
    String.raw`^From:[^\n]*\n(?:[^\n]*\n){0,3}?\s*(?:Sent|Date):`,
    String.raw`^>`,
    String.raw`^--\s*$`,
  ].join("|"),
  "mi",
);

export const cleanEmail = (text: string): string => {
  if (!text) return "";

  const boundary = text.search(QUOTE_BOUNDARY);

  // Falling back to the full text when the cut leaves nothing is deliberate.
  // A bare forward — no covering note, quoted history only — would otherwise
  // clean to "" and lose an event the pipeline extracts correctly today. The
  // old behaviour is the safe floor: never return less than nothing useful.
  const head = boundary === -1 ? text : text.slice(0, boundary);
  const body = head.trim().length > 0 ? head : text;

  return body.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
};

// ---------------- DATE ----------------
export const extractExactDate = (text: string): Date | null => {
  // Capture optional 4-digit year after the month name (e.g. "16th August 2025")
  const regex =
    /(\d{1,2})(st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{4})?/i;

  const match = text.match(regex);
  if (!match?.[1] || !match?.[3]) return null;

  const day = parseInt(match[1], 10);
  const monthStr = match[3].toLowerCase();

  const months: Record<string, number> = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };

  const month = months[monthStr];
  if (month === undefined) return null;

  // Use explicit year from email if present; otherwise fall back to current year (no future-bump)
  const year = match[4] ? parseInt(match[4], 10) : new Date().getUTCFullYear();

  return new Date(Date.UTC(year, month, day));
};

export const extractRelativeDate = (text: string): Date | null => {
  const now = new Date();

  if (/tomorrow/i.test(text)) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }

  if (/next week/i.test(text)) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    d.setUTCDate(d.getUTCDate() + 7);
    return d;
  }

  return null;
};

export const resolveDate = (text: string): Date | null => {
  return extractExactDate(text) || extractRelativeDate(text);
};

// ---------------- COMPANY ----------------

// The placeholder `extractCompany` and `extractData` substitute when no company
// can be resolved. It records extraction failure; it is not the name of any
// organisation, so nothing downstream may treat it as a company value.
//
// (`extractStage` uses the same spelling for its own unresolved round. They are
// separate sentinels for separate attributes that happen to read alike.)
export const UNRESOLVED_COMPANY = "unknown";

// Whether an extracted company is a real value rather than the placeholder.
// The viability gate uses this so an unresolved company is treated as a missing
// company, which is what the Decision Model already specifies for it.
export const isResolvedCompany = (company: unknown): company is string =>
  typeof company === "string" &&
  company.trim().length > 0 &&
  company.trim().toLowerCase() !== UNRESOLVED_COMPANY;

export const extractCompany = (text: string): string => {
  const lowerText = text.toLowerCase();

  // Pattern 1: "at [Company]" — each word must start with a letter; skip leading "the"
  const atMatch = lowerText.match(
    /\bat\s+(?:the\s+)?([a-z][a-z0-9&.]+(?:\s+[a-z][a-z0-9&.]+){0,3})/,
  );
  if (atMatch?.[1]) {
    let company = atMatch[1].trim();
    company = (company.split(/\b(date|time|venue|note|for|on|the)\b/i)[0] ?? "").trim();
    if (company.length >= 2) return company;
  }

  // Pattern 2: "drive/test/interview/ppt by [Company]" or "conducted/organized by [Company]"
  const byMatch = lowerText.match(
    /\b(?:drive|test|interview|ppt|conducted|organized|hosted)\s+by\s+([a-z][a-z0-9&.]+(?:\s+[a-z][a-z0-9&.]+){0,3})/,
  );
  if (byMatch?.[1]) {
    return byMatch[1].trim();
  }

  // Pattern 3: "[Company] is visiting"
  const visitingMatch = lowerText.match(/([a-z][a-z0-9&.\s]+?)\s+is visiting/);
  if (visitingMatch?.[1]) {
    return visitingMatch[1].trim();
  }

  // Pattern 4: "[Company] is conducting/organizing/hosting"
  const conductingMatch = lowerText.match(
    /([a-z][a-z0-9&.\s]+?)\s+is\s+(?:conducting|organizing|hosting)/,
  );
  if (conductingMatch?.[1]) {
    return conductingMatch[1].trim();
  }

  return "unknown";
};

// ---------------- STAGE ----------------
export const extractStage = (text: string): string => {
  if (/interview/i.test(text)) return "Interview";
  if (/online test|test/i.test(text)) return "OA";
  if (/ppt|pre-placement talk/i.test(text)) return "PPT";
  if (/register|deadline/i.test(text)) return "Registration";
  return "unknown";
};

// ---------------- TIME ----------------
export const extractTime = (text: string): string | null => {
  // Pattern 1: "at 10 AM", "5 PM", "around 3:30 pm"
  const ampmMatch = text.match(
    /\b(?:at\s+|around\s+)?(\d{1,2})(:\d{2})?\s*(am|pm)\b/i,
  );
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
    /\b(?:at|around)\s+(\d{1,2})(:\d{2})?\s*(?:in\s+the\s+)?(morning|afternoon|evening)\b/i,
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
  const inTheMatch = text.match(
    /\b(\d{1,2})(:\d{2})?\s+in\s+the\s+(morning|afternoon|evening)\b/i,
  );
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
const VENUE_NOISE_WORDS = [
  "seating",
  "plan",
  "pfa",
  "please",
  "attached",
  "attachment",
  "find",
];

export const extractVenue = (text: string): VenueMeta => {
  const lowerText = text.toLowerCase();

  // ---------------- 1. EXPLICIT "venue:" (HIGHEST PRIORITY) ----------------
  // Stop at newline, period, or common inline delimiters — handles both raw and cleaned text
  const explicitMatch = text.match(/venue:\s*([^\n\r.]+)/i);
  if (explicitMatch?.[1]) {
    let value = explicitMatch[1].trim().toLowerCase();

    // Strip trailing clauses BEFORE the length check (note/time/date/comma/semicolon)
    value = (value.split(/\b(note|time|date|timing|register)\b/i)[0] ?? "").trim();
    value = (value.split(/[,;]/)[0] ?? "").trim();

    const isInvalidVenue =
      /will be|shared soon|tbd|tba|later|after\s+(the\s+)?ppt|to be\s+(shared|announced|communicated)|will share/i.test(value);

    // Reject noise like "PFA seating plan" (please find attached / seating chart),
    // which is attachment boilerplate rather than an actual venue.
    const hasNoiseWord = VENUE_NOISE_WORDS.some((word) =>
      new RegExp(`\\b${word}\\b`, "i").test(value),
    );

    if (isInvalidVenue || hasNoiseWord || value.length === 0) {
      return { value: null, isExplicit: true };
    }

    // Length check AFTER cleanup so "TPO Note: ..." doesn't fail here
    if (value.length > 30) {
      return { value: null, isExplicit: true };
    }

    // remove punctuation
    value = value.replace(/[^a-zA-Z0-9\s]/g, "");

    // keep only first 2 words
    value = value.split(" ").slice(0, 2).join(" ");

    return { value, isExplicit: true };
  }

  // ---------------- 2. KNOWN ONLINE PLATFORMS ----------------
  const knownMatch = lowerText.match(
    /(hackerrank|hackerearth|zoom|google meet|teams|online|offline|classroom|campus)/i,
  );
  if (knownMatch) {
    return { value: knownMatch[0], isExplicit: true };
  }

  // ---------------- 3. "at ..." PATTERN ----------------
  const atMatch = lowerText.match(/\bat\s+([a-zA-Z][a-zA-Z0-9\s]{1,30})/);

  if (atMatch?.[1]) {
    const venue = atMatch[1].trim();

    // 🚨 CRITICAL GUARD: avoid company names being treated as venue
    if (/software|technologies|solutions|labs|systems|company/i.test(venue)) {
      return { value: null, isExplicit: false };
    }

    // Avoid numbers (like "at 10 AM")
    if (/\d/.test(venue)) {
      return { value: null, isExplicit: false };
    }

    return { value: venue, isExplicit: false };
  }

  // ---------------- 4. KNOWN PHYSICAL LOCATIONS ----------------
  const knownLocations = [
    "tpo",
    "auditorium",
    "seminar hall",
    "lecture hall",
    "room",
  ];

  for (const loc of knownLocations) {
    if (lowerText.includes(loc)) {
      return { value: loc, isExplicit: false };
    }
  }

  // ---------------- DEFAULT ----------------
  return { value: null, isExplicit: false };
};

const isValidCompany = (company: string) => {
  if (!company || company === "unknown") return false;

  // reject obvious noise words
  if (/^(for|the|list|students|all|our|dear|you|this)$/i.test(company)) return false;

  // require at least 2 chars — single-word companies like Google/TCS/Amazon are valid
  if (company.length < 2) return false;

  return true;
};

// ---------------- MAIN ----------------
export const extractData = (text: string): ExtractedData => {
  const cleaned = cleanEmail(text);

  let company = extractCompany(cleaned);

  if (!isValidCompany(company)) {
    company = "unknown";
  }

  const dateObj = resolveDate(cleaned);

  return {
    company,
    stage: extractStage(cleaned),
    date: dateObj ? dateObj.toISOString().split("T")[0] : null,
    time: extractTime(cleaned),
    venue: extractVenue(text), // raw text: preserve newlines so "venue:\s*[^\n\r]+" stops correctly
  };
};
