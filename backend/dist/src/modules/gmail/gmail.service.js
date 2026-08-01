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
    console.log("TOKENS");
    console.log(tokens);
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
        maxResults: 100,
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
export const getLatestHistoryId = async (refreshToken) => {
    oauth2Client.setCredentials({
        refresh_token: refreshToken,
    });
    const gmail = google.gmail({
        version: "v1",
        auth: oauth2Client,
    });
    const profile = await gmail.users.getProfile({
        userId: "me",
    });
    const historyId = profile.data.historyId;
    if (!historyId) {
        throw new Error("Gmail profile did not return a historyId");
    }
    return historyId;
};
export const getHistoryChanges = async (refreshToken, startHistoryId) => {
    oauth2Client.setCredentials({
        refresh_token: refreshToken,
    });
    const gmail = google.gmail({
        version: "v1",
        auth: oauth2Client,
    });
    const messageIds = new Set();
    let latestHistoryId = startHistoryId;
    let pageToken;
    do {
        const response = await gmail.users.history.list({
            userId: "me",
            startHistoryId,
            historyTypes: ["messageAdded"],
            pageToken,
        });
        if (response.data.historyId) {
            latestHistoryId = response.data.historyId;
        }
        for (const record of response.data.history ?? []) {
            for (const added of record.messagesAdded ?? []) {
                const id = added.message?.id;
                if (id) {
                    messageIds.add(id);
                }
            }
        }
        pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return {
        messageIds: [...messageIds],
        latestHistoryId,
    };
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
// Walk the MIME tree and collect metadata for every part that is a real
// attachment (has a filename AND a Gmail attachmentId). Inline body parts
// (text/plain, text/html) have no attachmentId and are skipped. Only metadata
// is captured here — the bytes are downloaded later by the attachment worker.
const collectAttachments = (payload) => {
    const attachments = [];
    const walk = (part) => {
        if (!part)
            return;
        if (part.filename && part.body?.attachmentId) {
            attachments.push({
                gmailAttachmentId: part.body.attachmentId,
                filename: part.filename,
                mimeType: part.mimeType ?? "application/octet-stream",
                size: typeof part.body.size === "number" ? part.body.size : null,
            });
        }
        for (const child of part.parts ?? []) {
            walk(child);
        }
    };
    walk(payload);
    return attachments;
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
        attachments: collectAttachments(message.payload),
    };
};
// Download a single attachment's bytes from Gmail. Kept alongside the other
// Gmail API helpers so all googleapis usage stays in one module and no extra
// OAuth client is created elsewhere.
export const getAttachmentData = async (refreshToken, messageId, attachmentId) => {
    oauth2Client.setCredentials({
        refresh_token: refreshToken,
    });
    const gmail = google.gmail({
        version: "v1",
        auth: oauth2Client,
    });
    const response = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachmentId,
    });
    const data = response.data.data;
    if (!data) {
        throw new Error(`Gmail returned no data for attachment ${attachmentId} on message ${messageId}`);
    }
    return Buffer.from(data, "base64url");
};
//# sourceMappingURL=gmail.service.js.map