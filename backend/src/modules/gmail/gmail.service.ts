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
