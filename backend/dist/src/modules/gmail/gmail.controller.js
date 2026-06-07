import { generateAuthUrl, getTokens, getGmailAddress, } from "./gmail.service.js";
import { createGmailAccount } from "./gmail.repository.js";
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
//# sourceMappingURL=gmail.controller.js.map