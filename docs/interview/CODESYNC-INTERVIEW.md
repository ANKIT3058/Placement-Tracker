# CodeSync — Interview Preparation

Second priority after Placement Tracker. Source of truth: `D:\Projects\arklyte\CodeSync`
(package name `interviewplatform`).

**Read [the two warnings](#-two-things-to-handle-before-the-interview) first.**

---

## 60-second explanation

> "CodeSync is a remote technical interview platform. An interviewer schedules a session, both
> sides join a video call, and the same screen has a Monaco code editor next to the video — so
> the candidate writes code while the interviewer watches and talks. The candidate can pick from
> a set of problems, choose between JavaScript, Python, Java and C++, run their code against
> stdin, and see the output inline. Execution goes to Judge0, which runs it in an isolated
> container with CPU and memory limits, so I'm never executing untrusted code on my own
> infrastructure. Auth is Clerk, and the interview data — scheduling, participants, status,
> interviewer feedback — lives in Convex, which pushes updates to every connected client in
> real time."

---

## Architecture

```
   BROWSER (Next.js 15 App Router, React 19)
      │
      ├── Clerk middleware ──────────► session / identity
      │
      ├── ConvexClerkProvider ───────► Convex (reactive DB)
      │      useQuery subscriptions       users · interviews · comments
      │
      ├── StreamClientProvider ──────► Stream Video
      │      token from a SERVER ACTION using STREAM_SECRET_KEY
      │
      └── /meeting/[id]  →  MeetingRoom
              ├── ResizablePanel (left)  : SpeakerLayout | PaginatedGridLayout
              │                            CallControls · ParticipantsList · EndCall
              └── ResizablePanel (right) : CodeEditor (Monaco)
                                             │ runCode()
                                             ▼
                                     Judge0 (RapidAPI)  ← ⚠ called from the BROWSER
                                     isolated container, cpu 5s, mem 128MB

   Clerk ──webhook (svix-verified)──► Convex httpAction /clerk-webhook ──► users.syncUser
```

**Three tables in Convex** (`convex/schema.ts`):

| Table | Fields | Indexes |
|---|---|---|
| `users` | name, email, image, role (`candidate` \| `interviewer`), clerkId | `by_clerk_id` |
| `interviews` | title, description, startTime, endTime, status, streamCallId, candidateId, interviewerIds[] | `by_candidate_id`, `by_stream_call_id` |
| `comments` | content, rating, interviewerId, interviewId | `by_interview_id` |

---

## Why each technology — the "why not something simpler" answers

### Next.js
**Why:** I needed both a UI and a small amount of server-side work — specifically minting a
Stream token with a secret that must never reach the browser. A server action gives me that
without standing up a separate backend.
**Alternative:** plain React + a tiny Express server. That's a second deployment and a second
CORS surface for one endpoint.
**Problem solved:** one deployment, one origin, and a clean place for secrets.

### Convex
**Why:** the interview dashboard has to update live — when an interviewer marks a session
completed, everyone watching should see it without refreshing. Convex queries are subscriptions
by default: `useQuery` re-renders when the underlying data changes, with no WebSocket code and
no cache invalidation.
**Alternative:** Postgres + a REST API + polling, or Postgres + Socket.IO. Both mean writing the
real-time layer myself.
**Problem solved:** live reads without building a push channel.
**Trade-off:** it's a proprietary managed backend. I don't control the query planner, and
migrating off it means rewriting the data layer. For a project this size that was a good trade;
for something with complex relational queries I'd want Postgres.

### Clerk
**Why:** authentication is a solved problem with a large surface area to get wrong — sessions,
password reset, OAuth providers, email verification.
**Alternative:** NextAuth, or rolling it myself. I've rolled my own session layer in Placement
Tracker, so I know what it costs — that was the right call there because I needed control over
revocation, and the wrong call here.
**Problem solved:** identity, plus a webhook that syncs users into Convex so my own tables have
a user row keyed on `clerkId`.

### Stream Video SDK
**Why:** WebRTC by hand means signalling, ICE, TURN servers, and a selective forwarding unit if
you want more than two participants. That's the whole project, not a feature of it.
**Alternative:** raw WebRTC (weeks of work, and TURN costs money either way), or Daily/Twilio.
**Problem solved:** multi-participant video with layouts, device controls and a participants
list, out of the box.

### Monaco
**Why:** it's the editor from VS Code, so it comes with syntax highlighting, bracket matching
and multi-language support that candidates already recognise. A textarea would work and would
feel like a downgrade from what they're used to.

### Judge0
**Why:** I need to run arbitrary user-submitted C++, Java, Python and JavaScript. Running that
on my own server is a sandbox-escape problem I have no business solving for an interview tool.
Judge0 executes each submission in an isolated container with CPU and memory limits.
**Alternative:** Docker-per-submission on my own infra (real isolation, real ops burden), or
`eval()` in the browser (JavaScript only, and unsafe).
**Problem solved:** multi-language execution with resource limits, without owning the sandbox.

---

## What happens when a user submits code

Walk this end to end — it's the most likely "explain a flow" question.

```
1. User picks a question and a language
      → CodeEditor sets `code` to that question's starter code for that language
      → local React state

2. User types
      → onChange updates local state. NOT shared with the other participant.

3. User optionally types stdin into the input box

4. User clicks Run  →  runCode()
      a. map language → Judge0 language_id
            javascript 63 · python 71 · java 62 · cpp 54
      b. setOutput("Running...")
      c. POST https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true
            body: { source_code, language_id, stdin, expected_output: null,
                    cpu_time_limit: 5, memory_limit: 128000 }
            headers: X-RapidAPI-Host, X-RapidAPI-Key
      d. `wait=true` makes it SYNCHRONOUS — one request, response holds the result
      e. Judge0 compiles + runs in an isolated container under those limits

5. Response
      status.id === 3  → Accepted     → setOutput(stdout || "No Output")
      otherwise        → error        → setOutput(status.description + stderr)
      network failure  → catch        → setOutput("Error executing code")
```

**Two details worth volunteering:**
- **`wait=true` is a synchronous call.** Simple, but it blocks for the whole compile-and-run.
  The scalable pattern is to submit, get a token, and poll — which is what I'd move to if
  compile times or concurrency became a problem.
- **The failure handling is coarse.** Everything non-accepted collapses into one string. A
  compile error, a runtime error, a TLE and a wrong answer are meaningfully different and
  should render differently.

---

## Authentication and authorization flow

```
1. User signs in with Clerk (hosted UI)
2. clerkMiddleware() protects routes (src/middleware.ts)
3. Clerk fires a `user.created` webhook → Convex httpAction at /clerk-webhook
      → svix verifies the signature using CLERK_WEBHOOK_SECRET
        (svix-id + svix-timestamp + svix-signature headers)
      → users.syncUser mutation inserts the user with role "candidate"
4. ConvexClerkProvider passes the Clerk JWT to Convex
5. convex/auth.config.ts tells Convex which Clerk domain to trust
6. Every Convex function calls ctx.auth.getUserIdentity()
7. useUserRole() reads the user's role to branch the UI
```

**The webhook signature verification is a good detail to mention.** A webhook endpoint is
publicly reachable, so anyone could POST a fake `user.created`. Svix verifies an HMAC over the
body plus a timestamp, which prevents both forgery and replay.

### Two authorization gaps you should know

1. **`convex/interviews.ts:updateInterviewStatus` has no `getUserIdentity()` check** — unlike
   every other mutation in the file. Any authenticated caller could patch any interview's
   status.
2. **`convex/users.ts:getUsers` returns all users** to any authenticated caller.

**If asked how authorization works:**
> "Every Convex function checks `ctx.auth.getUserIdentity()` and throws if there's no identity
> — except `updateInterviewStatus`, which I noticed is missing it. That's a real gap: it should
> verify the caller is an interviewer assigned to that interview, not just that they're logged
> in. Role checks are currently in the UI via `useUserRole`, which is fine for hiding buttons
> and not sufficient as an authorization boundary."

Owning that reads as rigour. Being shown it does not.

---

## Frontend ↔ backend interaction

There is no traditional backend. Three server-side surfaces:

| Surface | What it does | Why it's server-side |
|---|---|---|
| **Convex functions** | queries + mutations over the three tables | Data access with identity checks |
| **Convex httpAction** | `/clerk-webhook` | Must be publicly reachable for Clerk to POST to |
| **Next.js server action** | `streamTokenProvider` | Uses `STREAM_SECRET_KEY`, which must never reach the browser |

**Reads are subscriptions, not fetches.** `useQuery(api.interviews.getAllInterviews)` re-renders
when the data changes — no polling, no manual invalidation. That's the concrete meaning of
"Convex for real-time synchronization."

---

## ⚠️ Two things to handle before the interview

### 1. "real-time code editing" is not implemented

```ts
// src/components/CodeEditor.tsx
const [code, setCode] = useState(selectedQuestion.starterCode[language]);
```

Local React state. No Convex document for the editor, no Yjs, no CRDT, no shared cursor, no sync
of editor content. **Each participant sees their own editor.**

Convex *is* real-time — for interviews, users and comments. Not for the code.

**Best fix: reword the bullet tonight.**
> "Built an interview platform pairing Stream video with an in-browser Monaco editor and
> Judge0-backed multi-language execution, with Convex real-time sync for scheduling, roles and
> interviewer feedback."

**If you can't reword it and you're asked:**
> "I should be precise there — the real-time layer is Convex, and it syncs interview state:
> scheduling, participants, status transitions and feedback, all live through Convex
> subscriptions. The editor itself isn't collaboratively synced; each side has its own Monaco
> instance and they talk over the call. To add shared editing I'd use a CRDT like Yjs rather
> than putting the document in Convex, because last-write-wins on a text field loses characters
> when two people type at once."

That converts an exposure into a design answer. **Volunteer it before they find it.**

### 2. The Judge0 API key is hardcoded and client-side

```ts
"X-RapidAPI-Key": "7a238ee83fmsh..."   // committed to the repo, shipped to every browser
```

**Tonight: rotate the key on RapidAPI.** If you have 20 minutes, move `runCode` into a server
action or a route handler so the key stays server-side.

**If asked, or if you see them reading that file:**
> "That's a real mistake — the key is in the client bundle, so it's public. Judge0 should be
> called from a server action with the key in an environment variable, which also gives me a
> place to rate-limit per user so one person can't burn the quota. I've rotated it."

---

## Likely questions

**Q: How does the video work?**
> Stream's SDK handles WebRTC. The client is created in a provider with a token minted by a
> server action using the secret key — so the secret never reaches the browser. `MeetingRoom`
> renders either a speaker layout or a paginated grid, plus Stream's `CallControls` for
> mic/camera/leave, and it listens for `call.ended` to route everyone home.

**Q: Why not build WebRTC yourself?**
> Signalling, ICE, TURN, and an SFU for more than two participants. That's the entire project
> rather than a feature of it. And TURN costs money whether I build it or buy it.

**Q: How do you prevent someone joining an interview they weren't invited to?**
> **Be honest:** "Routes are protected by Clerk, so you have to be authenticated. But the meeting
> route is keyed on the Stream call id, and I don't verify that the caller is the candidate or
> an assigned interviewer on that interview. I'd add that check — look up the interview by
> `streamCallId` and confirm the caller's id is in `candidateId` or `interviewerIds` — before
> issuing a call token."

**Q: What happens if Judge0 is down?**
> The fetch throws, it's caught, and the output box shows "Error executing code". The rest of
> the interview — video, editor, feedback — keeps working. Execution is a feature, not a
> dependency.

**Q: How is code execution sandboxed?**
> Judge0 runs each submission in an isolated container with a 5-second CPU limit and 128 MB of
> memory, which I set per request. To be precise: that isolation is Judge0's, not something I
> built — and using a service instead of running untrusted code myself is exactly the decision.

**Q: How would you add collaborative editing?**
> Yjs. A shared `Y.Text` with a provider — Convex could hold the persisted document while a
> WebSocket or WebRTC provider carries the live updates. The reason for a CRDT rather than just
> writing the string to Convex on change is that last-write-wins on a text field loses
> characters when two people type simultaneously; a CRDT merges concurrent edits without a
> server arbitrating. I'd add awareness for cursors and selections on top of the same provider.

**Q: How does the Clerk webhook work, and why verify it?**
> Clerk POSTs `user.created` to a Convex httpAction. The endpoint is publicly reachable, so
> anyone could forge a request — svix verifies an HMAC over the body plus a timestamp using a
> shared secret, which prevents both forgery and replay. Only after that does it run
> `users.syncUser`.

**Q: Why sync users into Convex at all if Clerk already has them?**
> Because my domain data references users — `interviews.candidateId`, `interviewerIds`,
> `comments.interviewerId`. I need a local row to join against and to store the
> candidate/interviewer role, which is my concept, not Clerk's.

**Q: What would you improve?**
> Four things, in order. Move the Judge0 call server-side and rate-limit it. Add the missing
> authorization check on `updateInterviewStatus` and on joining a meeting. Add collaborative
> editing with Yjs. And switch Judge0 from `wait=true` to submit-and-poll so a slow compile
> doesn't hold a request open.

---

## Comparing the two projects (a likely question)

**Q: Which project are you more proud of, and why?**
> Placement Tracker, and for a specific reason: CodeSync is largely integration — Stream, Clerk,
> Convex and Judge0 each solve a hard problem and my job was to wire them together well. The
> interesting decisions there were about *what to build versus what to buy*, and I think I made
> them correctly.
>
> Placement Tracker is where I had to design something. There was no library for "decide whether
> these two emails describe the same real-world event," and the first design I wrote was wrong
> in a way that took me a while to even categorise — it looked like a threshold that needed
> tuning and it was actually a representation that couldn't express what I needed. That's the
> work I learned the most from.

---

## Honest summary

| Claim | Reality |
|---|---|
| Video conferencing | ✅ Real — Stream SDK, server-minted token |
| Multi-language execution | ✅ Real — Judge0, 4 languages, stdin, resource limits |
| Sandboxed | ✅ Real — but Judge0's sandbox, attribute it correctly |
| Convex real-time sync | ✅ Real — for interviews, users, comments |
| **Real-time code editing** | 🔴 **Not implemented** — local state per participant |
| Clerk auth | ✅ Real, including a signature-verified webhook |
| Authorization | 🟡 Present on most Convex functions; missing on `updateInterviewStatus`, and no check that a caller belongs to the interview they're joining |
| Judge0 key handling | 🔴 Hardcoded, client-side — rotate it |
