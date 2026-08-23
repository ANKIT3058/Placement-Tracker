import { google } from "googleapis";
import { CodeChallengeMethod } from "google-auth-library";
import type { Credentials } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import type { AttachmentMetadata } from "../attachment/attachment.types.js";
import type { GoogleIdentity } from "../user/user.types.js";
import { GMAIL_REQUEST_TIMEOUT_MS } from "../../shared/constants/config.js";

// One client per PROCESS for the OAuth flow itself; one client per OPERATION
// for anything that touches a mailbox.
//
// That split is the whole of PR-8D. `setCredentials` replaces a client's
// credentials wholesale, so a single shared client is shared MUTABLE state, and
// this process runs mailbox work concurrently — the Gmail scheduler lives in the
// API process alongside request handling, so a background sync and a
// `POST /gmail/sync` genuinely overlap.
//
// Five of the six mailbox helpers survived that only by accident: they issue one
// API call, and google-auth-library happens to capture the credential object
// synchronously before its first await. That is an implementation detail, not a
// documented guarantee. `getHistoryChanges` did not survive it at all — it set
// credentials once and then paginated, so every page after the first re-read
// whatever the shared client held by then and could walk a different mailbox.
//
// Giving each operation its own client removes the shared state instead of
// timing around it. No other operation can reach an operation's client, so no
// interleaving can cross their credentials.
const createOAuthClient = () =>
  new google.auth.OAuth2({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,

    // The one place a deadline can be attached to everything at once.
    //
    // google-auth-library builds its transporter from these options and then
    // uses that single gaxios instance for BOTH halves of every mailbox
    // operation: its own OAuth token refresh, and the Gmail API call googleapis
    // dispatches through `authClient.request`. Configuring it here therefore
    // bounds the token refresh, every Gmail request, every page of a paginated
    // walk, and the attachment download — without repeating a timeout at the
    // six call sites, where one omission would silently reopen the hole.
    //
    // `transporterOptions` rather than a hand-built transporter, so the library
    // still constructs and instruments its own (it attaches request/response
    // interceptors to whatever it ends up with). This contributes the deadline
    // and nothing else.
    //
    // gaxios turns `timeout` into `AbortSignal.timeout()`, which aborts the
    // underlying fetch. That distinction is the point: abandoning the promise
    // instead would leave the socket open and the scheduler still holding a
    // reference to work that never ends.
    transporterOptions: { timeout: GMAIL_REQUEST_TIMEOUT_MS },
  });

// The shared client, used only by the three operations that act as THIS
// APPLICATION rather than as a user: `generateAuthUrl`, `getTokens` and
// `verifyGoogleIdToken`. They need the client id, secret and redirect URI, and
// never a user's mailbox credentials. It must never hold a refresh token — a
// mailbox operation that mutated it would restore the state this PR removes.
export const oauth2Client = createOAuthClient();

// Every mailbox call goes through here. Building the Gmail service in the same
// helper that builds the client is deliberate: it leaves no way to pair a fresh
// client with the shared one by accident, which is the single mistake that would
// silently reintroduce the vulnerability.
const gmailFor = (credentials: Credentials) => {
  const client = createOAuthClient();

  client.setCredentials(credentials);

  return google.gmail({ version: "v1", auth: client });
};

// The only issuers Google signs ID tokens as. Checked explicitly even though
// google-auth-library also validates it, because RFC-001 §10.1 enumerates
// issuer as a required check and a silent library default is not a check this
// codebase can be shown to make.
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

// Build the Google consent URL for one flow.
//
// `state` and `codeChallenge` are required parameters rather than options: both
// are what make the eventual callback verifiable, and a caller that could omit
// them would reintroduce the login-CSRF hole silently (RFC-001 §10.1). The
// challenge is the SHA-256 of a verifier the caller keeps server-side — Google
// receives the hash, never the secret.
export const generateAuthUrl = (state: string, codeChallenge: string) => {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",

    prompt: "consent",

    // Binds the authorization response to the browser that started the flow.
    state,

    // PKCE. S256 and never `plain`: `plain` puts the verifier itself in the
    // authorization request, which defends nothing against anyone able to read
    // it.
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,

    // `openid` is what makes Google return an ID token; without it the response
    // carries an access token only and there is no signed identity to verify.
    // The two userinfo scopes populate the email and profile claims the User
    // record is built from.
    scope: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
  });
};

// Redeem the authorization code.
//
// The verifier is required, not optional. Google recomputes its SHA-256 and
// compares it with the challenge sent at authorization time, so a code
// intercepted in transit cannot be redeemed by anyone who does not also hold
// the verifier — which never left this server.
export const getTokens = async (code: string, codeVerifier: string) => {
  const { tokens } = await oauth2Client.getToken({ code, codeVerifier });

  // Deliberately not logged. This object now carries a refresh token and an ID
  // token; printing it writes long-lived mailbox credentials to stdout and into
  // whatever aggregates it (RFC-001 §13.2).
  return tokens;
};

// Verify a Google ID token and reduce it to the claims this system trusts.
//
// `verifyIdToken` checks the signature against Google's published keys and
// validates `aud` and `exp`. A userinfo round-trip is not a substitute: it
// proves only that *some* access token is valid, not that this response is a
// signed statement about this client's user.
export const verifyGoogleIdToken = async (
  idToken: string,
): Promise<GoogleIdentity> => {
  const ticket = await oauth2Client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  if (!payload) {
    throw new Error("Google ID token carried no payload");
  }

  if (!payload.iss || !GOOGLE_ISSUERS.includes(payload.iss)) {
    throw new Error(`Google ID token has an unexpected issuer: ${payload.iss}`);
  }

  if (!payload.sub) {
    throw new Error("Google ID token carried no subject");
  }

  if (!payload.email) {
    throw new Error("Google ID token carried no email claim");
  }

  return {
    googleSub: payload.sub,
    email: payload.email,
    // Absent is treated as unverified. The claim is optional, and reading a
    // missing value as "verified" would invert the guard it exists to support.
    emailVerified: payload.email_verified === true,
    name: payload.name ?? null,
    imageUrl: payload.picture ?? null,
  };
};

export const getGmailAddress = async (tokens: Credentials) => {
  const gmail = gmailFor(tokens);

  const profile = await gmail.users.getProfile({
    userId: "me",
  });

  return profile.data.emailAddress;
};

// Every message the mailbox will hand over, not just the first page.
//
// `maxResults` is a PER-PAGE limit — Google documents it as defaulting to 100
// with a maximum of 500 — and a `nextPageToken` in the response means more
// messages exist. Reading one page and discarding the token therefore drops an
// unbounded remainder, and `syncGmailAccount` then advances the account's
// historyId past everything it never saw, putting those messages permanently
// beyond the reach of any later incremental sync (F-3a).
//
// The walk continues on the TOKEN, never on whether a page had messages: a page
// can come back empty while more remain behind it, and stopping there would
// discard the rest just as silently.
//
// A page that rejects propagates. There is deliberately no catch here — a
// partial listing must not be mistaken for a complete mailbox, because the
// caller writes the watermark on success and a swallowed page error would turn
// a retryable failure into a permanent gap.
//
// No page cap, for the same reason: a cap is the original bug wearing a
// different name. Each request is independently bounded by the client timeout
// configured in `createOAuthClient` (PR-8G), so the loop needs no deadline of
// its own.
export const getRecentMessages = async (refreshToken: string) => {
  const gmail = gmailFor({ refresh_token: refreshToken });

  const messages: gmail_v1.Schema$Message[] = [];
  let pageToken: string | undefined;

  do {
    const response = await gmail.users.messages.list({
      userId: "me",
      maxResults: 100,
      pageToken,
    });

    messages.push(...(response.data.messages ?? []));

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return messages;
};

export const getMessageDetails = async (
  refreshToken: string,
  messageId: string,
) => {
  const gmail = gmailFor({ refresh_token: refreshToken });

  const response = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
  });

  return response.data;
};

export const getLatestHistoryId = async (
  refreshToken: string,
): Promise<string> => {
  const gmail = gmailFor({ refresh_token: refreshToken });

  const profile = await gmail.users.getProfile({
    userId: "me",
  });

  const historyId = profile.data.historyId;

  if (!historyId) {
    throw new Error("Gmail profile did not return a historyId");
  }

  return historyId;
};

export const getHistoryChanges = async (
  refreshToken: string,
  startHistoryId: string,
): Promise<{ messageIds: string[]; latestHistoryId: string }> => {
  const gmail = gmailFor({ refresh_token: refreshToken });

  const messageIds = new Set<string>();
  let latestHistoryId = startHistoryId;
  let pageToken: string | undefined;

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

const getHeader = (
  headers: { name?: string | null; value?: string | null }[],
  name: string,
) => {
  return headers.find((header) => header.name === name)?.value;
};

const decodeBase64Url = (data: string): string => {
  return Buffer.from(data, "base64url").toString("utf-8");
};

const htmlToPlainText = (html: string): string => {
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

const findBodyByMimeType = (part: any, mimeType: string): string | null => {
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

const extractBody = (message: any): string => {
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
const collectAttachments = (payload: any): AttachmentMetadata[] => {
  const attachments: AttachmentMetadata[] = [];

  const walk = (part: any) => {
    if (!part) return;

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

export const parseMessage = (message: any) => {
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
export const getAttachmentData = async (
  refreshToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> => {
  const gmail = gmailFor({ refresh_token: refreshToken });

  const response = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });

  const data = response.data.data;

  if (!data) {
    throw new Error(
      `Gmail returned no data for attachment ${attachmentId} on message ${messageId}`,
    );
  }

  return Buffer.from(data, "base64url");
};
