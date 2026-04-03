import type { EmailInput } from "./email.types";
import { cleanEmail } from "./email.parser";
import { extract } from "../extraction/extraction.service";
import { matchEventV2 } from "../matching/matching.service";

import { createEventService, updateEventService } from "../event/event.service";

export const processEmail = async (email: EmailInput) => {
  const cleanText = cleanEmail(email.body).toLowerCase();

  const { data } = await extract(cleanText);

  if (!data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    throw new Error("Invalid date extracted");
  }

  const matchResult = await matchEventV2(data);

  if (matchResult && matchResult.event) {
    return updateEventService(matchResult.event.id, matchResult.event, data);
  }

  return createEventService(data);
};
