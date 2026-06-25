import { generateAuthUrl, getTokens, getGmailAddress, } from "./gmail.service.js";
import { createGmailAccount } from "./gmail.repository.js";
import { syncGmailAccount } from "./gmail.sync.service.js";
import { getLatestConnectedGmailAccount } from "./gmail.repository.js";
export const gmailAuthController = (req, res) => {
    const url = generateAuthUrl();
    return res.redirect(url);
};
export const gmailCallbackController = async (req, res) => {
    try {
        const code = req.query.code;
        if (!code) {
            return res.status(400).json({
                success: false,
                message: "Authorization code missing",
            });
        }
        const tokens = await getTokens(code);
        const email = await getGmailAddress(tokens);
        if (!tokens.refresh_token) {
            throw new Error("Refresh token not received");
        }
        if (!email) {
            throw new Error("Unable to retrieve Gmail address");
        }
        await createGmailAccount(email, tokens.refresh_token);
        return res.json({
            success: true,
            email,
        });
    }
    catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            message: "Failed to exchange code",
        });
    }
};
export const gmailSyncController = async (req, res) => {
    const account = await getLatestConnectedGmailAccount();
    if (!account) {
        return res.status(404).json({
            success: false,
        });
    }
    const result = await syncGmailAccount(account);
    console.log({
        mode: result.mode,
        totalFetched: result.totalFetched,
        processed: result.stats.processed,
        duplicates: result.stats.duplicates,
        queued: result.stats.queued,
        failed: result.stats.failed,
        latestHistoryId: result.latestHistoryId,
    });
    return res.json({
        success: true,
        mode: result.mode,
        totalFetched: result.totalFetched,
        processed: result.stats.processed,
        duplicates: result.stats.duplicates,
        queued: result.stats.queued,
        failed: result.stats.failed,
        latestHistoryId: result.latestHistoryId,
    });
};
//# sourceMappingURL=gmail.controller.js.map