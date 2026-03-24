export const cleanEmail = (text: string): string => {
  return text
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const parseDate = (text: string): Date | null => {
  // Case 1: 20 Aug 2025
  let match = text.match(/(\d{1,2}\s\w+\s\d{4})/);

  if (match) {
    return new Date(match[0]);
  }

  // Case 2: 20 Aug (no year)
  match = text.match(/(\d{1,2}\s\w+)/);

  if (match) {
    const currentYear = new Date().getFullYear();
    return new Date(`${match[0]} ${currentYear}`);
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

  return {
    company: companyMatch ? companyMatch[0] : "Unknown",
    stage,
    date,
  };
};
