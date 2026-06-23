import { google } from "googleapis";
export const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
export const generateAuthUrl = () => {
    return oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
};
export const getTokens = async (code) => {
    const { tokens } = await oauth2Client.getToken(code);
    return tokens;
};
export const getGmailAddress = async (tokens) => {
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({
        version: "v1",
        auth: oauth2Client,
    });
    const profile = await gmail.users.getProfile({
        userId: "me",
    });
    return profile.data.emailAddress;
};
export const getRecentMessages = async (refreshToken) => {
    oauth2Client.setCredentials({
        refresh_token: refreshToken,
    });
    const gmail = google.gmail({
        version: "v1",
        auth: oauth2Client,
    });
    const response = await gmail.users.messages.list({
        userId: "me",
        maxResults: 10,
    });
    return response.data.messages ?? [];
};
export const getMessageDetails = async (refreshToken, messageId) => {
    oauth2Client.setCredentials({
        refresh_token: refreshToken,
    });
    const gmail = google.gmail({
        version: "v1",
        auth: oauth2Client,
    });
    const response = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
    });
    return response.data;
};
const getHeader = (headers, name) => {
    return headers.find((header) => header.name === name)?.value;
};
const decodeBase64Url = (data) => {
    return Buffer.from(data, "base64url").toString("utf-8");
};
const htmlToPlainText = (html) => {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
};
const findBodyByMimeType = (part, mimeType) => {
    if (!part || part.filename) {
        return null;
    }
    if (part.mimeType === mimeType && part.body?.data) {
        return decodeBase64Url(part.body.data);
    }
    for (const child of part.parts ?? []) {
        const found = findBodyByMimeType(child, mimeType);
        if (found) {
            return found;
        }
    }
    return null;
};
const extractBody = (message) => {
    const payload = message.payload;
    if (!payload) {
        return "";
    }
    const plainText = findBodyByMimeType(payload, "text/plain");
    if (plainText) {
        return plainText;
    }
    const html = findBodyByMimeType(payload, "text/html");
    if (html) {
        return htmlToPlainText(html);
    }
    return "";
};
export const parseMessage = (message) => {
    const headers = message.payload?.headers ?? [];
    return {
        messageId: message.id,
        subject: getHeader(headers, "Subject"),
        sender: getHeader(headers, "From"),
        date: getHeader(headers, "Date"),
        snippet: message.snippet,
        body: extractBody(message),
    };
};
//# sourceMappingURL=gmail.service.js.map