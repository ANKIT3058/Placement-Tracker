import { cleanEmail } from "./email.parser.js";
import { extract } from "../extraction/extraction.service.js";
import { matchEventV2 } from "../matching/matching.service.js";
import { CONFIDENCE_THRESHOLD } from "../../shared/constants/config.js";
import { createExtraction } from "../extraction/extraction.repository.js";
import { updateEmailStatus } from "./email.repository.js";
import { EMAIL_STATUS } from "../../shared/constants/email.constants.js";
import { createEventService, updateEventService, } from "../event/event.service.js";
export const processEmail = async (email, emailId) => {
    if (!email) {
        throw new Error("Email text is required");
    }
    const cleanText = cleanEmail(email.body).toLowerCase();
    const { data, confidence, status, isTimeEstimated } = await extract(cleanText);
    const isLowConfidence = confidence < CONFIDENCE_THRESHOLD;
    console.log("CONFIDENCE FLOW:", {
        extracted: confidence,
    });
    const enrichedData = { ...data, confidence };
    await createExtraction({
        emailId,
        company: enrichedData.company,
        stage: enrichedData.stage,
        date: enrichedData.date ? new Date(enrichedData.date) : undefined,
        time: enrichedData.time,
        venue: enrichedData.venue,
        isTimeEstimated: isTimeEstimated,
        confidence: enrichedData.confidence,
        rawText: email.body,
    });
    if (!data.company || !data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
        await updateEmailStatus(emailId, EMAIL_STATUS.IGNORED);
        return;
    }
    const matchResult = await matchEventV2(enrichedData);
    if (isLowConfidence) {
        console.log("LOW CONFIDENCE DETECTED");
        // Option 1 (safe): only create, no update
        return createEventService({
            ...enrichedData,
            status: "review",
            reviewReason: `Low confidence: missing ${!data.company
                ? "company"
                : !data.venue
                    ? "venue"
                    : !data.time
                        ? "time"
                        : "uncertain data"}`,
        });
    }
    if (matchResult && matchResult.event) {
        const result = updateEventService(matchResult.event.id, matchResult.event, enrichedData);
        await updateEmailStatus(emailId, EMAIL_STATUS.COMPLETED);
        return result;
    }
    const result = await createEventService(enrichedData);
    await updateEmailStatus(emailId, EMAIL_STATUS.COMPLETED);
    return result;
};
//# sourceMappingURL=email.service.js.map