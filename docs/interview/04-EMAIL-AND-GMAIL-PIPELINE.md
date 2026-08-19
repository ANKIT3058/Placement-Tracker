# 04 — Email and Gmail Pipeline

Everything ✅ **Current** unless tagged. Files: `src/modules/gmail/`, `src/modules/email/`.

---

## OAuth, explained simply

Google will not hand your server someone's mailbox. It hands you a **short-lived access
token** after the user clicks "Allow", and — if you ask correctly — a **long-lived refresh
token** you can trade for new access tokens forever.

The flow:

```
1. Browser hits GET /gmail/auth
      → server builds Google's consent URL and redirects

2. User approves on Google's page

3. Google redirects back to GET /gmail/callback?code=...
      code is single-use and short-lived

4. Server exchanges the code for tokens (server-to-server, uses the client secret)
      → access_token   (~1 hour)
      → refresh_token  (long-lived)  ← the one that matters
      → id_token       (a signed JWT describing WHO the user is)

5. Server verifies the id_token, resolves/creates the User,
   stores the refresh token on GmailAccount, and creates a session
```

**The consent URL** (`generateAuthUrl` in `gmail.service.ts`):

```ts
access_type: "offline",   // ← this is what asks for a refresh token
prompt: "consent",        // ← forces the consent screen every time
scope: [
  "openid",                                          // makes Google return an id_token
  ".../auth/userinfo.email",
  ".../auth/userinfo.profile",
  ".../auth/gmail.readonly",                         // read-only mailbox access
]
```

### "Why offline access?"
Without `access_type: "offline"` Google returns an access token only. That expires in an
hour, and then background sync stops working until the user logs in again. Offline access
is the difference between "read the mailbox while the user is on the page" and "read the
mailbox at 3 a.m. while nobody is around."

### "Why `prompt: consent`?"
Google only issues a refresh token on the *first* authorization of an app for an account.
Re-authorizing an already-approved account silently returns just an access token — and then
the code path `if (!tokens.refresh_token) throw` fires and the connect fails for a reason
that looks like nothing is wrong. Forcing the consent screen makes it reliable.
*(This was a real bug — Notion #48.)*

### "Why `openid`, and why verify the ID token?"
`openid` is what makes Google return an `id_token`. `verifyGoogleIdToken` then checks:
- the **signature** against Google's published keys
- `aud` matches our client id
- `exp` not expired
- `iss` is in an explicit allowlist (`accounts.google.com` / `https://accounts.google.com`)
- `sub` and `email` are present
- `email_verified === true` (absent is treated as unverified)

Why not just call the userinfo endpoint? Because that only proves *some* access token is
valid. It doesn't prove the response is a signed statement about *this client's* user.

### "Why identify the mailbox with Gmail's own profile API?"
🕘 The first version used `google.oauth2().userinfo.get()`, which pulled in extra scopes.
✅ Now it uses `gmail.users.getProfile({ userId: "me" })`, which needs no scope beyond the
Gmail one we already have. Least privilege, one fewer permission on the consent screen.

### "What do you store, and what do you deliberately not store?"

| Stored | Not stored |
|---|---|
| `GmailAccount.refreshToken` | access tokens — they expire in an hour and are re-mintable |
| `GmailAccount.email`, `historyId` | id tokens |
| Session: `userId`, `googleSub`, timestamps | **nothing derived from Google's tokens goes in the session** |

The session is an identity record, not a credential store. And `getTokens()` carries a
comment saying the token object is deliberately never logged — printing it writes long-lived
mailbox credentials to stdout and into whatever aggregates stdout. *(That was a real
mistake once — Notion #50.)*

### "What happens when the access token expires?"
Nothing visible. Every Gmail helper does:
```ts
oauth2Client.setCredentials({ refresh_token: refreshToken });
```
and `googleapis` mints a fresh access token on demand. We never store or manage the access
token ourselves.

---

## Who owns an email?

This is a question interviewers like, because the naive answer is wrong.

```
User  ──owns──►  GmailAccount  ──produced──►  Email  ──►  Attachment / EmailExtraction
```

`syncSingleMessage` writes `userId: account.userId` onto every Email it creates. Ownership
**flows from the mailbox that produced the observation**. It is never inferred, never
guessed, never taken from a request body.

🕘 **Historical:** the attachment worker used to call `getFirstGmailAccount()` — "whichever
mailbox happens to be connected." That worked with exactly one user and would have
downloaded attachments with the wrong credentials the moment there were two. The fix was to
put `gmailAccountId` on Email so the worker can resolve
`Attachment → Email → GmailAccount → refreshToken`. Those global resolvers still exist in
`gmail.repository.ts`, marked dead and unreachable from any authenticated flow.

**Mailbox ownership is never transferred.** `connectGmailAccount` is a deliberate
read-then-write instead of an upsert, because the rule is conditional: if the mailbox
already belongs to a *different* user, the reconnect refreshes the token but leaves the
owner alone. An upsert can't express that, and the alternative silently moves an entire
email history to whoever connected most recently.

---

## Synchronization

### Full sync (first time, or after cursor expiry)
```ts
const latestHistoryId = await getLatestHistoryId(refreshToken);  // ← BEFORE listing
const messages = await getRecentMessages(refreshToken);          // maxResults: 100
await processMessages(account, ids);
await updateHistoryId(account.email, latestHistoryId);
```

**Why capture the watermark before listing?** If you capture it after, a message that
arrives *during* the listing gets a history id below the new cursor and is never seen again.
Capturing first means that message is re-fetched next run. **Overlap is safe (dedupe catches
it); gaps are not.**

### Incremental sync
```ts
users.history.list({ startHistoryId, historyTypes: ["messageAdded"] })
```
Paginated through `nextPageToken`, collecting message ids into a `Set` (the history API can
report the same message more than once). Returns the new `historyId`.

### Cursor expiry
Gmail only keeps history for a limited window. If the stored `historyId` is too old, the API
answers `404`. `isHistoryIdExpired` checks `code`/`status`/`response.status` for 404 and
falls back to a full sync automatically. Any other error is rethrown.

### Two entry points
| Trigger | Code | Scope |
|---|---|---|
| Background | `gmail.scheduler.ts`, `setInterval(GMAIL_SYNC_INTERVAL_MS)` default 120 s | `getAllGmailAccounts()` — **global**, deliberately: background work has no caller to derive a tenant from |
| Manual | `POST /gmail/sync`, authed | `getGmailAccountsByUser(context)` — only the caller's own mailboxes |

The scheduler guards against overlapping runs with an `isRunning` flag, and syncs accounts
**sequentially** so one failing mailbox never aborts the ones behind it.

**Note on `POST /gmail/sync` being a POST:** it is not cosmetic. `SameSite=Lax` sends the
session cookie on cross-site top-level GET navigations. The moment this route is protected
by a session cookie, a GET version of it is CSRF-reachable from any page that can navigate
the browser.

---

## Message retrieval and MIME parsing

`parseMessage(message)` in `gmail.service.ts` produces:

```ts
{ messageId, subject, sender, date, snippet, body, attachments }
```

**Body extraction** (`extractBody` → `findBodyByMimeType`) walks the MIME tree recursively:
1. prefer the first `text/plain` part
2. else the first `text/html`, run through `htmlToPlainText` (strips `<style>`, `<script>`,
   all tags, decodes the common entities)
3. else `""` — and the caller falls back to Gmail's `snippet`

Parts with a `filename` are skipped when looking for a body. Data is base64**url**, decoded
with `Buffer.from(data, "base64url")`.

🕘 The first version only read `payload.body.data`, which is empty for any multipart message
— i.e. for basically every real email. Nested MIME support was commit `545716f`.

**Attachment discovery** (`collectAttachments`) walks the same tree and keeps a part only if
it has **both** a `filename` **and** a `body.attachmentId`. Inline body parts have no
attachmentId, so they're naturally excluded. Only metadata is captured here — the bytes are
downloaded later by the attachment worker, because downloading during sync would make sync
slow and would download files for emails that turn out to be irrelevant.

---

## Persistence and queueing

```ts
createEmail({ gmailMessageId, gmailAccountId, userId, subject, body, sender, attachments })
```

One nested Prisma create → the Email row and all Attachment rows insert in a single implicit
transaction. Either all of it lands or none of it does.

Note the ownership subtlety: `Attachment.userId` is **not** passed explicitly. Because of
the composite FK `(emailId, userId) → Email(id, userId)`, both columns are relation scalars,
so Prisma fills them from the parent it just inserted. Passing `userId` would now be
rejected as an unknown argument — and would be redundant anyway.

Then `enqueueEmailProcessing({ emailId, userId })`.

---

## Likely interview questions

**"How do you avoid processing the same email twice?"**
Three layers.
1. `Email.gmailMessageId` is unique, and `syncSingleMessage` explicitly looks it up before
   inserting — a duplicate returns early and never enqueues.
2. If a job somehow runs twice, matching finds the event by its exact `eventKey` and the
   update path becomes a no-op: `detectChanges` returns zero changes, so nothing is written
   and no audit row is created.
3. If two workers race a *create*, Postgres rejects the second on `@@unique([userId,
   eventKey])`, and the worker catches `P2002` and returns successfully instead of retrying.

**"Why not process everything synchronously?"**
Because an LLM call takes seconds, a sync run produces up to 100 emails at once, and a
failure inside a request has nowhere to be retried from. Persisting first and enqueueing
means the email is safe before any of the risky work starts.

**"Gmail push notifications instead of polling?"**
💭 Not implemented. Gmail supports `users.watch` with Pub/Sub. That's the right answer for
scale; polling every two minutes is the right answer for one user and no cloud
infrastructure. The sync logic itself wouldn't change — only what triggers it.

**"What if a user connects two mailboxes?"**
Supported. Each `GmailAccount` has its own refresh token and its own `historyId` cursor, and
they're synced sequentially and independently. `POST /gmail/sync` syncs all of the caller's
mailboxes and reports per-mailbox outcomes; zero mailboxes returns 200 with an empty list,
not 404, because owning no mailbox is a legitimate state.

**"Is there a limit on how much you sync?"**
Full sync fetches `maxResults: 100`, without pagination. So a brand-new mailbox bootstraps
from its most recent 100 messages, not its entire history. Deliberate for a first sync;
incremental sync afterwards is fully paginated.

**"Do you filter to only placement emails?"**
No pre-filter — every synced message goes through the pipeline. The **viability gate** does
the filtering after extraction: no resolvable company or no full date → the email is marked
`ignored` and never touches the Event table. That's cheaper to get right than a sender/subject
allowlist that would silently drop real announcements.
