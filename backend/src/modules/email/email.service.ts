import type { EmailInput } from "./email.types.js";
import { cleanEmail, isResolvedCompany } from "./email.parser.js";
import { extract } from "../extraction/extraction.service.js";
import { matchEventV2 } from "../matching/matching.service.js";
import { CONFIDENCE_THRESHOLD } from "../../shared/constants/config.js";
import { createExtraction } from "../extraction/extraction.repository.js";
import { updateEmailStatus } from "./email.repository.js";
import { EMAIL_STATUS } from "../../shared/constants/email.constants.js";
import type { OwnershipContext } from "../auth/tenant-context.js";

import {
  createEventService,
  updateEventService,
} from "../event/event.service.js";

// `owner` bounds every tenant-scoped read and write below. It is threaded
// explicitly rather than read from ambient state so that a call site cannot
// omit it and still compile (RFC-001 §9.2).
export const processEmail = async (
  owner: OwnershipContext,
  email: EmailInput,
  emailId: number,
) => {
  if (!email) {
    throw new Error("Email text is required");
  }
  const cleanText = cleanEmail(email.body).toLowerCase();

  const { data, confidence, status, isTimeEstimated } =
    await extract(cleanText);
  const isLowConfidence = confidence < CONFIDENCE_THRESHOLD;

  console.log("CONFIDENCE FLOW:", {
    extracted: confidence,
  });

  const enrichedData = { ...data, confidence };
  await createExtraction({
    emailId,
    userId: owner.userId,

    company: enrichedData.company,
    stage: enrichedData.stage,

    date: enrichedData.date ? new Date(enrichedData.date) : undefined,
    time: enrichedData.time,
    venue: enrichedData.venue,

    isTimeEstimated: isTimeEstimated,

    confidence: enrichedData.confidence,

    rawText: email.body,
  });

  // VIABILITY GATE (AC-4 / D-10).
  //
  // An observation without identity anchors cannot be reasoned about, so it is
  // abandoned rather than guessed at. `isResolvedCompany` is used instead of a
  // truthiness check because extraction substitutes the literal "unknown" when
  // no company is found, and that string is truthy — it previously satisfied
  // this gate, created a real Event named "unknown", and that Event then became
  // a matching candidate for every later unresolved observation.
  //
  // Treating the placeholder as a missing company is what the Decision Model
  // already specifies for this case; no new outcome is introduced. Abandoning
  // here is also what keeps the placeholder out of the identity key, out of the
  // candidate queries, and out of the database — the gate runs before any of
  // them.
  if (
    !isResolvedCompany(data.company) ||
    !data.date ||
    !/^\d{4}-\d{2}-\d{2}$/.test(data.date)
  ) {
    await updateEmailStatus(emailId, EMAIL_STATUS.IGNORED);
    return;
  }

  const matchResult = await matchEventV2(owner, enrichedData);

  if (isLowConfidence) {
    console.log("LOW CONFIDENCE DETECTED");

    // Option 1 (safe): only create, no update
    return createEventService(owner, {
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
    const result = updateEventService(
      owner,
      matchResult.event.id,
      matchResult.event,
      enrichedData,
    );

    await updateEmailStatus(emailId, EMAIL_STATUS.COMPLETED);

    return result;
  }

  const result = await createEventService(owner, enrichedData);
  await updateEmailStatus(emailId, EMAIL_STATUS.COMPLETED);
  return result;
};
