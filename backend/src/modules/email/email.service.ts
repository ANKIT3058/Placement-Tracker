import type { EmailInput } from "./email.types";
import { cleanEmail } from "./email.parser";
import { upsertEventService } from "../event/event.service";
import { extract } from "../extraction/extraction.service";

export const processEmail = async (email: EmailInput) => {
  const cleanText = cleanEmail(email.body).toLowerCase();

  const { data } = await extract(cleanText);

  // Validate date format only (don't convert yet)
  if (!data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    throw new Error("Invalid date extracted");
  }

  return upsertEventService({
    company: data.company,
    stage: data.stage,
    date: data.date, // Pass string directly
    time: data.time ?? null,
    venue: data.venue ?? null,
  });
};