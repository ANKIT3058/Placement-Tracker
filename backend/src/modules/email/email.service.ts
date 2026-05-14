import type { EmailInput } from "./email.types.js";
import { cleanEmail } from "./email.parser.js";
import { extract } from "../extraction/extraction.service.js";
import { matchEventV2 } from "../matching/matching.service.js";
import { CONFIDENCE_THRESHOLD } from "../../shared/constants/config.js";

import { createEventService, updateEventService } from "../event/event.service.js";

export const processEmail = async (email: EmailInput) => {
  if (!email) {
    throw new Error("Email text is required");
  }
  const cleanText = cleanEmail(email.body).toLowerCase();

  const { data, confidence } = await extract(cleanText);
  const isLowConfidence = confidence < CONFIDENCE_THRESHOLD;

  console.log("CONFIDENCE FLOW:", {
    extracted: confidence,
  });

  if (!data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    throw new Error("Invalid date extracted");
  }

  const enrichedData = { ...data, confidence };

  const matchResult = await matchEventV2(enrichedData);

  if (isLowConfidence) {
    console.log("LOW CONFIDENCE DETECTED");

    // Option 1 (safe): only create, no update
    return createEventService({
      ...enrichedData,
      status: "review",
      reviewReason: `Low confidence: missing ${
        !data.company
          ? "company"
          : !data.venue
            ? "venue"
            : !data.time
              ? "time"
              : "uncertain data"
      }`,
    });
  }

  if (matchResult && matchResult.event) {
    return updateEventService(
      matchResult.event.id,
      matchResult.event,
      enrichedData,
    );
  }

  return createEventService(enrichedData);
};
