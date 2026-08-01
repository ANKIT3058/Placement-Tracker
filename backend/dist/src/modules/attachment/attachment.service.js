import { enqueueAttachmentProcessing } from "./attachment.queue.js";
import { getPendingAttachmentsByEmailId } from "./attachment.repository.js";
// Enqueue a processing job for every not-yet-completed attachment on an email.
// Called from the email worker AFTER the email has been processed successfully;
// processing is fully decoupled from AI extraction and event matching.
//
// The per-attachment work itself lives in DocumentProcessingService, invoked by
// the attachment worker when it picks up each job.
export const enqueueAttachmentJobs = async (emailId) => {
    const attachments = await getPendingAttachmentsByEmailId(emailId);
    for (const attachment of attachments) {
        await enqueueAttachmentProcessing(attachment.id);
    }
    return attachments.length;
};
//# sourceMappingURL=attachment.service.js.map