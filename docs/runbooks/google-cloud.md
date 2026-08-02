# Runbook — Google Cloud

Engineering Handbook — Operations
Status: operational reference. Console navigation verified against Google Cloud as of 2026-08.

---

# Purpose

How to obtain, manage, and rotate the Google Cloud configuration this project
depends on: the OAuth client, the consent screen, the test user list, the
redirect URIs, and the Gmail API.

Everything here is external to the repository. Nothing in this runbook is
controlled by code, and none of it is in version control — which is exactly why
it needs recording.

---

# When to Use

- Setting up the project on a new Google account or Google Cloud project
- Adding a collaborator who needs to sign in
- `access_denied` or `redirect_uri_mismatch` at the consent screen
- Recurring `invalid_grant` roughly every seven days
- Rotating a leaked or expiring client secret
- Moving from `localhost` to a deployed host

**Do not use this** for the sign-in procedure itself — that is
[authentication.md](authentication.md).

---

# Prerequisites

- A Google account with permission to create or administer a Google Cloud project
- Access to `backend/.env` on the machine being configured

> **Console navigation drifts.** Google renames and relocates these screens
> regularly. The *purpose* of each setting below is stable; the exact menu path
> may not be. Navigate by the setting's name rather than by the click path.

---

# Configuration inventory

What the implementation actually requires. Each row is enforced by code or by
Google, not by convention.

| Item | Required value | Enforced by |
|---|---|---|
| API enabled | **Gmail API** | Google — calls 403 without it |
| OAuth client type | **Web application** | Redirect URIs are only offered for this type |
| Authorized redirect URI | `http://localhost:3000/gmail/callback` | Google, exact match |
| Scope | `openid` | `gmail.service.ts` — no ID token without it |
| Scope | `.../auth/userinfo.email` | `gmail.service.ts` |
| Scope | `.../auth/userinfo.profile` | `gmail.service.ts` |
| Scope | `.../auth/gmail.readonly` | `gmail.service.ts` |
| Test users | every Google account that will sign in | Google, while in Testing mode |
| `GOOGLE_CLIENT_ID` | from the OAuth client | `backend/.env` |
| `GOOGLE_CLIENT_SECRET` | from the OAuth client | `backend/.env` |
| `GOOGLE_REDIRECT_URI` | must equal the registered URI | `backend/.env` |

`gmail.readonly` is a **restricted scope**. That has consequences the moment the
app leaves Testing mode — see *Publishing status* below.

---

# Procedure — first-time setup

## 1. Create or select a project

Google Cloud Console → project selector (top bar) → **New Project**.

Record the project name and ID in your own notes. The project ID appears in
support requests and cannot be changed after creation.

## 2. Enable the Gmail API

**APIs & Services → Library** → search `Gmail API` → **Enable**.

Enabling is per-project. A client created in a project without the Gmail API
will authenticate successfully and then fail on the first mailbox read, which is
a confusing failure to diagnose.

## 3. Configure the OAuth consent screen

**APIs & Services → OAuth consent screen**

| Field | Value |
|---|---|
| User type | **External** (unless you have a Workspace organisation) |
| App name | anything recognisable on the consent screen |
| User support email | your address |
| Developer contact | your address |

## 4. Add scopes

On the consent screen's **Scopes** step, add all four:

```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/gmail.readonly
```

Google will flag `gmail.readonly` as restricted. That is expected and does not
block Testing mode.

**Omitting `openid` is the highest-cost mistake here.** Without it Google
returns no ID token, the callback throws `Google did not return an ID token`,
and sign-in fails after consent has already succeeded — so the error appears to
come from the application rather than from configuration.

## 5. Add test users

See *Managing test users* below. **Sign-in fails with `access_denied` for any
account not on this list** while the app is in Testing mode.

## 6. Create the OAuth client

**APIs & Services → Credentials → Create Credentials → OAuth client ID**

| Field | Value |
|---|---|
| Application type | **Web application** |
| Name | e.g. `placement-tracker-local` |
| Authorized redirect URIs | `http://localhost:3000/gmail/callback` |

Authorized JavaScript origins are **not** required — the browser never calls
Google directly; the backend performs the code exchange.

## 7. Record the credentials

Copy the client ID and client secret into `backend/.env`:

```bash
GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<secret>
GOOGLE_REDIRECT_URI=http://localhost:3000/gmail/callback
```

The secret is shown in full only at creation. It can be re-downloaded as JSON
from the client's detail page afterwards.

---

# Publishing status

**APIs & Services → OAuth consent screen → Publishing status**

| Status | Who can sign in | Refresh token lifetime | Verification |
|---|---|---|---|
| **Testing** | Only listed test users (100 max) | **7 days** | Not required |
| **In production** | Anyone | Until revoked | Required for restricted scopes |

> **The 7-day refresh token expiry in Testing mode is the single most common
> operational failure in this project.** Every mailbox will produce
> `invalid_grant` roughly weekly, and the only remedy is to reconnect through
> `/gmail/auth`. This is Google policy, not a defect.

Moving to **In production** with `gmail.readonly` requires OAuth verification —
a published privacy policy, a scope justification, a demonstration video, and,
for restricted scopes, a periodic third-party security assessment (CASA). That
is a multi-week process. See RFC-001 §16.4, which treats it as a rollout
dependency with lead time rather than a launch-day task.

For solo development, remaining in Testing and reconnecting weekly is the
correct trade-off.

---

# Managing test users

**APIs & Services → OAuth consent screen → Test users**

## Add

1. **+ Add users**
2. Enter the full Google address (one per line)
3. **Save**

Effective immediately; no propagation delay. Maximum 100 while in Testing.

## Remove

1. Select the address → **Remove** → **Save**
2. **Access is withdrawn immediately.** Existing refresh tokens for that account
   stop working and produce `invalid_grant` on the next sync.
3. If that mailbox's data should also stop being synced, delete or disable its
   `GmailAccount` row. Removing the test user stops new reads; it does not remove
   stored data or the stored token.

## Verify

The list on the consent screen is the authority. If an account is present and
sign-in still fails with `access_denied`, the address on the list differs from
the one being used — check for a Workspace alias or a `+` suffix.

---

# Procedure — redirect URIs

The redirect URI must match **byte for byte**: scheme, host, port, path, and
trailing slash. `localhost` and `127.0.0.1` are different values.

| Environment | Registered URI | `GOOGLE_REDIRECT_URI` |
|---|---|---|
| Local | `http://localhost:3000/gmail/callback` | identical |
| Deployed | `https://api.example.com/gmail/callback` | identical |

## Change one

1. **Credentials →** the OAuth client **→ Authorized redirect URIs**
2. Add the new URI. **Do not remove the old one yet** — both may coexist, which
   allows a zero-downtime cutover.
3. Update `GOOGLE_REDIRECT_URI` in the environment
4. Restart the backend (the value is read at module load)
5. Verify a full sign-in through the new URI
6. Remove the old URI

Changes can take a few minutes to propagate on Google's side.

---

# Procedure — verify the Gmail API is enabled

| Method | Steps | Expected |
|---|---|---|
| Console | **APIs & Services → Enabled APIs & services** | `Gmail API` listed |
| Functional | Sign in, then `POST /gmail/sync` | Mailbox reports `synced`, not `failed` |

A `403` from Google carrying `accessNotConfigured` or `Gmail API has not been
used in project …` means the API is not enabled in **that** project — commonly
because the OAuth client belongs to a different project than the one where the
API was enabled.

---

# Procedure — rotate credentials

Rotate on a leak, on suspicion of a leak, or on staff change.

> **Rotating the client secret invalidates every existing refresh token.** Every
> connected mailbox must be reconnected. Plan for that.

1. **Credentials →** the OAuth client → **Add secret** (if the console offers
   dual secrets) or **Reset secret**
2. Update `GOOGLE_CLIENT_SECRET` in `backend/.env` and every deployed environment
3. Restart the backend and both workers — the OAuth client is constructed at
   module load in `gmail.service.ts`
4. Reconnect every mailbox:
   - visit `http://localhost:3000/gmail/auth`
   - complete consent for each connected address
   - `connectGmailAccount` overwrites the stored token in place; ownership and
     email history are preserved
5. Confirm with `POST /gmail/sync` that every mailbox reports `synced`
6. Revoke the old secret in the console

To rotate the whole client (not just the secret), create a new OAuth client,
register the same redirect URI, update both `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET`, then follow steps 3–6.

---

# Verification

| Check | How | Expected |
|---|---|---|
| API enabled | Enabled APIs list | `Gmail API` present |
| Client type | Credentials → client detail | Web application |
| Redirect URI | Client detail | exactly matches `GOOGLE_REDIRECT_URI` |
| Scopes | Consent screen → Scopes | all four listed |
| Test user | Consent screen → Test users | your address present |
| End to end | `http://localhost:3000/gmail/auth` | consent completes; callback returns `{"success":true,"email":…}` |
| Mailbox reads | `POST /gmail/sync` | the mailbox reports `synced` |

---

# Common Failures

### `access_denied` — "app has not completed the Google verification process"

**Cause.** The signing-in account is not on the test user list.
**Resolution.** Add it (*Managing test users*). Re-run sign-in; no restart needed.

---

### `redirect_uri_mismatch`

**Cause.** The registered URI and `GOOGLE_REDIRECT_URI` differ. Usual culprits:
`127.0.0.1` vs `localhost`, a missing port, a trailing slash, `https` vs `http`.
**Resolution.** Make them identical. Restart the backend after editing `.env`.

---

### `Google did not return an ID token` (backend `500`)

**Cause.** The `openid` scope is absent from the consent screen, or was not
granted.
**Resolution.** Add `openid` to the scope list, then revoke the app under
[Google Account → Security → Third-party access](https://myaccount.google.com/permissions)
so the next consent re-prompts for the full set.

---

### `403 accessNotConfigured` on the first mailbox read

**Cause.** Gmail API not enabled in the project that owns the OAuth client.
**Resolution.** Enable it in that project. Confirm the client and the API are in
the *same* project.

---

### `invalid_grant`, recurring roughly weekly

**Cause.** Publishing status is **Testing**; refresh tokens expire after 7 days.
**Resolution.** Reconnect via `/gmail/auth`. To stop it recurring, publish the
app — which requires verification for `gmail.readonly`.

Full diagnosis and recovery: [authentication.md](authentication.md#invalid_grant-from-google).

---

### Consent screen shows an unexpected app name or scope set

**Cause.** `GOOGLE_CLIENT_ID` names a client in a different project than the
consent screen being edited.
**Resolution.** Confirm the project selector matches the project that issued the
client id.

---

# Recovery

## Lost the client secret

It cannot be retrieved. Reset it and follow *Procedure — rotate credentials*.

## Lost access to the Google Cloud project

Nothing in this repository can recover it. A new project must be created and the
entire *first-time setup* repeated; every mailbox then needs reconnecting.
Ensure at least one other account holds Owner on the project.

## Accidentally deleted the OAuth client

Create a new one with the same redirect URI, update both credentials, restart,
and reconnect every mailbox. Stored `GmailAccount` rows survive — only their
refresh tokens are dead.

## Test user list wiped

Re-add the addresses. No data is affected; only sign-in is blocked meanwhile.

---

# Screenshots

**None are included.** The repository has no image assets under `docs/` and no
documentation references an image anywhere, so introducing one would break an
established convention for a single runbook.

The notes/PDF referenced in the task description **did not arrive with the
request**, so no screenshots were available to incorporate. If console
screenshots are wanted later, the convention to establish first is a
`docs/assets/` directory with a stated policy on redacting project IDs, client
ids, and email addresses — every one of those screens displays at least one
value that should not be committed.

---

# Related Documents

- [authentication.md](authentication.md) — sign-in, sessions, `invalid_grant` recovery
- [local-development.md](local-development.md) — where these variables are consumed
- [RFC-001 §16.4](../rfcs/RFC-001-authentication-multi-user-foundation.md) —
  restricted-scope compliance as a rollout dependency
- [troubleshooting.md](troubleshooting.md) — symptom-first index

---

# Confidence

**High for what the implementation requires.** The scope list, redirect URI
path, client type, and environment variable names were read from
`gmail.service.ts`, `gmail.route.ts`, and `backend/.env` (key names only — no
values were read or reproduced). `GOOGLE_REDIRECT_URI` was confirmed to be
`http://localhost:3000/gmail/callback` and to match the mounted route.

**Medium for console navigation.** Menu paths reflect Google Cloud Console as of
2026-08 and are known to drift. Navigate by setting name if a path is wrong.

**Medium for Google's policy statements** — the 100 test-user cap, the 7-day
refresh token expiry in Testing mode, and restricted-scope verification
requirements are Google policy, not repository behaviour. They were not
re-verified against Google's documentation while writing this and should be
re-checked before being relied on for planning.

**Not executed.** No Google Cloud Console operation was performed. No OAuth flow
was run end to end. Every procedure here is derived from the configuration the
code requires, not from a transcript.

**Source material gap.** The notes/PDF cited in the task was not attached to the
request. Any operational detail it contained that is not derivable from the
repository — prior incidents, project ids, account ownership — is therefore
absent. See *Still undocumented* in [troubleshooting.md](troubleshooting.md).
