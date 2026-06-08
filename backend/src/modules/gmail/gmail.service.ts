import { google } from "googleapis";
import type { Credentials } from "google-auth-library";

export const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

export const generateAuthUrl = () => {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",

    prompt: "consent",

    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
  });
};

export const getTokens = async (code: string) => {
  const { tokens } = await oauth2Client.getToken(code);

  return tokens;
};

export const getGmailAddress = async (tokens: Credentials) => {
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

export const getRecentMessages = async (refreshToken: string) => {
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

export const getMessageDetails = async (
  refreshToken: string,
  messageId: string,
) => {
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

const getHeader = (
  headers: { name?: string | null; value?: string | null }[],
  name: string,
) => {
  return headers.find((header) => header.name === name)?.value;
};

const extractBody = (message: any): string => {
  const payload = message.payload;

  if (!payload) {
    return "";
  }

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  const textPart = payload.parts?.find(
    (part: any) => part.mimeType === "text/plain",
  );

  if (textPart?.body?.data) {
    return Buffer.from(textPart.body.data, "base64").toString("utf-8");
  }

  return "";
};

export const parseMessage = (message: any) => {
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
