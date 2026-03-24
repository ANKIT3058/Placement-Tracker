import type { EmailInput } from "./email.types";
import { cleanEmail, extractData } from "./email.parser";
import { createEventService, upsertEventService } from "../event/event.service";

export const processEmail = async (email: EmailInput) => {
  const cleanText = cleanEmail(email.body);

  const extracted = extractData(cleanText);

  if (!extracted.date) {
    throw new Error("Date not found in email");
  }

  return upsertEventService({
    company: extracted.company,
    stage: extracted.stage,
    date: extracted.date.toISOString(),
  });
};
