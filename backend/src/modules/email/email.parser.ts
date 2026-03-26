export const cleanEmail = (text: string): string => {
  return text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
};

export const extractExactDate = (text: string): Date | null => {
  const regex =
    /(\d{1,2})(st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

  const match = text.match(regex);
  if (!match) return null;

  const [, dayStr, , monthStrRaw] = match;

  if (!dayStr || !monthStrRaw) return null;

  const day = parseInt(dayStr, 10);
  const monthStr = monthStrRaw.toLowerCase();

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

  const now = new Date();
  let year = now.getFullYear();

  const date = new Date(Date.UTC(year, month, day));

  if (date < now) {
    year += 1;
  }

  return new Date(Date.UTC(year, month, day));
};

export const extractRelativeDate = (text: string) => {
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

export const resolveDate = (text: string) => {
  const exact = extractExactDate(text);
  const relative = extractRelativeDate(text);

  if (exact) return exact; // priority
  if (relative) return relative;

  return null;
};

export const extractData = (text: string) => {
  // COMPANY (simple match)
  const companyMatch = text.match(/(Amazon|Google|Microsoft|Flipkart)/i);

  // STAGE
  let stage = "unknown";
  if (/online assessment|oa/i.test(text)) stage = "OA";
  else if (/interview/i.test(text)) stage = "Interview";
  else if (/ppt/i.test(text)) stage = "PPT";

  const dateObj = resolveDate(text);
  const time = extractTime(text);
  const venue = extractVenue(text);

  console.log("email.parser.ts dateObj", dateObj);

  return {
    company: companyMatch ? companyMatch[0].toLowerCase().trim() : "unknown",
    stage,
    date: dateObj ? dateObj.toISOString().split("T")[0] : null,
    time,
    venue,
  };
};

export const extractTime = (text: string) => {
  // Check for contextual words combined with numbers first
  const contextualNumberRegex =
    /(at|around)?\s*(\d{1,2})(:\d{2})?\s*(in\s+the\s+)?(morning|afternoon|evening)/i;
  const contextMatch = text.match(contextualNumberRegex);

  if (contextMatch) {
    const hourStr = contextMatch[2];
    const minuteStr = contextMatch[3];
    const context = contextMatch[5]?.toLowerCase();

    if (!hourStr || isNaN(parseInt(hourStr, 10))) return null;

    let hour = parseInt(hourStr, 10);
    const minutes = minuteStr || ":00";

    // Apply context: morning = AM, afternoon/evening = PM
    if (context === "morning" && hour !== 12) {
      // Keep as-is for AM
    } else if (
      (context === "afternoon" || context === "evening") &&
      hour !== 12
    ) {
      hour += 12;
    }

    return `${hour.toString().padStart(2, "0")}${minutes}`;
  }

  // Exact time with AM/PM: "10 AM", "10:30 PM"
  const exactTimeRegex = /(at|around)?\s*(\d{1,2})(:\d{2})?\s*(am|pm)/i;
  const exactMatch = text.match(exactTimeRegex);

  if (exactMatch) {
    const hourStr = exactMatch[2];
    const minuteStr = exactMatch[3];
    const period = exactMatch[4]?.toLowerCase();

    if (!hourStr || isNaN(parseInt(hourStr, 10))) return null;

    let hour = parseInt(hourStr, 10);
    const minutes = minuteStr || ":00";

    if (period === "pm" && hour !== 12) hour += 12;
    if (period === "am" && hour === 12) hour = 0;

    return `${hour.toString().padStart(2, "0")}${minutes}`;
  }

  // Vague time only (no numbers)
  if (/\bmorning\b/i.test(text)) return "10:00";
  if (/\bafternoon\b/i.test(text)) return "14:00";
  if (/\bevening\b/i.test(text)) return "18:00";

  return null;
};

export const extractVenue = (text: string) => {
  const venueRegex =
    /(hackerrank|hackerearth|zoom|google meet|teams|online|offline|classroom|campus)/i;

  const match = text.match(venueRegex);

  return match ? match[0].toLowerCase() : null;
};
