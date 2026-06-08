import { generateAuthUrl, getTokens, getGmailAddress, getRecentMessages, getMessageDetails, parseMessage, } from "./gmail.service.js";
import { createGmailAccount, getGmailAccount } from "./gmail.repository.js";
import { createEmail, getEmailByGmailMessageId, } from "../email/email.repository.js";
import { enqueueEmailProcessing } from "../email/email.producer.js";
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
    const account = await getGmailAccount("ankitkumaranand68@gmail.com");
    if (!account) {
        return res.status(404).json({
            success: false,
        });
    }
    const messages = await getRecentMessages(account.refreshToken);
    const firstMessage = messages[0];
    const details = await getMessageDetails(account.refreshToken, firstMessage.id);
    const parsed = parseMessage(details);
    if (parsed.messageId) {
        const existing = await getEmailByGmailMessageId(parsed.messageId);
        if (existing) {
            return res.json({
                success: true,
                emailId: existing.id,
                duplicate: true,
                parsed,
            });
        }
    }
    const savedEmail = await createEmail({
        gmailMessageId: parsed.messageId,
        subject: parsed.subject ?? "",
        body: parsed.body || parsed.snippet || "",
        sender: parsed.sender ?? "",
    });
    await enqueueEmailProcessing(savedEmail.id);
    return res.json({
        success: true,
        emailId: savedEmail.id,
        parsed,
    });
};
//# sourceMappingURL=gmail.controller.js.map