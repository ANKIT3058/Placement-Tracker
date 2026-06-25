import { getMessageDetails, parseMessage, getLatestHistoryId, getRecentMessages, getHistoryChanges, } from "./gmail.service.js";
import { createEmail, getEmailByGmailMessageId, } from "../email/email.repository.js";
import { enqueueEmailProcessing } from "../email/email.producer.js";
import { updateHistoryId } from "./gmail.repository.js";
export const syncSingleMessage = async (refreshToken, gmailMessageId) => {
    const details = await getMessageDetails(refreshToken, gmailMessageId);
    const parsed = parseMessage(details);
    if (parsed.messageId) {
        const existing = await getEmailByGmailMessageId(parsed.messageId);
        if (existing) {
            return { status: "duplicate", emailId: existing.id };
        }
    }
    const savedEmail = await createEmail({
        gmailMessageId: parsed.messageId,
        subject: parsed.subject ?? "",
        body: parsed.body || parsed.snippet || "",
        sender: parsed.sender ?? "",
    });
    await enqueueEmailProcessing(savedEmail.id);
    return { status: "created", emailId: savedEmail.id };
};
const isHistoryIdExpired = (error) => {
    const candidate = error;
    return (candidate?.code === 404 ||
        candidate?.status === 404 ||
        candidate?.response?.status === 404);
};
const processMessages = async (refreshToken, messageIds) => {
    let processed = 0;
    let duplicates = 0;
    let queued = 0;
    let failed = 0;
    for (const messageId of messageIds) {
        try {
            const result = await syncSingleMessage(refreshToken, messageId);
            if (result.status === "duplicate") {
                duplicates += 1;
            }
            else {
                processed += 1;
                queued += 1;
            }
        }
        catch (error) {
            failed += 1;
            console.error(`Failed to sync message ${messageId}`, error);
        }
    }
    return { processed, duplicates, queued, failed };
};
// Per-account incremental sync flow. Extracted from gmailSyncController so the
// background scheduler can reuse the exact same logic without duplication.
export const syncGmailAccount = async (account) => {
    const refreshToken = account.refreshToken;
    // Capture the watermark BEFORE listing so messages arriving mid-sync are
    // picked up by the next incremental run (overlap is safe, gaps are not).
    const runFullSync = async () => {
        const latestHistoryId = await getLatestHistoryId(refreshToken);
        const messages = await getRecentMessages(refreshToken);
        const messageIds = messages
            .map((message) => message.id)
            .filter((id) => Boolean(id));
        const stats = await processMessages(refreshToken, messageIds);
        return {
            mode: "full",
            totalFetched: messages.length,
            stats,
            latestHistoryId,
        };
    };
    let result;
    if (!account.historyId) {
        result = await runFullSync();
    }
    else {
        try {
            const { messageIds, latestHistoryId } = await getHistoryChanges(refreshToken, account.historyId);
            const stats = await processMessages(refreshToken, messageIds);
            result = {
                mode: "incremental",
                totalFetched: messageIds.length,
                stats,
                latestHistoryId,
            };
        }
        catch (error) {
            if (!isHistoryIdExpired(error)) {
                throw error;
            }
            console.warn(`History ID ${account.historyId} expired, falling back to full sync`);
            result = await runFullSync();
        }
    }
    await updateHistoryId(account.email, result.latestHistoryId);
    return result;
};
//# sourceMappingURL=gmail.sync.service.js.map