export const cleanEmail = (text: string): string => {
  return text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
};

const parseDate = (text: string): Date | null => {
  let match = text.match(/(\d{1,2}\s\w+\s\d{4})/);

  if (match) {
    return new Date(match[0] + " GMT+0530");
  }

  match = text.match(/(\d{1,2}\s\w+)/);

  if (match) {
    const currentYear = new Date().getFullYear();
    return new Date(`${match[0]} ${currentYear} GMT+0530`);
  }

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

  const date = parseDate(text);
  const time = extractTime(text);
  const venue = extractVenue(text);

  return {
    company: companyMatch ? companyMatch[0] : "Unknown",
    stage,
    date,
    time,
    venue,
  };
};

const extractTime = (text: string): string | null => {
  const match = text.match(/\b(\d{1,2}(:\d{2})?\s?(AM|PM))\b/i);
  return match ? match[1]!.toUpperCase() : null;
};

const extractVenue = (text: string): string | null => {
  // Common patterns:
  // "Venue: XYZ", "Location: XYZ", "Platform: XYZ"
  const match = text.match(/\b(venue|location|platform)\s*:\s*([^\n,]+)/i);

  return match ? match[2]!.trim() : null;
};
