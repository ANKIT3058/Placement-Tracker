# CodeSync — Technical & Interview Guide

**How to use this guide**

It's in three layers. Study them in order.

| Layer | What's in it | When to read it |
|---|---|---|
| **PART I — Understand the project** | Mental model, repo map, what the app does, architecture, what I built vs what I integrated | First. Read it twice. If you only have one hour, read only this. |
| **PART II — Technical deep dive** | Flow-by-flow implementation, data model, Convex/Clerk/Stream/Judge0 details, security, failure modes, scalability | Second. Skim the "Must know" boxes, then go deep on whatever you're weakest at. |
| **PART III — Interview preparation** | Spoken answers, follow-up chains, the project story, resume mapping, whiteboard script, last-minute sheet | Third, and again the night before. |

Two rules the whole document follows:

- **Everything here comes from reading the actual repository**, not the README (which is still the untouched `create-next-app` template). Where the README, the resume, or a reasonable assumption disagrees with the code, the code wins and the difference is called out.
- **"Current" and "Improvement" are always kept separate.** Nothing in here describes a fix as though it's already built.

**Repository facts at a glance:** Next.js `15.3.3`, React 19, TypeScript 5, Convex `1.24.8`, Clerk `@clerk/nextjs 6.21`, Stream (`@stream-io/video-react-sdk 1.18` + `@stream-io/node-sdk 0.4`), Monaco via `@monaco-editor/react 4.7`, Tailwind CSS 4, shadcn/ui, `svix` for webhook verification. No tests, no CI, no `.env.example`.

---
---

# PART I — UNDERSTAND THE PROJECT

---

## 1. CodeSync Mental Model

Remember the whole project as **five pieces**:

| # | Piece | The question it answers |
|---|---|---|
| 1 | **Clerk** | Who is the user? |
| 2 | **Convex** | What is the interview record? |
| 3 | **Stream** | How do the interviewer and candidate talk to each other? |
| 4 | **Monaco** | Where does the candidate write code? |
| 5 | **Judge0** | Where does the code actually run? |

### How the five connect

```
   Clerk says "this is user_abc"
        |
        |  that ID becomes the key for everything else
        v
   Convex stores the interview:  candidateId = user_abc
        |                        streamCallId = <a UUID>
        |
        |  the same UUID is the Stream call
        v
   Stream runs the call at that UUID
        |
        |  inside the call, the right-hand panel is:
        v
   Monaco (the code)  ---- Run ---->  Judge0 (runs it, sends output back)
```

Two sentences that hold the whole thing together:

1. **One Clerk user ID is the join key across Clerk, Convex and Stream.** Convex calls it `identity.subject`; the database calls it `clerkId`, `candidateId` and `interviewerId`; Stream calls it `user_id`. Same string throughout.
2. **One UUID links the Convex interview row to the Stream call.** I generate it in the browser, use it as the Stream call ID, and store it as `streamCallId`. That's how the app gets from "the call I'm in" back to "the interview record I need to update".

If you remember nothing else, remember those two.

---

## 2. Repository Mental Map

Only the files you might actually open in front of an interviewer.

```
CodeSync/
├── convex/                    <- the entire backend
│   ├── schema.ts              <- 3 tables + 3 indexes
│   ├── users.ts               <- syncUser, getUsers, getUserByClerkId
│   ├── interviews.ts          <- create / read / update interviews
│   ├── comments.ts            <- feedback: addComment, getComments
│   ├── http.ts                <- the Clerk webhook endpoint
│   └── auth.config.ts         <- which Clerk instance Convex trusts
│
├── src/
│   ├── middleware.ts          <- clerkMiddleware()
│   ├── actions/
│   │   └── stream.actions.ts  <- the ONLY server-side app code: Stream token
│   ├── app/
│   │   ├── layout.tsx         <- providers + signed-in gate
│   │   ├── (route)/
│   │   │   ├── layout.tsx     <- wraps these routes in StreamClientProvider
│   │   │   ├── (home)/page.tsx
│   │   │   ├── schedule/InterviewSchduleUI.tsx
│   │   │   ├── meeting/[id]/page.tsx
│   │   │   └── recordings/page.tsx
│   │   └── (admin)/dashboard/page.tsx   <- outside the Stream provider
│   ├── components/
│   │   ├── providers/ConvexClerkProvider.tsx
│   │   ├── providers/StreamClientProvider.tsx
│   │   ├── MeetingRoom.tsx    <- the split-screen layout
│   │   ├── CodeEditor.tsx     <- Monaco + Judge0
│   │   ├── EndCallButton.tsx  <- where Stream and Convex meet
│   │   └── CommentDialog.tsx  <- rating + feedback
│   ├── hooks/
│   │   ├── useUserRole.ts     <- candidate or interviewer
│   │   ├── useMeetingActions.ts
│   │   ├── useGetCallById.ts
│   │   └── useGetCalls.tsx
│   ├── constants/index.ts     <- coding questions, languages, time slots
│   └── lib/utils.ts           <- interview grouping + status helpers
```

| Path | What's in it | Why remember it | Interview topic it belongs to |
|---|---|---|---|
| `convex/schema.ts` | The 3 tables and 3 indexes | It's the shortest file that explains the whole data model | Database design, indexes |
| `convex/users.ts` | `syncUser`, `getUsers`, `getUserByClerkId` | Where the Clerk→Convex user copy is created and read | Webhooks, roles, indexes |
| `convex/interviews.ts` | All interview reads and writes | Contains both the best-written function (`getMyInterviews`) and the weakest (`updateInterviewStatus`) | Authorization, indexes |
| `convex/comments.ts` | Feedback | `addComment` shows the correct "derive the author from the token" pattern | Authorization done right |
| `convex/http.ts` | The Clerk webhook | The only signature-verification code in the repo | Webhooks, security |
| `convex/auth.config.ts` | The trusted Clerk issuer | Three lines that make `getUserIdentity()` work | Authentication |
| `src/actions/stream.actions.ts` | Stream token minting, `"use server"` | 12 lines, and the cleanest security story in the project | Client/server boundary, secrets |
| `src/components/providers/ConvexClerkProvider.tsx` | Clerk + Convex providers nested | How the JWT gets attached to every Convex call | Authentication |
| `src/components/providers/StreamClientProvider.tsx` | Builds the Stream client | Shows why the client can't exist until the user is known | Stream, React lifecycle |
| `src/components/MeetingRoom.tsx` | Split screen, layouts, `call.ended` | The visual answer to "what is this app?" | Architecture, real-time |
| `src/components/CodeEditor.tsx` | Monaco + Judge0 + terminal | Both the coolest feature and the biggest security flaw | Code execution, security |
| `src/components/EndCallButton.tsx` | End call + mark completed | The one place Stream and Convex are written in the same click | Consistency between services |
| `src/app/(route)/schedule/InterviewSchduleUI.tsx` | The scheduling form | Where the shared UUID is created | Scheduling, dual-write problem |
| `src/app/(admin)/dashboard/page.tsx` | Interviewer dashboard, pass/fail, feedback | Also where the missing role guard lives | Authorization |
| `src/hooks/useUserRole.ts` | Role lookup | How every role decision in the UI is made | Authorization |
| `src/lib/utils.ts` | `groupInterviews`, `getMeetingStatus` | Pure functions — the easiest thing to unit test if asked | Derived state, testing |
| `src/constants/index.ts` | 3 coding questions, 4 languages, time slots | Explains why there are only three problems | Product scope |

**Two structural details worth knowing:** `(route)` and `(admin)` are Next.js *route groups* — parentheses mean the folder name doesn't appear in the URL. `(route)` has a layout that wraps its pages in `StreamClientProvider`; `(admin)` has no layout, so `/dashboard` never loads the Stream client. That's deliberate for performance, and it's also why a Stream outage doesn't take the dashboard down.

---

## 3. Project in One Minute

**What it is.** A web app for running remote technical interviews. One browser tab holds both the video call and the coding environment, so nobody has to switch between Zoom and a separate coding pad.

**Who uses it.** Two roles stored on the user record: `interviewer` and `candidate`.

**What an interviewer can do**
- Schedule an interview for a future date and time, picking one candidate and one or more interviewers.
- Start an instant meeting, or join one by pasting a link.
- End the call for everyone, which also marks the interview completed.
- Open a dashboard of all interviews grouped by state, mark a completed one passed or failed, and leave a 1–5 star rating with written feedback.
- Browse call recordings from Stream.

**What a candidate can do**
- See their own scheduled interviews on the home page and join one when it goes live.
- Inside the meeting: pick one of three built-in coding questions, pick a language, write code in Monaco, type input, hit Run, see the output.

**Main features, as actually implemented**
1. Sign-in through Clerk, with the user copied into Convex by a webhook.
2. Interview scheduling stored in Convex, with the Stream call created at the same moment.
3. A meeting room split between video and a Monaco editor with problem statement and terminal.
4. Code execution through Judge0 for JavaScript, Python, Java and C++.
5. Pass/fail status plus rating and comment, stored in Convex.
6. Recording links read straight from Stream.

### 30-second answer

> "CodeSync is a remote technical interview platform. The idea is that a technical interview normally needs a video call in one tab and a coding tool in another, and then the feedback ends up somewhere else again. CodeSync puts all three in one place. It's a Next.js app — Clerk handles sign-in, Convex is my database and backend and it pushes updates to the browser when data changes, Stream handles the video call, and the editor is Monaco with Judge0 running the code. Interview records, pass/fail status and feedback all live in Convex."

---

## 4. What Problem Does CodeSync Solve?

The traditional setup:

```
Zoom / Meet          ->  video and audio
CoderPad / a Doc     ->  the coding surface
Email / spreadsheet  ->  scheduling
ATS / Notion / Sheet ->  feedback and the pass-fail decision
```

Four tools, four links, four places to lose information. The interviewer pastes a coding link into chat, the candidate alt-tabs, and afterwards someone has to remember to write feedback somewhere the recruiter will find it.

CodeSync's version is **one URL per interview**. Opening `/meeting/<callId>` gives you video and editor side by side, and the interview record that ties them together already exists — so when the call ends, that same record picks up a status and a rating.

**What my system owns**
- The interview record: title, description, start time, participants, status, and the Stream call ID.
- Each user's role, and the UI that follows from it.
- The coding UI: questions, starter code, language selection, input box, output terminal.
- The feedback: ratings and comments attached to an interview.

**What the external services own**
- **Clerk** — sign-in/sign-up, sessions, the identity token.
- **Stream** — WebRTC media, participant state, call lifecycle, recording storage.
- **Judge0** — sandboxed compilation and execution, returning stdout/stderr/status.
- **Convex** — hosting the backend functions and database, and pushing query results to clients when data changes.

---

## 5. What I Built vs What I Used a Service For

This table exists so you never accidentally claim to have built infrastructure you integrated. Being precise here makes you sound *more* credible, not less.

### I built

| Thing I built | Where | What that actually involved |
|---|---|---|
| The data model | `convex/schema.ts` | Three tables, three indexes, and the decision to use Clerk IDs as the join key |
| Interview scheduling | `InterviewSchduleUI.tsx` + `createInterview` | Form, validation, and creating the Stream call and the database row with one shared UUID |
| Webhook-based user provisioning | `convex/http.ts` + `syncUser` | Signature verification, event handling, and an idempotent insert |
| The authentication integration | `ConvexClerkProvider`, `auth.config.ts` | Wiring Clerk's JWT into Convex so `getUserIdentity()` works on the backend |
| Stream token minting | `src/actions/stream.actions.ts` | A server action that derives the user from the session, so the secret never reaches the browser |
| The meeting room UI | `MeetingRoom.tsx`, `MeetingSetup.tsx` | Resizable split screen, layout switching, participant panel, device pre-flight, `call.ended` handling |
| Monaco integration | `CodeEditor.tsx` | Controlled editor, per-language starter code, question switching, layout inside a resizable panel |
| Judge0 integration | `CodeEditor.tsx` `runCode()` | Language-ID mapping, submission shape, status interpretation, stdin support, terminal output |
| The feedback workflow | `dashboard/page.tsx`, `CommentDialog.tsx`, `addComment` | Status lifecycle, pass/fail, star ratings, comment threads keyed to an interview |
| Role-aware UI | `useUserRole.ts` and the pages that use it | Different home page, dashboard link and schedule access per role |
| Derived interview state | `src/lib/utils.ts` | Grouping interviews into buckets and deciding when a Join button appears |

### I used an external service for

| Capability | Service | What I'd have had to build otherwise |
|---|---|---|
| Authentication | Clerk | Password hashing, email verification, reset flows, sessions, OAuth, a user-management UI |
| Video and audio | Stream | Signalling, STUN/TURN servers, an SFU for multi-party routing, bandwidth adaptation, device handling |
| Recording storage | Stream | A recording pipeline, media storage, and signed playback URLs |
| Code execution sandbox | Judge0 | Per-submission containers, CPU/memory limits, network isolation, a job queue, toolchains for four languages |
| Database hosting + live queries | Convex | Postgres, an ORM, migrations, an API server, and either polling or a websocket layer with cache invalidation |

**The honest one-liner:** "I didn't build WebRTC or a code sandbox. I integrated services that provide them, and I designed the application and data model around them — including how the pieces stay consistent with each other."

---

## 6. Why This Project Is Interesting

Worth being able to say, because "I built a CRUD app" is what most student projects reduce to.

| Dimension | What CodeSync forced me to deal with |
|---|---|
| **Third-party integration** | Four services with four different auth models, all in one app. The hard part isn't any one SDK — it's making them agree about who the user is |
| **Authentication** | A real token flow: Clerk issues a JWT, Convex verifies it, and a separate server-side token is minted for Stream from the same identity |
| **Real-time application state** | Interview records and feedback update in connected browsers without polling, because Convex tracks what each query read |
| **Video** | Understanding *why* multi-party video needs an SFU, and deciding to integrate rather than build |
| **Code execution** | Reasoning about untrusted code: where it should run, what limits it needs, and what it means that it runs off my infrastructure |
| **Data modelling** | Choosing an identity key that works across three systems, and knowing the cost of that choice (no referential integrity on `candidateId`) |
| **Two systems, one action** | Scheduling writes to Stream *and* Convex with no transaction between them. That's a genuine distributed-systems problem in a student project |
| **Security** | Client/server boundaries, secret management, webhook signature verification, and a concrete IDOR-shaped gap I can describe and fix |
| **Scalability** | Being able to name which two queries break first, and why, without pretending the project already solves it |

**The framing to use:** "The interesting part of this project isn't that I built video conferencing or a compiler — I didn't. It's that I had to integrate four services that each have their own idea of identity and state, design an application around them, and figure out what happens when they disagree or go down."

---

## 7. High-Level Architecture

```
                          +-------------------------------------------+
                          |               BROWSER                     |
                          |    Next.js App Router (React 19, TS)      |
                          |                                           |
                          |  Root layout: ConvexClerkProvider         |
                          |    +- ClerkProvider                       |
                          |        +- ConvexProviderWithClerk         |
                          |  (route) layout: StreamClientProvider     |
                          +---+----------+----------+---------+-------+
                              |          |          |         |
              sign-in / token |          | queries  | WebRTC  | HTTPS POST
                              |          | mutations| + REST  | (code + API key)
                              v          v          v         v
                        +---------+ +---------+ +--------+ +----------+
                        |  CLERK  | | CONVEX  | | STREAM | |  JUDGE0  |
                        |  auth   | |  DB +   | | Video  | | (RapidAPI|
                        |         | |functions| |        | |   free)  |
                        +----+----+ +----^----+ +----^---+ +----------+
                             |           |           |
              user.created   |           |           | user token minted by a
              webhook (svix) +-----------+           | Next.js server action
                                                     | using STREAM_SECRET_KEY
                                    +----------------+--------------+
                                    | src/actions/stream.actions.ts |
                                    |         "use server"          |
                                    +-------------------------------+
```

### Component by component

| Component | What it does | Why it exists | What flows through it | Client or server | If it's unavailable |
|---|---|---|---|---|---|
| **Next.js app (browser)** | Renders every page; almost all client components | Routing, nested layouts, and one place for trusted server code | Everything the user sees | Mostly client-side; one server action | Nothing works |
| **Clerk** | Sign-in UI, session, JWT identity | So I never store passwords | Email, name, avatar URL, user ID | Client SDK + `currentUser()` on the server + middleware | The root layout redirects to sign-in, which is also down — app unusable |
| **Convex** | Database + backend functions + live query updates | One place for interview/user/comment data with automatic push updates | Users, interviews, comments | Client SDK talks to Convex directly over a websocket | Queries never resolve; pages sit on spinners |
| **Stream Video** | Media, participants, layouts, recordings | Building WebRTC infrastructure is out of scope | Media streams, call metadata, member list | Client SDK talks to Stream directly; token minted server-side | Every `(route)` page shows a loader forever; `/dashboard` still works |
| **Judge0 / RapidAPI** | Compiles and runs the candidate's code | Safely running untrusted code is a product on its own | Source, language ID, stdin -> stdout/stderr/status | **Called directly from the browser** (`CodeEditor.tsx`) | Terminal shows an error; the rest of the interview continues |
| **Next.js server action** | Mints the Stream user token | Keeps `STREAM_SECRET_KEY` off the client | Clerk user ID -> JWT | Server only | The Stream client can't authenticate |

**Two things to say out loud when you draw this:**
1. The browser talks to all four services **directly**. There's no API server of mine in the middle — the only server-side code I wrote is one server action plus the Convex functions.
2. The Judge0 arrow is the one that's wrong today: the API key is in the browser. It should point through a server function. (Full detail in Part II §17.)

---

## 8. Technology Choices

| Technology | What I use it for **in CodeSync** | Why it fits | The point to make |
|---|---|---|---|
| **Next.js 15 (App Router)** | Route groups `(route)` / `(admin)`, nested layouts to scope the Stream provider, one `"use server"` action, `clerkMiddleware()` | I needed a small amount of trusted server code without running a separate backend | Nearly every page is `"use client"`. I use Next for routing and one server action, not for heavy server rendering — say that rather than overstating it |
| **React 19** | All interactive state: selected question, language, editor contents, stdin, output, video layout, participant panel, dialogs, form fields | The whole product is interactive UI | The editor contents live only in `useState`. They go to Judge0 and nowhere else, and a refresh loses them |
| **TypeScript** | Convex generates types from the schema; components import `Doc<"interviews">` and `Id<"interviews">` | Types flow from schema to UI with no duplication | `Id<"interviews">` is a branded type, so you can't pass a user ID where an interview ID belongs |
| **Convex** | 3 tables, backend functions, an HTTP endpoint for the webhook, live queries via `useQuery` | Interview status and feedback should appear without a refresh | `useQuery` re-renders automatically when matching data changes — no polling, no socket code |
| **Clerk** | Sign-in/sign-up UI, `<UserButton/>`, `useUser()`, `currentUser()`, and the JWT Convex verifies | Auth is high-risk to build and isn't the point of the project | Convex's `identity.subject` **is** the Clerk user ID — that equality holds the data model together |
| **Stream Video SDK** | Browser client, Node SDK for tokens, plus ready-made UI: `SpeakerLayout`, `PaginatedGridLayout`, `CallControls`, `CallParticipantsList`, `VideoPreview`, `DeviceSettings` | Working multi-party video plus polished UI quickly | I use Stream's *UI components*, not just its transport — that's why `MeetingRoom.tsx` is ~120 lines |
| **Monaco Editor** | The editing surface: per-language highlighting, line numbers, word wrap, `vs-dark` | Candidates expect an editor that feels like VS Code | It's single-user here. No shared document, no remote cursors |
| **Judge0 (RapidAPI CE)** | POST source + language ID + stdin with `wait=true`, read back stdout/stderr/status | Sandboxed multi-language execution without owning infrastructure | Language IDs hardcoded in `CodeEditor.tsx`: JS `63`, Python `71`, Java `62`, C++ `54` |
| **Tailwind 4 + shadcn/ui** | All styling; Radix-based components in `src/components/ui/`; `next-themes` for dark mode | Consistent UI without hand-writing CSS | Configured via `@import "tailwindcss"` in `globals.css` + `@tailwindcss/postcss`. A leftover v3 `tailwind.config.js` sits unused |
| **`react-resizable-panels`** | The draggable split between video and editor, and inside the editor panel | The "one screen, two jobs" idea depends on it | This is what makes the integration *visible* |
| **`svix`** | Verifies the Clerk webhook signature | Clerk delivers webhooks through Svix | Verification is implemented correctly — mention it, it's a real security positive |
| **`date-fns`** | Date formatting and upcoming/live/completed logic | Small helper, no timezone library needed | `getMeetingStatus` assumes a one-hour interview via `addHours(startTime, 1)` |
| **`@vercel/speed-insights`** | Mounted in the root layout | Suggests Vercel deployment | There's no `vercel.json` in the repo, so don't state deployment details as fact |

---

## 9. The Whole App in One Page

The five flows, compressed. Part II expands each one.

```
1. SIGN IN
   Clerk sign-in -> JWT -> Convex verifies it -> identity.subject = Clerk user ID
   (separately) Clerk fires user.created -> webhook -> signature verified
                -> syncUser inserts the user with role "candidate"

2. SCHEDULE  (interviewer)
   pick candidate + date + time
   -> crypto.randomUUID()
   -> Stream: create the call with that UUID
   -> Convex: insert the interview row with streamCallId = that UUID

3. JOIN
   both open /meeting/<uuid>
   -> Stream client asks the server action for a token
   -> server action: Clerk says who you are -> sign a token with the Stream secret
   -> MeetingSetup (camera/mic preview) -> call.join() -> MeetingRoom

4. THE INTERVIEW
   left panel: Stream video (speaker or grid) + call controls
   right panel: problem statement / Monaco / stdin / terminal
   Run -> POST to Judge0 -> status 3 means success -> show stdout

5. FINISH
   End Meeting -> call.endCall() (everyone gets call.ended and goes home)
                -> updateInterviewStatus -> "completed" + endTime
   dashboard -> Pass or Fail -> rating + comment stored in Convex
```

**The one-sentence version:** Clerk tells me who you are, Convex remembers the interview, Stream carries the conversation, Monaco holds the code, and Judge0 runs it.
---
---

# PART II — TECHNICAL DEEP DIVE

Each section that maps to a common interview topic starts with a **three-tier box**:

- **Must know** — if you can't say this, don't claim the project.
- **Good to know** — for when the interviewer goes one level deeper.
- **Deep dive** — only if they really drill.

---

## 10. Flow 1 — Authentication and User Creation

**Files:** `src/app/layout.tsx`, `src/components/providers/ConvexClerkProvider.tsx`, `src/middleware.ts`, `convex/auth.config.ts`, `convex/http.ts`, `convex/users.ts`, `src/hooks/useUserRole.ts`

### Step by step

1. `src/middleware.ts` runs `clerkMiddleware()` on nearly every request. Note what it does *not* do: it never calls `auth.protect()`, so it doesn't block routes by itself. It attaches Clerk's auth context, nothing more.
2. `src/app/layout.tsx` wraps everything in `ConvexClerkProvider`, then renders `<SignedIn>{children}</SignedIn>` and `<SignedOut><RedirectToSignIn/></SignedOut>`. An anonymous visitor sees no app content — they're bounced to Clerk's hosted sign-in.
3. `ConvexClerkProvider` nests two providers: Clerk's `<ClerkProvider>` outside, `<ConvexProviderWithClerk client={convex} useAuth={useAuth}>` inside. That second one is the glue — it hands Clerk's `useAuth` hook to Convex so the Convex client can fetch a fresh JWT and attach it to every query and mutation.
4. Convex validates that JWT against `convex/auth.config.ts`, which declares one provider with a `domain` (a Clerk **development** instance, hardcoded rather than read from an env var) and `applicationID: "convex"`, which must match a JWT template of that name in the Clerk dashboard.
5. Inside any Convex function, `await ctx.auth.getUserIdentity()` returns an identity object, and **`identity.subject` is the Clerk user ID**.

### The webhook — why it exists

Clerk owns the user. Convex needs a copy so I can attach a role, list candidates in a dropdown, and show names and avatars next to interviews. Nothing in the client-side flow creates that copy — the webhook does.

**How it works** (`convex/http.ts`):
- Route: `POST /clerk-webhook` on Convex's HTTP router, publicly reachable on the deployment's `.convex.site` domain.
- Reads `CLERK_WEBHOOK_SECRET` from Convex's own environment (set in the Convex dashboard, not `.env.local`).
- Requires three Svix headers: `svix-id`, `svix-timestamp`, `svix-signature`. Missing any -> `400`.
- Verifies with `new Webhook(secret).verify(body, headers)`. **This is the authenticity check.** Svix computes an HMAC over the timestamp plus the raw body using the shared secret and compares it to the signature header. A forged request fails; a replayed old one fails the timestamp tolerance. Failure -> `400 Invalid webhook signature`, and nothing is written.
- Handles one event: **`user.created`**. Pulls `id`, `email_addresses[0].email_address`, `first_name`, `last_name`, `image_url`, then runs `api.users.syncUser`.
- Always returns `200` at the end, including for events it ignores.

### What `clerkId` represents

Clerk's user ID (the `user_xxxxx` string). It's the **join key for the whole application**: stored as `users.clerkId`, as `interviews.candidateId` and inside `interviews.interviewerIds`, as `comments.interviewerId`; used as the Stream user ID both when minting a token and when constructing the Stream client; and returned by Convex as `identity.subject`.

One string identifies a person across three systems. That's a deliberate design decision, and a good one to explain.

### Roles

**Current:** `syncUser` hardcodes `role: "candidate"` for every new user. `useUserRole()` reads it back via `getUserByClerkId` and returns `{ isLoading, isInterviewer, isCandidate }`, where `isLoading` is `userData === undefined` (Convex's convention for "not returned yet").

**Known limitation:** there's no code path that promotes a user to `interviewer` — I set that by hand in the Convex dashboard.

**Improvement:** an admin role plus a role-management screen, or role assignment through Clerk metadata carried in the JWT.

Say this plainly if asked. Inventing an admin panel that doesn't exist is the fastest way to get caught.

---

## 11. Flow 2 — Scheduling an Interview

**Files:** `src/app/(route)/schedule/page.tsx`, `src/app/(route)/schedule/InterviewSchduleUI.tsx` (the filename typo is in the repo), `convex/interviews.ts`, `src/constants/index.ts`

1. `SchedulePage` calls `useUserRole()`, shows a loader while it resolves, and pushes non-interviewers to `/`. **Known limitation:** that `router.push` happens inside the render body rather than in a `useEffect`, which is a React anti-pattern. It works, but it's a side effect during render.
2. The UI loads `getAllInterviews` (to list existing interviews under the form) and `getUsers` (to populate the dropdowns), then splits users into candidates and interviewers by role, entirely client-side.
3. Form state is one object: `title`, `description`, `date`, `time` (an `"HH:MM"` string from `TIME_SLOTS` — 09:00 to 19:00 in 30-minute steps), `candidateId`, and `interviewerIds` pre-seeded with the current user.
4. Validation before submit: a candidate and at least one interviewer are required; the calendar disables past dates; and if the date is today it rejects a slot whose **hour** is below the current hour. **Known limitation:** that hour comparison is coarse — at 14:20 the 14:00 slot is still accepted. **Improvement:** compare full timestamps, and validate inside the mutation too.
5. On submit:
   ```
   id = crypto.randomUUID()
   client.call("default", id).getOrCreate({ data: { starts_at, custom: { description, additionalDetails } } })
   createInterview({ title, description, startTime, status: "upcoming", streamCallId: id, candidateId, interviewerIds })
   ```
   The **same UUID** becomes the Stream call ID and the Convex `streamCallId`.
6. Success -> close dialog, toast, reset. Failure -> `console.error` plus a toast.

### Which data lives where

| Data | Convex | Stream |
|---|---|---|
| Title, description | yes | also copied into the call's `custom` object |
| Start time | yes (`startTime`, epoch ms) | yes (`starts_at`, ISO string) |
| Candidate & interviewer IDs | yes | **no** — never added as Stream call members |
| Status / pass-fail | yes | no |
| Call ID | yes (`streamCallId`) | yes (the call's own ID) |
| Media, recordings | no | yes |

### Two things worth raising yourself

**The members gap.** `getOrCreate` is called without a `members` array, so the candidate is never registered as a Stream call member.
- *Current:* who can join is decided by Stream's `default` call type, not by my interview record.
- *Consequence:* `useGetCalls` (used by `/recordings`) filters on creator-or-member, so candidates see no recordings.
- *Improvement:* pass `members: [candidateId, ...interviewerIds]` on `getOrCreate` and tighten the call type's permissions. One line, fixes both problems.

**Two writes, no transaction.** The Stream call and the Convex row are two separate network calls.
- *Current:* if `getOrCreate` succeeds and `createInterview` fails, there's an orphaned Stream call with no interview record.
- *Improvement:* write the Convex row first in a `pending` state, create the Stream call from a server function keyed by the same UUID so retries are idempotent, then mark it ready — plus a periodic reconciliation job.

This is a genuine distributed-write problem, and being able to describe it clearly is one of the better things this project gives you to talk about.

---

## 12. Flow 3 — Creating and Joining a Meeting

**Files:** `src/hooks/useMeetingActions.ts`, `src/components/MeetingModel.tsx`, `src/components/providers/StreamClientProvider.tsx`, `src/actions/stream.actions.ts`, `src/hooks/useGetCallById.ts`, `src/app/(route)/meeting/[id]/page.tsx`

**Instant meeting** (interviewer only, from the "New Call" card):
```
crypto.randomUUID()
  -> client.call("default", id).getOrCreate({ starts_at: now, custom.description: "Instant Meeting" })
  -> router.push(`/meeting/${call.id}`)
```
*Current:* no Convex row is created for an instant meeting. *Known limitation:* so it has no interview record, `EndCallButton` renders nothing (it needs `getInterviewByStreamCallId` to return something), and it never reaches the dashboard. *Improvement:* create an interview row for instant meetings too.

**Scheduled meeting:** the candidate's home page lists interviews from `getMyInterviews`. `MeetingCard` computes status with `getMeetingStatus()`; when it's `"live"`, Join calls `joinMeeting(interview.streamCallId)`, which is just `router.push('/meeting/' + callId)`.

**Join by link:** the modal takes a pasted URL and does `meetingUrl.split("/").pop()` to grab the last segment. Crude but effective; a bad ID lands on "Meeting not found".

### How the Stream client is initialised

`StreamClientProvider` is mounted in `src/app/(route)/layout.tsx`, so it wraps `/`, `/schedule`, `/recordings` and `/meeting/[id]` — but **not** `/dashboard`, which is in the `(admin)` group with no layout. In a `useEffect` keyed on `[user, isLoaded]` it builds:

```ts
new StreamVideoClient({
  apiKey: process.env.NEXT_PUBLIC_STREAM_API_KEY!,   // public, safe in the browser
  user: { id: user.id, name: /* ... */ },            // Clerk user ID
  tokenProvider: streamTokenProvider,                // the server action
})
```

Until the client exists it renders `LoaderUI`. *Known limitation:* there's no error state, so if token minting throws, the user sits on a spinner. *Improvement:* a timeout plus an error message, and let the non-video pages render with video disabled.

*Minor bug worth knowing:* the display-name expression is `user?.firstName || ""+ " " + user?.lastName || "" || user?.id`. Precedence makes it effectively `firstName || (" " + lastName) || id`, so the names are never combined. Harmless, but an interviewer reading the file might spot it.

### The token flow, and why the secret stays on the server

```
Browser                       Next.js server ("use server")           Stream
  |                                      |                              |
  |  Stream SDK needs a token            |                              |
  |---- calls streamTokenProvider() ---->|                              |
  |                                      | currentUser()  (Clerk)       |
  |                                      |   -> throws if no session    |
  |                                      | new StreamClient(            |
  |                                      |   NEXT_PUBLIC_STREAM_API_KEY,|
  |                                      |   STREAM_SECRET_KEY)         |
  |                                      | generateUserToken({user_id}) |
  |<------------- JWT -------------------|                              |
  |------------- connect with JWT ------------------------------------->|
```

`streamTokenProvider` is 12 lines, and every line matters:
- `"use server"` means the body is compiled into the server bundle only. Calling it from a client component becomes an RPC to the Next.js server.
- `currentUser()` is Clerk's server-side helper. No session -> throw. **This is the authorization check.**
- The function takes **no parameters**, so a caller can't request a token for someone else — the user ID comes from the session.
- The token is signed with `STREAM_SECRET_KEY`. **That secret can mint a token for any user on my Stream app.** In the browser, anyone could impersonate any user, join any call and query recordings. Next only inlines `NEXT_PUBLIC_*` variables into client bundles, so the secret stays server-side by construction.

### Loading the call

`useGetCallById` calls `client.queryCalls({ filter_conditions: { id } })` and takes the first result, setting `isCallLoading` false in a `finally`. The meeting page then renders `LoaderUI` while loading, "Meeting not found" if there's no call, and otherwise `<StreamCall><StreamTheme>` wrapping `MeetingSetup` or `MeetingRoom` depending on `isSetupComplete`.

---

## 13. Flow 4 — Inside the Meeting Room

**Files:** `src/components/MeetingSetup.tsx`, `src/components/MeetingRoom.tsx`, `src/components/EndCallButton.tsx`

**Setup screen.** Before joining, `MeetingSetup` shows Stream's `<VideoPreview/>`, switches for camera and mic (camera starts **off**, mic **on**), and `<DeviceSettings/>`. Join calls `await call.join()` guarded by a `joining` flag so a double-click can't join twice, then flips `isSetupComplete`.

*Known limitation:* `if (!call) return null;` sits **above** the two `useEffect` calls, which breaks the Rules of Hooks. It doesn't crash today because `useCall()` inside `<StreamCall>` is never null. *Improvement:* move the guard below the hooks.

**Room layout.** A horizontal `ResizablePanelGroup`:
- Left (35% default): video. `layout === "grid" ? <PaginatedGridLayout/> : <SpeakerLayout/>`, defaulting to speaker. A dropdown switches them; a toggle slides `<CallParticipantsList/>` in as a 300px overlay.
- A drag handle — this is the "one screen, two jobs" mechanic.
- Right (65% default): `<CodeEditor/>`.

**Call controls.** Stream's `<CallControls onLeave={() => router.push("/")}/>` gives mute, camera, screen share and leave. Leaving routes you home; the call continues for everyone else.

**Ending for everyone.** `EndCallButton`:
- Looks up the interview via `getInterviewByStreamCallId` using `call.id`. No interview -> renders nothing.
- Renders only if `localParticipant?.userId === call.state.createdBy?.id`. This is a **client-side** check.
- On click: `await call.endCall()`, then `updateInterviewStatus({ id, status: "completed" })`, then route home and toast.

**Handling `call.ended`.** `MeetingRoom` subscribes in a `useEffect` and cleans up with `call.off` on unmount:
```ts
call.on("call.ended", () => router.push("/"));
```
So when the owner ends the call, every participant's browser receives the event and navigates home.

**Guard while connecting.** If `callingState !== CallingState.JOINED`, the room shows a spinner.

*Known limitation:* only the owner's client updates Convex. If that browser dies between `endCall()` and the mutation, the call ends for everyone but the record stays `"upcoming"`. *Improvement:* subscribe to Stream's `call.ended` webhook and update status server-side.

*Leftover in the repo:* `MeetingRoom.tsx:116` still has `<h1>code editor will go here</h1>` under `<CodeEditor/>`. Cosmetic, but know it's there if you demo.

---

## 14. Flow 5 — The Coding Flow

**File:** `src/components/CodeEditor.tsx` (questions in `src/constants/index.ts`)

**State in the component:**
```
selectedQuestion  -> one of CODING_QUESTIONS (default "two-sum")
language          -> "javascript" | "python" | "java" | "cpp" (default javascript)
code              -> editor contents, initialised to the question's starter code
output            -> the terminal string
userInput         -> the stdin textarea
```

**Question and language selection.** Both dropdowns overwrite `code` with the relevant starter code.
- *Known limitation:* switching either one silently discards what the candidate has typed, with no confirmation.
- *Improvement:* keep a draft per (question, language) pair, and confirm before overwriting.

**The question bank** is three hardcoded problems — Two Sum, Reverse String, Palindrome Number — each with description, examples, optional constraints, and starter code in all four languages. *Known limitation:* no question database and no authoring UI. (The Java starter for Reverse String has a stray comma and wouldn't compile as-is.)

**Running code.** `runCode()`:
1. `setOutput("Running...")`.
2. Maps the language to a Judge0 ID:

   | Language | `language_id` | Runtime |
   |---|---|---|
   | JavaScript | `63` | Node.js |
   | Python | `71` | Python 3 |
   | Java | `62` | Java (OpenJDK) |
   | C++ | `54` | C++ (GCC; source comment says "g++ 17.2") |

3. `POST https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true` with a body of `source_code`, `language_id`, `stdin: userInput`, `expected_output: null`, `cpu_time_limit: 5`, `memory_limit: 128000` (KB, ~128 MB).
   - `base64_encoded=false` -> plain text both ways.
   - `wait=true` -> **synchronous**: the request doesn't return until execution finishes. Simple, but it can hang, and there's no timeout or `AbortController`.
4. Interpreting the response:
   - `!data || !data.status` -> `"Error: Invalid response from API."` (this is what you see when the quota is exhausted or the key is rejected, because the error body has no `status`).
   - `data.status.id === 3` means **Accepted** -> show `data.stdout` or `"No Output"`.
   - Anything else -> `Error: <description>` plus `stderr`.
   - A thrown fetch -> `"Error executing code"`, and the real error is swallowed.

**What isn't here:** no test cases, no expected-output comparison (`expected_output` is explicitly `null`), no submission history, and the code is never saved. Only the candidate's browser has it.

### Two things to fix, and to volunteer before you're asked

> **SECURITY — this one is a real vulnerability, not a rough edge.**
> The RapidAPI key is a **hardcoded string literal in `CodeEditor.tsx`**, a client component. It ships in the JavaScript bundle every visitor downloads, and it's committed to git history. Its value is not reproduced anywhere in this document.
> **Rotate the key in the RapidAPI dashboard.** Rotation is what matters — deleting the line doesn't help, because the key remains in history and in any deployed bundle. Then move the call server-side so the new key never reaches a browser. Purging git history is worth doing too, but *after* rotating.

> **Compile errors are unhelpful.** *Current:* the code reads `stderr`, but Judge0 puts compiler messages in `compile_output`, which is never read — so a C++ or Java compile failure often shows an empty error. *Improvement:* read and display `compile_output`. Tiny change, big UX difference.

---

## 15. Flow 6 — Completion and Feedback

**Files:** `EndCallButton.tsx`, `dashboard/page.tsx`, `CommentDialog.tsx`, `convex/interviews.ts`, `convex/comments.ts`, `src/lib/utils.ts`

**Status lifecycle** — `status` is a plain `v.string()` in the schema, so these values are a convention, not a constraint:

```
"upcoming"  --(interviewer clicks End Meeting)-->  "completed"
                                                       |
                                    dashboard buttons --+-->  "succeeded"
                                                        +-->  "failed"
```
Only `updateInterviewStatus` writes it, and `"completed"` also stamps `endTime: Date.now()`.

**Dashboard grouping** (`groupInterviews` in `src/lib/utils.ts`) doesn't simply group by status. In order: `succeeded` -> succeeded; `failed` -> failed; else `startTime` in the past -> **completed**; else in the future -> **upcoming**.
- *Known limitation:* an interview whose start time has passed appears under "Completed" even if nobody ended the call — but the Pass/Fail buttons only render when the stored `status === "completed"`. So those two can disagree.
- *Improvement:* derive both from one function so there's a single source of truth.

**Feedback.** `CommentDialog` reads `getComments` for the interview and `getUsers` (to resolve author IDs to names/avatars), shows a 1–5 star `Select` and a textarea, and calls `addComment({ interviewId, content, rating })`. Note `interviewerId` is **not** a parameter — the mutation takes it from `identity.subject` server-side, so nobody can post feedback under another interviewer's name. Because Convex queries are live, the new comment appears with no refetch.

**Who can see feedback?** *Current:* only the dashboard renders `CommentDialog`, and `DashboardBtn` hides itself for candidates. *Known limitation:* the `/dashboard` route itself has no role guard, so a candidate who types the URL sees every interview and every comment. Full detail in §19 and §26.

---

## 16. Flow 7 — Recordings

**Files:** `recordings/page.tsx`, `useGetCalls.tsx`, `RecordingCard.tsx`

1. `useGetCalls()` asks Stream for calls sorted by `starts_at` descending, filtered to calls that have a `starts_at` **and** where `created_by_user_id === me` **or** `members $in [me]`.
2. The page loops over every call calling `call.queryRecordings()` in parallel via `Promise.all`, then flattens.
3. `RecordingCard` shows the start time, a duration from `calculateRecordingDuration`, a play button (`window.open(recording.url)`), and a copy-link button.

**Storage:** recordings are **entirely Stream's**. Nothing about a recording is stored in Convex — no URL, no duration, no link to an interview row. The app is a thin viewer.

**Current behaviour worth knowing:**
- Because scheduled calls have no `members` (§11), candidates see zero recordings; only the creating interviewer does.
- Nothing in the repo *starts* a recording — there's no `call.startRecording()` anywhere. Recording has to be enabled on the Stream call type or triggered from Stream's own controls.
- Whether a recording URL is public or signed is decided by Stream's configuration, not by my code.
- `isLoading` in `useGetCalls` is initialised `false` and only ever set to `false`, so the loading spinner effectively never shows. Minor bug.

---

## 17. Data Model

> **Must know:** three tables (`users`, `interviews`, `comments`), three indexes, and why `candidateId` stores a Clerk ID rather than a Convex document ID.
> **Good to know:** what each index is for, and the three different kinds of ID in the system.
> **Deep dive:** the referential-integrity trade-off of using loose string references, and why there's no index for "interviews I'm conducting".

Straight from `convex/schema.ts`. Every table also gets `_id` (typed `Id<"tableName">`) and `_creationTime` for free — `CommentDialog` uses `_creationTime` to timestamp feedback.

### `users`

| Field | Type | Meaning |
|---|---|---|
| `name` | `string` | `"first last"` assembled by the webhook |
| `email` | `string` | first email from Clerk |
| `image` | `string?` | Clerk avatar URL |
| `role` | `"candidate" \| "interviewer"` | the only enum-validated field in the schema |
| `clerkId` | `string` | Clerk's user ID — the cross-system join key |

**Index `by_clerk_id`** — because `getUserByClerkId` runs on every page load through `useUserRole()`. Without it, that's a full table scan each time.

### `interviews`

| Field | Type | Meaning |
|---|---|---|
| `title` | `string` | shown on cards |
| `description` | `string?` | optional |
| `startTime` | `number` | epoch **milliseconds** |
| `endTime` | `number?` | set only when status becomes `"completed"` |
| `status` | `string` | `upcoming` / `completed` / `succeeded` / `failed` **by convention** |
| `streamCallId` | `string` | the UUID that is also the Stream call ID |
| `candidateId` | `string` | a **Clerk** user ID, not a Convex `Id<"users">` |
| `interviewerIds` | `string[]` | array of Clerk user IDs |

**Index `by_candidate_id`** — powers `getMyInterviews`, the candidate's home page. Without it, every candidate page load scans every interview ever created.
**Index `by_stream_call_id`** — powers `getInterviewByStreamCallId`, called on every meeting page, to turn "the call I'm in" into "the row to update".

*Known limitation:* there's no index for `interviewerIds`, because Convex can't do an equality index into an array field this way. That's why the dashboard just calls `getAllInterviews()` and filters nothing. *Improvement:* a join table with one row per interview-interviewer pair, indexed by interviewer.

### `comments`

| Field | Type | Meaning |
|---|---|---|
| `content` | `string` | the feedback text |
| `rating` | `number` | 1–5, enforced only by the UI dropdown |
| `interviewerId` | `string` | Clerk ID of the author, from `identity.subject` |
| `interviewId` | `Id<"interviews">` | a **real Convex document reference** |

**Index `by_interview_id`** — turns "all feedback for this interview" from a scan into a range read.

### Relationship diagram

```
              users
              -----
              clerkId  (string, Clerk's user id)
              role: candidate | interviewer
                 ^                    ^
                 |                    |
   candidateId --+                    +-- interviewerIds[]   <- both are LOOSE string
       (string)                            (string[])           references, NOT
                 +------------------+                           enforced by Convex
                 |    interviews    |
                 |  _id: Id<...>    |
                 |  streamCallId ---+---->  Stream call (external system)
                 +--------+---------+
                          | interviewId : Id<"interviews">   <- the ONLY typed reference
                          v
                    +-----------+
                    | comments  |  interviewerId -> users.clerkId (a string again)
                    +-----------+
```

### The three kinds of ID

| ID | Looks like | Who issues it | Where it appears |
|---|---|---|---|
| **Clerk user ID** | `user_2abc...` | Clerk | `users.clerkId`, `interviews.candidateId`, `interviewerIds`, `comments.interviewerId`, Convex's `identity.subject`, the Stream token's `user_id` |
| **Convex document ID** | opaque, typed `Id<"interviews">` | Convex on insert | `interview._id`, used by `updateInterviewStatus`, stored as `comments.interviewId` |
| **Stream call ID** | a `crypto.randomUUID()` | **my own client code** | the URL `/meeting/<id>`, `interviews.streamCallId`, and Stream's call record |

**Why they're different:**
- I can't use the Convex `_id` as the identity key, because Convex only learns about a user *after* the webhook fires — whereas Clerk's ID exists from the first moment and is the same ID Stream needs. Using `clerkId` everywhere means no extra lookup to go from "who's signed in" to "which interviews are theirs".
- *Known limitation:* because `candidateId` is a plain `string` and not `v.id("users")`, Convex doesn't validate that the referenced user exists. I could store an interview for a candidate who was never created. *Improvement:* use `v.id("users")` and accept the extra lookup — referential integrity is worth more than saving one read. This is the best answer to "what would you change about your schema".
- The Stream call ID is a client-generated UUID: 122 random bits, not guessable. But it does mean the URL is effectively the access control unless Stream's call-type permissions say otherwise.

---

## 18. Convex Deep Dive

> **Must know:** Convex is my database *and* my backend functions. Queries are read-only and stay live; mutations are transactional writes. `useQuery` re-renders when the data changes.
> **Good to know:** how the live updates actually work (Convex tracks which documents a query read), the difference between `withIndex` and `filter`, and that every public function is an internet-facing endpoint.
> **Deep dive:** actions (which I don't use, and why that matters for Judge0), the generated API, and the specific auth gaps per function.

**One sentence:** Convex is a hosted backend where you write TypeScript functions that read and write a document database, and the client library keeps the results of any query you're subscribed to up to date automatically.

### The three function types

- **`query`** — read-only. Convex records exactly which documents the query read; when any of them change it re-runs the query and pushes the new result to every subscribed client. This is the "real-time" in my resume.
- **`mutation`** — read + write, running as a **single transaction**. Two mutations touching the same data are serialised, and Convex retries on conflict. I never wrote locking code.
- **`action`** — for calling the outside world (fetch, third-party SDKs). **I define zero actions**, which is exactly why the Judge0 call ended up in the browser. That's the single most useful thing to know about Convex actions for this project.

**Generated API.** `npx convex dev` writes `convex/_generated/api.d.ts` and `dataModel.d.ts`. That's why the client can write `api.interviews.getMyInterviews` with full type inference, and why `Doc<"interviews">` and `Id<"interviews">` exist in React code. The generated file lists exactly four modules: `comments`, `http`, `interviews`, `users`.

**Auth context.** `await ctx.auth.getUserIdentity()` returns `null` with no valid JWT, or an identity whose `subject` is the Clerk user ID. It works because `ConvexProviderWithClerk` attaches a Clerk JWT to every request and `auth.config.ts` names the trusted issuer.

**Indexes.** `.withIndex("name", q => q.eq("field", value))` uses the index. `.filter(q => q.eq(...))` does **not** — it scans and filters in memory. The repo has one example of each, and the difference matters.

### Function by function

#### `users.syncUser` (mutation)
- **Why:** mirror a Clerk user into Convex so I can attach a role and show names.
- **In:** `name`, `email`, `clerkId`, `image?`.
- **Does:** looks for an existing user with that `clerkId`; returns early if found (idempotent — webhooks retry); otherwise inserts with `role: "candidate"`.
- **Called by:** `convex/http.ts` only.
- **Known limitations:** (a) it uses `.filter()` rather than the `by_clerk_id` index that already exists, so it's a full table scan on every signup — a one-line fix, and a good self-aware detail to volunteer; (b) it's a **public mutation with no auth check**, so anyone who knows the deployment URL (which is in the client bundle) could insert user rows. *Improvement:* make it an `internalMutation`, callable only from other Convex functions including the webhook handler.

#### `users.getUsers` (query)
- **Why:** the scheduling dropdowns and comment-author lookup need the user list.
- **Does:** returns `[]` if there's no identity; otherwise `.collect()` on the whole table.
- **Called by:** `InterviewSchduleUI`, `DashboardPage`, `CommentDialog`.
- **Known limitation:** returns every user's name, email, avatar and role to every signed-in user, and it's unbounded. *Improvement:* narrower queries (`getCandidates` / `getInterviewers`) returning only `{ clerkId, name, image }`, with pagination or search.

#### `users.getUserByClerkId` (query)
- **Why:** resolve the signed-in user's role.
- **Does:** indexed lookup on `by_clerk_id`; returns the doc or `null`.
- **Called by:** `useUserRole()`.
- **Known limitations:** no auth check and no check that the requested ID is your own. Also, on the first render `user?.id` is undefined so it queries with `clerkId: ""`, which returns `null` — and `null` is not `undefined`, so `isLoading` goes false while the role is still unknown. That's why `DashboardBtn` can flicker. *Improvement:* use Convex's `"skip"` argument so the query doesn't run until the ID exists.

#### `interviews.getAllInterviews` (query)
- **Why:** the dashboard and schedule page list everything.
- **Does:** throws `"Unauthorized"` if not signed in, otherwise `.collect()` on the whole table.
- **Known limitation:** the check is "signed in", not "is an interviewer", so any candidate can read every interview. Unbounded too. *Improvement:* a role check plus scoping to interviews the caller is on, plus pagination.

#### `interviews.getMyInterviews` (query) — **the one to point at**
- **Why:** the candidate's home page.
- **Does:** returns `[]` if unauthenticated; otherwise an **indexed** query on `by_candidate_id` where `candidateId === identity.subject`.
- **Why it's the model:** the filter value comes from the server-side identity, never from a client argument, so a client can't ask for someone else's interviews. This is the pattern the other functions should follow — when an interviewer asks how you'd fix authorization, this is your evidence that you know what "fixed" looks like.
- *Note:* it only matches `candidateId`, so an interviewer gets `[]`. Fine, since interviewers see quick-action cards instead — but there's no "interviews I'm conducting" view.

#### `interviews.getInterviewByStreamCallId` (query)
- **Why:** turn a Stream call ID into an interview row so End Meeting can mark it completed.
- **Does:** indexed lookup, `.first()`.
- **Known limitation:** no auth check, so anyone with a call ID can read the full interview record.

#### `interviews.createInterview` (mutation)
- **Why:** persist a scheduled interview.
- **Does:** throws if unauthenticated, then inserts.
- **Known limitations:** verifies you're signed in but not that you're an interviewer; doesn't validate that `startTime` is in the future (that check lives only in the form); doesn't check that `candidateId` refers to a real user.

#### `interviews.updateInterviewStatus` (mutation)
- **Why:** move an interview through its lifecycle and stamp `endTime`.
- **Does:** `ctx.db.patch(id, { status, ...(status === "completed" ? { endTime: Date.now() } : {}) })`.
- **Called by:** `EndCallButton` and the dashboard Pass/Fail buttons.
- **This is a real security gap, not a rough edge:** the mutation never calls `getUserIdentity()`. It's a public, unauthenticated write, so anyone with an interview `_id` can set any outcome. `status` is also an unvalidated string. *Improvement:* add an identity + role check, assert the caller is on the interview, and change `status` to a union of literals. Three lines of work.

#### `comments.addComment` (mutation)
- **Why:** record interviewer feedback.
- **Does:** throws if unauthenticated; inserts with `interviewerId: identity.subject`.
- **Why it's well written:** the author comes from the verified token, so authorship can't be forged.
- **Known limitation:** no check that the caller is an interviewer or is on this interview; `rating` isn't range-checked.

#### `comments.getComments` (query)
- **Does:** indexed lookup on `by_interview_id`, `.collect()`.
- **Known limitation:** no auth check, so feedback about a candidate is readable by anyone with the interview ID.

### The summary table to memorise

| Function | Auth check | Role check | Uses an index |
|---|---|---|---|
| `syncUser` | none | — | no, uses `.filter()` |
| `getUsers` | yes (returns `[]`) | no | n/a (full scan by design) |
| `getUserByClerkId` | none | no | yes |
| `getAllInterviews` | yes (throws) | no | n/a (full scan by design) |
| `getMyInterviews` | yes (returns `[]`) | implicitly — own data only | yes |
| `getInterviewByStreamCallId` | none | no | yes |
| `createInterview` | yes (throws) | no | — |
| `updateInterviewStatus` | **none** | no | — |
| `addComment` | yes (throws) | no | — |
| `getComments` | none | no | yes |

---

## 19. Authentication and Authorization

> **Must know:** authentication is "who are you" (Clerk issues a JWT, Convex verifies it, `identity.subject` is the Clerk user ID). Authorization is "what may you do" — roles exist and drive the UI, but backend enforcement is incomplete.
> **Good to know:** the exact chain from sign-in to `getUserIdentity()`, and which functions check what.
> **Deep dive:** the specific gaps (`updateInterviewStatus`, the `/dashboard` route, `syncUser` being public) and the one-helper fix.

**Authentication = "who are you?"** — proving identity.
**Authorization = "what are you allowed to do?"** — deciding whether *this* identity may perform *this* action on *this* data.

CodeSync does authentication properly. **Authorization is implemented in the UI and incomplete on the backend.** That distinction is the most important thing in this section, and the thing a good interviewer will probe.

### How authentication works

1. Clerk hosts sign-in/sign-up and owns the session.
2. `clerkMiddleware()` attaches Clerk's auth context. It never calls `auth.protect()`, so it doesn't block routes.
3. The root layout gates rendering with `<SignedIn>` / `<SignedOut><RedirectToSignIn/></SignedOut>`. That's the only route-level gate, and it's all-or-nothing.
4. `ConvexProviderWithClerk` makes the Convex client fetch a Clerk JWT (from the `convex` template) and send it with every call.
5. Convex verifies the issuer against `auth.config.ts` and exposes `ctx.auth.getUserIdentity()`.
6. `identity.subject` is the Clerk user ID. Every server-side identity decision reduces to that one string.
7. Separately, `streamTokenProvider` calls `currentUser()` and mints a Stream token for exactly that ID — so Stream identity derives from Clerk identity too.

### How authorization works

**Current, in the UI:**
- `useUserRole()` gives `isInterviewer` / `isCandidate`.
- Home page: interviewers see quick-action cards, candidates see their interview list.
- `DashboardBtn` renders nothing for candidates.
- `/schedule` redirects non-interviewers to `/`.
- `EndCallButton` renders only for the call creator.

**Current, on the backend:** four of the ten Convex functions check that you're signed in. None checks a role, and none checks that you're a participant in the interview you're touching.

### The gaps, stated plainly

| Gap | Where | Impact |
|---|---|---|
| `/dashboard` has no role guard | `src/app/(admin)/dashboard/page.tsx` never calls `useUserRole()`, and the `(admin)` group has no layout | A signed-in candidate who types the URL sees every interview, every candidate name and all feedback, with working Pass/Fail buttons |
| `updateInterviewStatus` has no auth check | `convex/interviews.ts` | Any caller with an interview ID can change any outcome |
| `getComments`, `getInterviewByStreamCallId`, `getUserByClerkId`, `syncUser` have no auth check | `convex/*.ts` | Callable without a session, directly against the public Convex deployment URL |
| `getAllInterviews` and `getUsers` check sign-in but not role | `convex/*.ts` | Every candidate can read all interviews and all user emails |
| `EndCallButton`'s owner check is client-side | `src/components/EndCallButton.tsx` | Hiding a button doesn't stop the mutation being called. Stream itself rejects `endCall()` from a non-permitted user, but the Convex write is unprotected |
| Role can only be changed in the Convex dashboard | `syncUser` hardcodes `"candidate"` | No self-serve interviewer creation — which also means no escalation path through the app |

### The improvement, in one paragraph

Write two helpers in `convex/` — `requireUser(ctx)`, which loads the caller's user document from `identity.subject` and throws if there isn't one, and `requireInterviewer(ctx)`, which additionally asserts the role — then call them at the top of every function, plus a membership check where the interview is known. Add a layout to the `(admin)` group that guards the whole route. That's roughly a day's work and it closes every row in the table above.

**The pattern already exists in the codebase in the right form.** `addComment` takes the author from the verified identity; `getMyInterviews` filters by it rather than by a client argument. The fix is applying that idea consistently, not inventing something new — and saying it that way is much stronger than either hiding the gap or calling the project broken.

---

## 20. Real-Time Behavior

> **Must know:** two separate real-time systems. Stream is real-time for the *conversation*; Convex is real-time for the *record*. The code editor is real-time for nobody.
> **Good to know:** how Convex's live queries work (it tracks which documents a query read and re-pushes when they change).
> **Deep dive:** exactly what is and isn't synchronised, and what collaborative editing would take.

```
                REAL-TIME IN CODESYNC
                =====================

  STREAM handles           |   CONVEX handles
  -------------            |   --------------
  audio / video media      |   interview rows
  who is in the call       |   pass / fail status
  mute + camera state      |   comments and ratings
  screen share             |   the user list
  call.ended event         |
  recordings               |
                           |
  transport: WebRTC        |   transport: websocket to Convex
  latency: milliseconds    |   latency: sub-second
```

### What genuinely needs to be real-time

1. **Video and audio** — Stream, over WebRTC.
2. **Call lifecycle** — when the interviewer ends the call, everyone must know immediately. Stream's `call.ended`, handled in `MeetingRoom`.
3. **Interview state** — when an interview is created or its status changes, other open clients should see it. Convex, automatically.
4. **Feedback** — a comment added by one interviewer appears for another with the dialog open. Convex, automatically.

### How Convex delivers it, in plain terms

You call `useQuery(api.interviews.getMyInterviews)`. Behind that, the Convex client opens a websocket and registers a subscription. Convex runs the query on the server and remembers **which documents it read**. When a later mutation writes one of those documents, Convex re-runs the query and pushes the new result down the socket. React re-renders. No socket code, no polling, no cache invalidation.

Concretely:
- Interviewer schedules -> `createInterview` inserts a row -> the candidate's open home page updates by itself.
- Interviewer ends the call -> `updateInterviewStatus` -> an open dashboard moves the card into Completed by itself.
- Interviewer submits a comment -> `addComment` -> the comment list updates by itself.

The `undefined` convention matters: `useQuery` returns `undefined` while loading, then the value. Almost every component uses `=== undefined` as its loading check.

### What is NOT real-time — say this before you're asked

- **The code editor.** `code` is plain React state in `CodeEditor.tsx`. It's never written to Convex, never broadcast over Stream, never shared. **The interviewer cannot see what the candidate is typing.** Each participant has an independent editor.
- **Question and language selection** — also local, also unshared.
- **Execution output** — only the person who clicked Run sees it.
- **Recordings** — fetched once in a `useEffect`; no live updates.
- **The Stream calls list** — a one-shot `queryCalls`, not a subscription.

**Clean phrasing:** "Stream is real-time for the conversation. Convex is real-time for the record. The editor is local state — making it collaborative is the biggest feature I'd add next, and I know roughly how I'd do it."
---

## 21. External Services

### Clerk

> **Must know:** Clerk owns sign-in and identity, and issues a JWT that Convex verifies. `identity.subject` is the Clerk user ID.
> **Good to know:** the webhook that copies the user into Convex, and why the role lives in Convex rather than Clerk.
> **Deep dive:** Svix signature verification, and the fact that the configured Clerk instance is a development one.

- **Purpose:** authentication and user identity.
- **Integration:** `<ClerkProvider>` inside `ConvexClerkProvider`; `clerkMiddleware()`; `<SignedIn>/<SignedOut>/<RedirectToSignIn>` in the root layout; `<SignInButton>/<SignUpButton>/<UserButton>` in the Navbar; `useUser()` in client components; `currentUser()` in the server action.
- **Token flow:** session cookie -> JWT from the `convex` template -> attached by `ConvexProviderWithClerk` -> validated against `auth.config.ts` -> `identity.subject`.
- **Webhook:** `POST /clerk-webhook` on Convex's HTTP router, `user.created` only, Svix-verified.
- **Without it I'd build:** password hashing and storage, email verification, password reset, session management, OAuth, and a user-management UI.
- **It receives:** email, name, credentials — none of which I ever see.
- **It returns:** the user object and a signed JWT.
- **Security notes:** the publishable key is public by design and safe in the client; the secret key and webhook secret stay server-side (they do). *Known limitation:* the instance domain in `auth.config.ts` is a **development** instance, hardcoded rather than read from an env var. *Improvement:* env var + a production instance.
- **If it fails:** `<SignedOut>` renders, `RedirectToSignIn` fires at a service that's down, and the app is unusable. `streamTokenProvider` throws. Cached sessions may keep working until a token refresh.

### Convex

(Covered in depth in §18. Summary here for completeness.)

- **Purpose:** database, backend functions, live query updates, and a public HTTP endpoint for the webhook.
- **Integration:** `ConvexReactClient(NEXT_PUBLIC_CONVEX_URL)`, `useQuery` / `useMutation`, functions in `convex/*.ts`, types in `convex/_generated`.
- **Without it I'd build:** a Postgres schema plus migrations, an Express/Nest API, auth middleware, a websocket or polling layer, and hosting for all of it.
- **Security note:** the deployment URL is public — it has to be, the browser connects to it — so **every public Convex function is an internet-facing endpoint**. There's no route middleware, so auth has to live inside each function.
- **If it fails:** `useQuery` never resolves, so anything checking `=== undefined` spins forever. Mutations reject, and those are caught and toasted. The video call itself keeps working, since Stream is independent.

### Stream Video

> **Must know:** Stream provides the actual call — media, participants, layouts, recordings — and I authenticate to it with a token minted server-side from the Clerk identity.
> **Good to know:** the call lifecycle (`getOrCreate` -> `join` -> `endCall`), the `call.ended` event, and why the secret must stay off the client.
> **Deep dive:** the missing `members` list and what that means for access control and recordings.

- **Client init:** `StreamClientProvider` builds a `StreamVideoClient` with the public API key, the Clerk user ID, and `tokenProvider: streamTokenProvider`. The SDK calls the provider whenever it needs a fresh token.
- **Token generation:** `src/actions/stream.actions.ts`, server-only, `generateUserToken({ user_id })` signed with `STREAM_SECRET_KEY`.
- **Call lifecycle:** `client.call("default", id)` -> `getOrCreate({ data: { starts_at, custom }})` -> `call.join()` -> `call.endCall()`. Events: `call.ended`. Queries: `client.queryCalls(...)`, `call.queryRecordings()`.
- **Without it I'd build:** signalling, STUN/TURN servers (TURN costs real bandwidth money), an SFU so each participant isn't uploading a stream to everyone else, bandwidth adaptation, device handling, and a recording pipeline. This is the biggest single thing the project outsources.
- **It receives:** media streams, my user IDs, call metadata, and the `custom` object with the interview title.
- **It returns:** media, participant state, call objects, recording URLs.
- **Security notes:** `STREAM_SECRET_KEY` never reaches the browser. *Known limitation:* calls are created with no `members`, so join access is governed by the Stream `default` call type rather than my interview record.
- **If it fails:** `StreamClientProvider` never sets a client, so every `(route)` page shows a loader indefinitely — including the home page, not just meetings, because the provider wraps the whole group. `/dashboard` still works. *Improvement:* a timeout and an error state, and render non-video pages with video disabled.

### Monaco Editor

- **Purpose:** the editing surface.
- **Integration:** `@monaco-editor/react`'s `<Editor/>` as a controlled component — `value={code}`, `onChange={v => setCode(v || "")}`.
- **Options that matter:** `language={language}` drives highlighting; `automaticLayout: true` makes it re-measure when the resizable panel is dragged (important in this layout); `theme="vs-dark"`, minimap off, `fontSize: 16`, `wordWrap: "on"`.
- **Language handling:** the same four string IDs (`javascript`, `python`, `java`, `cpp`) serve three jobs — Monaco's language mode, the key into `starterCode`, and the key into the Judge0 ID map. Convenient, and the reason the type is a hardcoded union.
- **Without it I'd build:** syntax highlighting, tokenisation, bracket matching, undo/redo, multi-cursor. Not realistic.
- **Security concern:** none directly. It's a large bundle, which is a performance consideration.
- **If it fails:** the editor panel doesn't render; video still works.

### Judge0

> **Must know:** I POST the source, a language ID and stdin to Judge0, it runs the code in a sandbox and returns stdout/stderr plus a status. Status `3` means success.
> **Good to know:** `wait=true` makes it synchronous, the four language IDs, and the resource limits I set.
> **Deep dive:** the API key exposure, the missing `compile_output` handling, and what a production version would look like (server-side call, queue, rate limits, async API).

- **Request:** `POST https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true` with `X-RapidAPI-Host` / `X-RapidAPI-Key` headers and a JSON body of `source_code`, `language_id`, `stdin`, `expected_output: null`, `cpu_time_limit: 5`, `memory_limit: 128000`.
- **Response:** `stdout`, `stderr`, `compile_output`, `time`, `memory`, and `status: { id, description }`. `id === 3` is Accepted; other IDs cover compilation errors, runtime errors and time-limit exceeded. *Known limitation:* my code only special-cases `3` and never reads `compile_output`, which is where compiler messages actually live.
- **Language IDs:** JavaScript `63`, Python `71`, Java `62`, C++ `54`.
- **Without it I'd build:** a sandboxed execution service — containers or gVisor/Firecracker per submission, resource limits, network isolation, a job queue, and toolchains for four languages. Getting the isolation wrong means arbitrary code execution on my own machines. This is why using a service here is a good decision, not a lazy one.
- **It receives:** the candidate's source code and stdin — which also means interview code leaves my systems and goes to a third party.
- **Security concern — the most serious in the repo:** the API key is a hardcoded literal in a **client component**, so it's in the bundle and in git history. Anyone can extract it and burn the quota, and per-user rate limiting is impossible while the browser calls Judge0 directly. **Rotate the key**, then move the call server-side.
- **If it fails:** the terminal shows `"Error executing code"` or `"Error: Invalid response from API."` No retry, no timeout, no degraded mode — but the interview otherwise continues.

---

## 22. Important Code Walkthroughs

Twelve pieces of code worth being able to talk through. Each has: what problem it solves, how it works, why it's written that way, and the question it invites.

### 22.1 `streamTokenProvider` — `src/actions/stream.actions.ts`

**Problem.** Stream needs a signed token to let a browser join a call, and signing needs a secret that must never reach the browser.

**How.** A 12-line `"use server"` function: get the Clerk user with `currentUser()`, throw if there isn't one, build a `StreamClient` with the public API key and the secret, return `generateUserToken({ user_id: user.id })`.

**Why this way.** A server action is the smallest possible piece of trusted server code — no route handler, no API folder, no separate service. It takes **no parameters**, which is the security-critical part: the user ID comes from the session.

**Question it invites:** *"Why can't you generate the Stream token in the browser?"*
> "Because signing it needs the Stream secret, and that secret can mint a token for any user on my Stream app. If it were in the bundle, anyone could impersonate anyone and join any call. So I do it in a server action, and the user ID comes from the Clerk session rather than from a parameter — that way you can't ask for someone else's token."

### 22.2 `StreamClientProvider` — `src/components/providers/StreamClientProvider.tsx`

**Problem.** Every Stream component needs a client instance, and the client can't be built until I know who the user is.

**How.** Waits for Clerk's `isLoaded` and `user`, builds the client in a `useEffect`, stores it in state, and renders a loader until then. It passes a `tokenProvider` rather than a token so the SDK can refresh on its own.

**Why here.** It's mounted in `(route)/layout.tsx`, so `/dashboard` — which needs no video — doesn't pay the cost. The trade-off is that Stream being down blocks the home page too.

**Question it invites:** *"Why create the client in an effect instead of at module scope?"*
> "Because it needs the signed-in user, which only exists after Clerk hydrates on the client. The Convex client is different — I create that once at module scope, because it doesn't need the user at construction time. It gets auth injected by the provider."

### 22.3 `useMeetingActions` — `src/hooks/useMeetingActions.ts`

**Problem.** Two ways into a meeting — create one, or join an existing one — needed from more than one component.

**How.** `createInstantMeeting` generates a UUID, calls `getOrCreate`, routes to the meeting page, toasts. `joinMeeting(callId)` just routes.

**Why.** The UUID is generated client-side so the same ID can serve as the URL, the Stream call ID and (in scheduling) the Convex `streamCallId` — no round trip needed to learn it.

**Question it invites:** *"What if two people generate the same call ID?"*
> "It's a v4 UUID, so 122 random bits — a collision isn't realistic. And `getOrCreate` is idempotent anyway: if the ID already existed you'd join the existing call rather than overwrite it."

*Have ready:* an instant meeting creates no Convex row, so it has no End Meeting button and never reaches the dashboard.

### 22.4 `MeetingRoom` — `src/components/MeetingRoom.tsx`

**Problem.** Put video and code on one screen without either feeling like an afterthought.

**How.** A horizontal `ResizablePanelGroup`: video 35% | handle | editor 65%. Layout mode and participant-panel visibility are local state. A `useEffect` subscribes to `call.on("call.ended")` and routes home, cleaning up with `call.off`. A `CallingState.JOINED` guard shows a spinner until connected.

**Why.** Using Stream's prebuilt layouts and controls is why the file is ~120 lines. Resizable panels are what let each side favour video or code.

**Question it invites:** *"How does the candidate know the interviewer ended the call?"*
> "Stream pushes a `call.ended` event to every participant. `MeetingRoom` listens for it and routes home. Separately, the interviewer's own client calls the Convex mutation that marks the interview completed — and that's the weak point, because if their browser dies in between, the call ends but the record stays 'upcoming'. I'd move that to a Stream webhook."

### 22.5 `CodeEditor` — `src/components/CodeEditor.tsx`

**Problem.** Give the candidate a real editor, a problem statement, an input box and a terminal, in one panel.

**How.** A vertical `ResizablePanelGroup` — problem/examples/constraints, Monaco, stdin textarea, black terminal — with five pieces of `useState`. `runCode()` posts to Judge0 with `wait=true` and writes a string into `output`.

**Why this way.** Fastest path to a working feature: no backend, no queue, no polling. Three things to own: the key is in the client, changing question or language wipes the code, and only status 3 is handled well.

**Questions it invites:**
- *"Where does the code run?"* — "On Judge0's infrastructure through RapidAPI. I send source, a language ID and stdin, and get back stdout, stderr and a status."
- *"Is that secure?"* — "The execution part is — untrusted code never runs on my servers. But my implementation calls Judge0 straight from the browser with the key inline, which is a real flaw. The fix is a Convex action or a Next route handler holding the key, which also lets me rate-limit."

### 22.6 `syncUser` — `convex/users.ts`

**Problem.** Clerk owns the user; Convex needs a copy with a role attached.

**How.** Look up by `clerkId`, return early if found, otherwise insert with `role: "candidate"`.

**Why.** The early return makes it idempotent, which matters because Svix redelivers on non-2xx responses.

**Question it invites:** *"What if the webhook is delivered twice?"*
> "It's idempotent — the second call finds the existing `clerkId` and returns without inserting. Two things I'd improve: it uses `.filter()` instead of the `by_clerk_id` index that already exists, so it's a full scan, and it's a public mutation when it should be an internal one that only my webhook handler can call."

### 22.7 `createInterview` and the scheduling submit

**Problem.** One user action has to create two things in two systems and keep them linked.

**How.** Generate a UUID -> create the Stream call with it -> insert a Convex row carrying the same UUID.

**Why.** Generating the ID up front means both systems agree on the key with no coordination protocol.

**Question it invites:** *"What if the Convex insert fails after the Stream call is created?"*
> "Then there's an orphaned Stream call and no interview record, and nothing cleans it up. It's two writes with no transaction across them. If I did it again I'd write the Convex row first as 'pending', create the Stream call from a server function keyed by the same UUID so retries are safe, then mark it ready — plus a job that reconciles anything that still drifts."

### 22.8 `updateInterviewStatus` — `convex/interviews.ts`

**Problem.** Move an interview through its lifecycle and record when it ended.

**How.** A single `patch` that conditionally adds `endTime` when the status becomes `"completed"`.

**Why this way.** It's the minimum version, and it's the weakest function in the codebase: no identity check, no role check, no membership check, and `status` is an unvalidated string.

**Question it invites:** *"Who's allowed to call this?"*
> "As written, anyone — it doesn't check identity at all, and Convex functions are public endpoints. The UI only shows the buttons to interviewers, but that's cosmetic. The fix is about three lines: get the identity, load the user, check they're an interviewer on this interview, and make `status` a union of literals so an invalid value can't be stored."

### 22.9 `addComment` — `convex/comments.ts`

**Problem.** Record who said what about whom, without letting anyone forge authorship.

**How.** Requires an identity, then inserts with `interviewerId: identity.subject`. The client never supplies the author.

**Why.** This is the correct pattern, and it's genuinely done right here — use it as your evidence that you know what "correct" looks like.

**Question it invites:** *"Could a candidate write feedback about themselves?"*
> "They couldn't forge the author — that comes from the verified token. But nothing stops a signed-in candidate calling `addComment` with a valid interview ID and having it recorded under their own name. Fixing that needs a role check inside the mutation."

### 22.10 The Clerk webhook — `convex/http.ts`

**Problem.** Get new Clerk users into my database, and make sure only Clerk can trigger that.

**How.** `httpRouter()` registers `POST /clerk-webhook`. Reads the secret from Convex's environment, requires the three Svix headers, verifies the signature over the raw body, switches on `evt.type`, runs `syncUser` for `user.created`.

**Why a webhook at all.** User creation happens *inside Clerk*. There's no moment in my client code that reliably means "a new user exists", and doing it on first page load would mean trusting the browser to tell me a user's email and ID.

**Questions it invites:**
- *"How do you know it really came from Clerk?"* — "Svix signs the payload with a shared secret. I verify an HMAC over the raw body plus the timestamp before touching the data. Forged requests fail, and the timestamp is part of the signature so old ones can't be replayed. On failure I return 400 and never call the mutation."
- *"What about `user.updated` or `user.deleted`?"* — "I only handle `user.created` right now, so if someone changes their name or avatar my copy goes stale, and deleted users stay in my table. Handling those two events is one of the first things I'd add."

*Small note:* `convex/http.ts` imports `request` from node's `http` and never uses it — leftover dead code.

### 22.11 `useUserRole` — `src/hooks/useUserRole.ts`

**Problem.** Almost every page needs to know whether the user is an interviewer.

**How.** Combines Clerk's `useUser()` (for the ID) with a Convex query (for the role), returning three booleans.

**Why.** The role lives in Convex, not Clerk, so it can't come from the session alone. And because it's a Convex query, a role change reaches an open tab without a refresh.

**Question it invites:** *"What happens on the very first render?"*
> "Clerk hasn't hydrated, so the query runs with an empty string ID and returns `null` — and `null` isn't `undefined`, so my loading flag flips to false while the role is still unknown. That's why the dashboard button can flicker. The clean fix is Convex's `skip` argument so the query doesn't run until the ID exists."

### 22.12 `groupInterviews` and `getMeetingStatus` — `src/lib/utils.ts`

**Problem.** Turn a flat list of interviews into dashboard buckets, and decide when a Join button appears.

**How.** `groupInterviews` reduces into succeeded / failed / completed / upcoming using status first, then start time. `getMeetingStatus` returns `"completed"` for terminal statuses, `"live"` if now is inside `[startTime, startTime + 1 hour]`, `"upcoming"` if before, else `"completed"`.

**Why.** It's derived state computed on the client from data already fetched — no extra queries, and it recomputes for free when Convex pushes an update. These are also the easiest functions in the repo to unit test, which is a useful thing to offer if testing comes up.

**Questions it invites:**
- *"What if the interview runs longer than an hour?"* — "Then the status flips to completed and the Join button disappears mid-interview, because the one-hour window is hardcoded. I'd store a real duration or an explicit end time."
- *"Is status a single source of truth?"* — "Not quite. The grouping buckets an interview as completed based on time, while the Pass/Fail buttons check the stored status, so those two can disagree. I'd derive both from one function."

---

## 23. Request / Data Flow Diagrams

### Authentication

```
  User
   |  enters credentials
   v
  CLERK  (hosted sign-in)
   |  sets session cookie, issues JWT from the "convex" template
   v
  Next.js app
   |  <SignedIn> renders the app
   |  ConvexProviderWithClerk attaches the JWT to every Convex call
   v
  CONVEX
   |  validates the issuer against convex/auth.config.ts
   v
  ctx.auth.getUserIdentity().subject  ==  the Clerk user id
```

### User synchronization

```
  New sign-up in CLERK
        |
        |  event: user.created
        v
  POST https://<deployment>.convex.site/clerk-webhook
        |  headers: svix-id, svix-timestamp, svix-signature
        v
  convex/http.ts
        |
        +--> missing headers?           -> 400
        +--> svix verify fails?         -> 400 "Invalid webhook signature"
        +--> event is not user.created  -> 200, do nothing
        |
        v
  ctx.runMutation(api.users.syncUser, { clerkId, email, name, image })
        |
        +--> user with this clerkId already exists -> return, no insert
        |
        v
  INSERT into users { name, email, image, clerkId, role: "candidate" }
        |
        v
  200 back to Clerk
```

### Meeting token

```
  Browser: StreamVideoClient needs a token
        |
        |  calls the server action (an RPC to the Next.js server)
        v
  src/actions/stream.actions.ts  ("use server")
        |
        +--> currentUser() from Clerk  -> no session? throw
        +--> new StreamClient(NEXT_PUBLIC_STREAM_API_KEY, STREAM_SECRET_KEY)
        +--> generateUserToken({ user_id: user.id })
        |
        v
  JWT returned to the browser
        |
        v
  Stream client connects to Stream with the JWT
        |
        v
  call.join()  ->  media flows over WebRTC
```

### Code execution

```
  Candidate types code in Monaco       (React state: `code`)
  Candidate types stdin                (React state: `userInput`)
  Candidate clicks Run
        |
        v
  output = "Running..."
        |
        v
  POST judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true
       headers: X-RapidAPI-Key  <-- CURRENTLY HARDCODED IN THE CLIENT (see 26)
       body: { source_code, language_id, stdin, cpu_time_limit: 5, memory_limit: 128000 }
        |
        v
  Judge0 compiles + runs in a sandbox, waits for completion
        |
        v
  { status: { id, description }, stdout, stderr, ... }
        |
        +--> no data.status   -> "Error: Invalid response from API."
        +--> status.id === 3  -> show stdout (or "No Output")
        +--> anything else    -> "Error: <description>\n<stderr>"
        +--> fetch threw      -> "Error executing code"
        |
        v
  Terminal panel renders `output`
```

### Interview scheduling

```
  Interviewer on /schedule
        |
        |  picks candidate, interviewers, date, time slot
        v
  client-side validation
        |  - candidate + >=1 interviewer required
        |  - past dates disabled on the calendar
        |  - if today, reject a slot with an earlier HOUR (coarse)
        v
  id = crypto.randomUUID()
        |
        +-------------------------------+
        |                               |
        v                               v
  STREAM: call("default", id)     CONVEX: createInterview({
          .getOrCreate({                   title, description, startTime,
             starts_at,                    status: "upcoming",
             custom: { description }       streamCallId: id,
          })                               candidateId, interviewerIds
                                        })
        |                               |
        |     (two writes, no transaction between them)
        |                               |
        v                               v
   Stream call exists            interviews row exists
                                        |
                    +-------------------+-------------------+
                    v                                       v
   Candidate's home page                       Interviewer's dashboard
   getMyInterviews (indexed on candidateId)    getAllInterviews
   updates live via Convex                     updates live via Convex
```

---

## 24. Why These Design Decisions?

### Why Convex instead of REST + PostgreSQL?

For a project this size, Convex removed an entire tier. No API server, no ORM, no migrations, no websocket layer, no cache invalidation. I write a TypeScript function, it becomes a callable endpoint with generated types, and any query I subscribe to updates itself when the data changes.

- **Benefit:** live updates for free. A candidate's interview list refreshing when an interviewer schedules something is one line of client code. With Express + Postgres I'd have built polling or sockets plus invalidation rules.
- **Benefit:** the schema generates the TypeScript types my React components import. One definition, no drift.
- **Benefit:** mutations are transactions with automatic retry on conflict. No explicit locking.
- **Cost:** vendor lock-in. The functions and the query API aren't portable.
- **Cost:** it's a document store with explicit indexes, not SQL. No joins — which is exactly why `getUsers` fetches all users so the client can match IDs.
- **Cost:** every public function is an internet-facing endpoint, and there's no route middleware, so auth has to be written into each function.
- **If I built it again:** keep Convex at this scale, but write a shared `requireInterviewer(ctx)` helper from day one, use `internalMutation` for webhook-only functions, and reconsider Postgres if the product ever needed real reporting across interviews.

### Why Clerk?

- **Benefit:** sign-in, sign-up, sessions, OAuth, avatars and a management UI in about an hour, plus components that already look finished.
- **Benefit:** a first-class Convex integration, so the JWT plumbing was solved for me.
- **Cost:** another vendor, and the role lives in Convex rather than Clerk — so a user exists in two places and a webhook keeps them in sync.
- **If I built it again:** same choice. I'd read the instance domain from an env var and handle `user.updated` and `user.deleted`.

### Why Stream instead of implementing WebRTC?

- **Benefit:** two-party WebRTC is doable; multi-party isn't a weekend project. You need signalling, STUN and TURN, and an SFU so participants aren't uploading a stream to every other participant. Stream gives all of that plus React components.
- **Benefit:** recordings come free.
- **Cost:** the call and its permissions live in a system my database doesn't control, which is where the members gap comes from.
- **Cost:** pricing scales with minutes — video is the most expensive part of this product.
- **If I built it again:** same choice, but pass `members: [candidateId, ...interviewerIds]` so Stream's permissions match my interview record.

### Why Monaco instead of building an editor?

- **Benefit:** it's the VS Code editor. Highlighting, IntelliSense, bracket matching, undo history and keybindings all work on day one, and candidates already know it.
- **Cost:** a heavy bundle that isn't lazy-loaded here.
- **Cost:** single-user by design; collaboration needs an extra layer like Yjs.
- **If I built it again:** same choice, plus lazy loading and Yjs.

### Why Judge0 instead of running code myself?

- **Benefit:** running untrusted code is the dangerous part, and Judge0 already solves sandboxing, resource limits and toolchains. Adding a language is one line in a map.
- **Cost:** a third-party dependency in the critical path of an interview, on a free tier with a quota.
- **Cost:** the candidate's code leaves my infrastructure.
- **Cost as implemented:** calling it from the browser leaks the key and makes rate limiting impossible.
- **If I built it again:** keep Judge0, but call it from a Convex action or a route handler, add a timeout, add per-user rate limiting, and read `compile_output`.

### Why Next.js?

- **Benefit:** nested layouts are what let `StreamClientProvider` wrap only the routes that need video; route groups organise pages without affecting URLs.
- **Benefit:** server actions gave me a place for the Stream token with no separate backend.
- **Benefit:** one-command Vercel deployment.
- **Cost:** I barely use server rendering — nearly every page is `"use client"`. A Vite SPA plus one serverless function would have covered most of this.
- **If I built it again:** same choice, mainly for the server action and deployment, but I'd push more fetching to the server on pages that don't need live updates.

### Why TypeScript?

- **Benefit:** with Convex, types flow from the schema into components. `Doc<"interviews">` in `MeetingCard` *is* the schema, not a hand-written duplicate — rename a field and the compiler shows every use.
- **Benefit:** `Id<"interviews">` is branded, so an interview ID and a user ID aren't interchangeable.
- **Cost:** more ceremony, and `strict: true` pushed me toward non-null assertions like `process.env.X!`, which quietly hide the "what if this is missing" case.
- **If I built it again:** same choice, with runtime validation of env vars at startup instead of `!`.

---

## 25. Failure Scenarios

| Scenario | Current behaviour | Handled gracefully? | Improvement |
|---|---|---|---|
| **Clerk unavailable** | `<SignedOut>` renders and `RedirectToSignIn` fires at a service that's down. `streamTokenProvider` throws. Existing sessions may survive until a token refresh | No — no message, just a broken redirect | An error boundary saying sign-in is temporarily unavailable |
| **Convex unavailable** | `useQuery` stays `undefined`, so spinners never resolve. Mutations reject, and those are caught and toasted. The video call keeps working | Partly — mutations toast, queries hang silently | A timeout on loading states, an error boundary, a "reconnecting" banner |
| **Stream unavailable** | `StreamClientProvider` never sets a client, so `/`, `/schedule`, `/recordings` and `/meeting/[id]` show a loader indefinitely. `/dashboard` still works | No — infinite spinner, and it takes the home page with it | A timeout plus an error state; render children with video disabled rather than blocking the group |
| **Judge0 unavailable** | `fetch` throws -> `"Error executing code"`. Everything else works | Partly — the user sees something, but not what went wrong | Distinguish network error / quota exceeded / timeout; retry with backoff; move the call server-side so failures are loggable |
| **Judge0 returns a compilation error** | Shows `Error: Compilation Error` plus `stderr`. The real message is in `compile_output`, which isn't read, so it's often empty | Partly — no crash, but unhelpful | Read and display `compile_output` |
| **User loses internet** | Convex reconnects and resubscribes automatically; Stream attempts to reconnect; local React state survives as long as the tab isn't reloaded | Reasonably — mostly thanks to the SDKs | An explicit offline indicator |
| **User refreshes during an interview** | Rejoins the call fine. **All editor contents, question, language and output are lost**, because they're only React state | No — real data loss in an interview context | `localStorage` as a quick fix; a Convex table keyed by `streamCallId` as the real fix, which also makes the code visible to the interviewer |
| **Two users update the same record** | Convex serialises mutations and retries on conflict, so nothing is lost or torn. But `updateInterviewStatus` is last-write-wins: Pass then Fail silently overwrites | Data integrity yes; business semantics no | Reject transitions out of a terminal state, or store per-interviewer decisions and derive the outcome |
| **Webhook verification fails** | 400, mutation never runs, Svix retries. The user exists in Clerk but not Convex, so they have no role and can't be scheduled | Correct security behaviour, poor recovery | A self-sync fallback when a signed-in user has no Convex record, deriving data from the verified identity |
| **Invalid authentication provided** | Convex rejects the JWT; functions that check identity either throw or return `[]`; functions that don't check it run anyway | Inconsistent — three behaviours across four checked functions | One shared `requireUser(ctx)` helper used everywhere |
| **Invalid interview time** | The form blocks past dates and (coarsely) past hours, but `createInterview` validates nothing — a direct call can store any `startTime`. `MeetingCard` at least renders "Invalid date" for `NaN` | Client-side only | Validate `startTime > Date.now()` in the mutation |
| **Accessing another user's data** | Nothing stops it — see §19 and §26 | No | Per-function authorization |
| **External request times out** | The Judge0 fetch has no timeout and no `AbortController`, and `wait=true` is synchronous, so it can hang with the terminal stuck on "Running..." | No | `AbortController` with a ~10s timeout, plus a Cancel button |
| **Owner's browser dies mid-end-call** | `endCall()` may succeed while the status update never runs — everyone is ejected but the record stays `"upcoming"` | No | Update status from a Stream `call.ended` webhook instead of the owner's client |

---

## 26. Security Review

### What is done correctly

1. **The Stream secret never reaches the browser.** Used only inside a `"use server"` function; only the public API key is in the client.
2. **The token provider takes no parameters** — the user ID comes from `currentUser()` on the server, so nobody can mint a token for someone else.
3. **The webhook signature is verified properly** — Svix HMAC over the raw body with the required headers, before any data is used. Failure returns 400 and writes nothing.
4. **The webhook secret lives in Convex's environment**, not in the client or the repo.
5. **Comment authorship is server-derived** — `addComment` uses `identity.subject`.
6. **`getMyInterviews` scopes by server-side identity**, so a candidate can't request someone else's interviews.
7. **`.gitignore` excludes `.env*`**, so no env file is committed.
8. **Password handling is entirely Clerk's** — I never see or store a credential.
9. **Code execution is sandboxed off my infrastructure** — untrusted code never runs on a machine I control.
10. **Every Convex function validates argument types** with `v.*` validators, which blocks whole classes of malformed input.

That's a genuinely respectable list, and it's the right way to open this topic — lead with what's right, then be precise about what isn't.

### What is risky or incomplete

> **CRITICAL — a live third-party API key is committed in source.**
> `src/components/CodeEditor.tsx` contains a hardcoded RapidAPI key as a string literal in a **client component**. It is therefore shipped in the JavaScript bundle to every visitor, committed to git history, and present in every clone. The value is not reproduced in this document.
> **Action required: rotate the key in the RapidAPI dashboard.** Rotation is what matters — removing the line doesn't help, because the key remains in history and in any deployed bundle. After rotating, move the call server-side. Purging git history with `git filter-repo` or BFG is worth doing too, but *after* rotation.

| # | Issue | Where | Why it matters |
|---|---|---|---|
| 1 | **Judge0 API key in the client bundle** | `CodeEditor.tsx` | Quota theft and cost; the key is unrecoverable once published |
| 2 | **`updateInterviewStatus` has no authentication** | `convex/interviews.ts` | Any caller with an interview ID can set any outcome |
| 3 | **`/dashboard` has no role guard** | `(admin)/dashboard/page.tsx` | A signed-in candidate typing the URL sees all interviews, candidate names and feedback, with working Pass/Fail buttons |
| 4 | **`syncUser` is a public mutation** | `convex/users.ts` | Anyone can insert rows into the `users` table |
| 5 | **`getComments` is unauthenticated** | `convex/comments.ts` | Feedback about a candidate is readable by anyone with the interview ID |
| 6 | **`getInterviewByStreamCallId` is unauthenticated** | `convex/interviews.ts` | Full interview details readable from a call ID that appears in a shareable URL |
| 7 | **`getUserByClerkId` is unauthenticated and unscoped** | `convex/users.ts` | Any user record is readable by ID |
| 8 | **`getUsers` returns every email to every signed-in user** | `convex/users.ts` | PII exposure; a candidate can enumerate everyone |
| 9 | **`getAllInterviews` checks sign-in but not role** | `convex/interviews.ts` | Candidates can read every interview |
| 10 | **Stream calls have no `members`** | scheduling + instant meeting | Join access is left to the default call type; the call ID in the URL becomes the access control |
| 11 | **No rate limiting anywhere** | whole app | Judge0 submissions, interview creation and comments can be spammed |
| 12 | **`status` is an unvalidated string** | `convex/schema.ts` | Any value can be stored, landing the record in no category |
| 13 | **`rating` has no range validation** | `convex/comments.ts` | Values outside 1–5 are stored |
| 14 | **Clerk dev instance hardcoded** | `convex/auth.config.ts` | Not a secret, but blocks per-environment configuration |
| 15 | **Recording URLs are opened and copyable with no app-level gating** | `RecordingCard.tsx` | Protection depends entirely on Stream's configuration |
| 16 | **No `.env.example`; heavy use of `process.env.X!`** | several files | A missing variable fails confusingly at runtime instead of clearly at startup |

**IDOR check** (Insecure Direct Object Reference — passing someone else's ID and getting their data): `getComments`, `getInterviewByStreamCallId` and `getUserByClerkId` all take an ID from the client and return the record with no entitlement check. `updateInterviewStatus` is a *write* IDOR. The good counter-example is `getMyInterviews`, which never accepts an ID at all.

**Trust boundaries as they stand:**
```
  TRUSTED   : the Next.js server action, Convex function bodies,
              the webhook handler after verification
  UNTRUSTED : everything in the browser -- the Judge0 call, the role checks in the UI,
              the EndCallButton owner check, the scheduling form's time validation
```
The recurring pattern in the gaps above is a check sitting on the untrusted side of that line. Naming the pattern is more impressive than listing the instances.

### How I would fix it

**Immediately (an afternoon):**
1. Rotate the RapidAPI key, then move the Judge0 call into a Convex action or a Next route handler that reads the key from the server environment.
2. Add authentication and a role check to `updateInterviewStatus`.
3. Guard `/dashboard` by role — ideally with a layout on the `(admin)` group.
4. Convert `syncUser` to an `internalMutation`.
5. Add identity checks to `getComments`, `getInterviewByStreamCallId` and `getUserByClerkId`.

**Next (a day or two):**
6. Write `requireUser(ctx)` and `requireInterviewer(ctx)` helpers and call them at the top of every function.
7. Scope `getAllInterviews` to interviews the caller is on; scope `getComments` to participants.
8. Replace `getUsers` with narrower queries returning only `{ clerkId, name, image }`.
9. Make `status` a union of literals; validate `rating` between 1 and 5.
10. Pass `members` when creating Stream calls and tighten the call type's permissions.
11. Move the Clerk domain into an env var pointing at a production instance.
12. Add per-user rate limiting on code execution once it's server-side.

---

## 27. Performance and Scalability

> **Must know:** the first things to break are the two queries that fetch entire tables (`getUsers`, `getAllInterviews`) and the shared Judge0 free-tier quota.
> **Good to know:** why `getMyInterviews` scales and the others don't, and what live subscriptions cost as clients multiply.
> **Deep dive:** the full table below, and the distinction between what the project does now and what I'd change.

Framing to be honest about: **this project has not been load tested and has no caching, pagination or rate limiting.** What follows is reasoning about where it breaks, not a description of solved problems.

**10 users.** Fine. Table scans over a handful of documents are free.

**100 users.** Still fine, but two things start to smell: `getUsers` returns all 100 users with emails on three pages, and `getAllInterviews` returns everything to render the dashboard.

**1,000 users.** Real problems:
- `getUsers` ships ~1,000 documents on three pages, and the dropdowns render 1,000 items.
- `getAllInterviews` returns thousands of rows with no pagination or virtualisation.
- `syncUser`'s `.filter()` now scans a 1,000-row table on every signup — one-line fix.
- `getMyInterviews` stays fast because it's indexed. It's the one query that scales properly.
- The Judge0 free tier becomes the hard ceiling: a shared quota, so when it's gone every candidate sees an error mid-interview.
- Stream billing starts to matter — video minutes dominate the cost.

**10,000+ users.** Real changes needed:

| Area | Current | Improvement |
|---|---|---|
| **Database queries** | Two full-table `.collect()` calls on hot pages | Paginate with Convex's `paginate()`; an index for "interviews I'm conducting"; return only the fields the UI needs |
| **Indexes** | Three indexes; `syncUser` ignores one that exists | Use the existing index; add a compound index on status + start time so the dashboard queries per bucket |
| **Real-time subscriptions** | Every open dashboard subscribes to *all* interviews, so one write re-pushes to every dashboard | Scope subscriptions to a page; make rarely-changing data a non-live fetch |
| **Video traffic** | Entirely Stream's problem, and Stream is built for it | No architectural change; the change is commercial |
| **Code execution** | Browser -> free tier, one shared key, no queue or limits | Server-side proxy with the key in the environment; per-user rate limits; a queue using Judge0's async API instead of `wait=true`; self-hosted workers at high volume |
| **External APIs** | No retries, timeouts or circuit breaker | Timeouts, exponential backoff, and a circuit breaker so an outage fails fast |
| **Server actions** | One, and it's cheap | Cache tokens for their lifetime rather than minting per client construction |
| **Frontend rendering** | Dashboard renders every card; Monaco loads eagerly | Virtualise long lists; lazy-load Monaco; code-split the meeting route |
| **Rate limiting** | None | Per-user limits on execution, interview creation and comments |
| **Concurrency** | Convex serialises mutations and retries on conflict, so writes are safe | The gap is business rules, not concurrency control — a terminal status shouldn't be changeable |
| **Recordings (N+1)** | One `queryRecordings()` per call | Paginate the calls list and fetch recordings for the visible page only |

**The line to use:** "At the scale I built it for, the current design is fine. The first thing to break would be the queries that fetch entire tables, because they're unbounded. The second would be the Judge0 free tier, since it's one shared quota called straight from the browser. I know where those limits are — I just didn't need to solve them for a project this size."

---

## 28. Current Implementation → Known Limitation → Improvement

Everything below is visible in the repository. The three columns exist so you never confuse "what I built" with "what I'd build next" in front of an interviewer.

| # | Current implementation | Known limitation | Improvement |
|---|---|---|---|
| 1 | Monaco editor with per-language starter code, held in React state | Not shared and not persisted — the interviewer can't see the candidate typing, and a refresh loses the work | Yjs + `y-monaco` for true collaboration, or a debounced `code_sessions` row in Convex keyed by `streamCallId` |
| 2 | Judge0 called from the browser with a language-ID map and stdin support | The API key ships in the client bundle | Rotate the key; move the call into a Convex action or route handler |
| 3 | Role-aware UI: different home page, dashboard link and schedule access per role | Backend authorization is incomplete — no Convex function checks a role, and `/dashboard` has no guard | `requireUser` / `requireInterviewer` helpers used in every function; a layout guard on `(admin)` |
| 4 | Users created by a signature-verified webhook with a default role | No in-app way to become an interviewer | An admin role and a role-management screen, or Clerk metadata in the JWT |
| 5 | Instant meetings via `getOrCreate` + a UUID | No Convex row, so no End Meeting button and no dashboard entry | Create an interview row for instant meetings too |
| 6 | Three hardcoded coding questions with starter code in four languages | No question database, no authoring UI | A `questions` table with per-interview assignment |
| 7 | Question and language dropdowns load the matching starter code | Switching either silently discards typed code | Keep a draft per (question, language); confirm before overwriting |
| 8 | Convex `v.*` validators on every function argument | Business validation is UI-only — `startTime`, `status` and `rating` are unconstrained server-side | Literal unions in the schema and validation inside the mutations |
| 9 | Toasts on mutation failure; try/catch around external calls | Errors are swallowed — Judge0 failures lose their real cause, and `compile_output` is never read | Error boundaries, typed errors, and display `compile_output` |
| 10 | Synchronous Judge0 call with `wait=true` | No timeout or `AbortController`, so the UI can hang on "Running..." | `AbortController` with a timeout and a Cancel button |
| 11 | Pure helper functions in `src/lib/utils.ts` | No tests anywhere, and no CI | Unit tests for the helpers, `convex-test` for backend functions, one Playwright happy path |
| 12 | `console.log` / `console.error` | No error tracking, metrics or structured logs | Sentry on the client, Convex function logs, and a code-execution success-rate metric |
| 13 | Open access to code execution and writes | No rate limiting | Per-user limits enforced server-side |
| 14 | `getMeetingStatus` decides live/upcoming/completed | The one-hour window is hardcoded, so the Join button vanishes mid-interview if it overruns | Store a duration or a real `endTime` |
| 15 | Stream calls created with `getOrCreate` | No `members` list, so access is governed by the default call type — and candidates see no recordings | Pass `members: [candidateId, ...interviewerIds]` |
| 16 | Webhook handles `user.created` | Name, email and avatar go stale; deleted Clerk users linger | Handle `user.updated` and `user.deleted` |
| 17 | Interview record created alongside the Stream call | Two writes with no transaction, so a failure can orphan a call | Convex row first as `pending`, Stream call from a server function, then mark ready; plus reconciliation |
| 18 | Working app deployed from the repo | Repo hygiene: README is the untouched template, page title is still "Create Next App", `next.config.,js` has a comma in its filename so Next never loads it, `tailwind.config.js` is an unused v3 leftover, `MeetingRoom.tsx:116` has a stray `<h1>`, `convex/http.ts` imports an unused module, `InterviewSchduleUI.tsx` is misspelled | Half an hour of cleanup plus a real README |
| 19 | `MeetingSetup` guards on a missing call | The guard sits above two `useEffect` calls, breaking the Rules of Hooks | Move the guard below the hooks |

---

## 29. What I Would Improve

*"If you had another two weeks, what would you improve?"*

### High priority — security and correctness

1. **Rotate the leaked Judge0 key and move execution server-side.** This also unlocks rate limiting and proper error reporting. *(Half a day.)*
2. **Complete backend authorization.** `requireUser` / `requireInterviewer` helpers used in every function; auth on `updateInterviewStatus`; `syncUser` becomes internal; a role guard on `/dashboard`. *(One day.)*
3. **Tighten the schema.** `status` as a literal union, `rating` range-checked, `startTime` validated in the mutation. *(Two hours.)*
4. **Stop returning user emails to everyone.** Narrow queries returning only what the UI needs. *(Two hours.)*
5. **Handle `user.updated` and `user.deleted`**, plus a self-heal path for users whose webhook never landed. *(Half a day.)*

### Medium priority — reliability and the core feature

6. **Persist the coding session** in a `code_sessions` table keyed by `streamCallId`, written on a debounce — so a refresh doesn't destroy the work and the code is reviewable afterwards. *(One day.)*
7. **Make the editor collaborative** with Yjs + `y-monaco`. This is the feature that would most change what the product *is*. *(Two to three days.)*
8. **Timeouts, retries and cancellation** on every external call, starting with Judge0. *(Half a day.)*
9. **Update interview status from a Stream `call.ended` webhook** instead of depending on the owner's browser. *(Half a day.)*
10. **Give Stream calls a real member list.** *(Two hours — fixes both access control and candidate recordings.)*
11. **Tests:** unit tests for `src/lib/utils.ts`, `convex-test` for backend functions, one Playwright happy path. *(One to two days.)*

### Nice to have — product and polish

12. A question bank in the database with an authoring UI.
13. Test cases and expected-output checking with Judge0's `expected_output`, turning "Run" into "Submit and verify".
14. A real README and an `.env.example`. The variables the code reads are `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `NEXT_PUBLIC_STREAM_API_KEY` and `STREAM_SECRET_KEY` in the Next app, plus `CLERK_WEBHOOK_SECRET` in Convex's environment; `@clerk/nextjs` also needs `CLERK_SECRET_KEY` for `currentUser()`. Validate them at startup instead of using `process.env.X!`.
15. Observability: Sentry, structured logs in Convex functions, and a code-execution success-rate metric.
16. UX: don't wipe code on a language switch; show the interviewer which question the candidate is on; an "interviews I'm conducting" view; lazy-load Monaco.
17. Repo cleanup: fix `next.config.,js`, delete the dead Tailwind config, remove the stray `<h1>`, rename `InterviewSchduleUI.tsx`, set a real page title.
---
---

# PART III — INTERVIEW PREPARATION

---

## 30. Do Not Say This

Six sentences that would get you into trouble. Learn the replacement, not just the warning.

| Don't say | Why | Say instead |
|---|---|---|
| "CodeSync has collaborative code editing." | The editor is local React state. Nothing is shared. | "The editor is single-user right now — making it collaborative is the next feature I'd build, probably with Yjs." |
| "I implemented role-based access control." | Roles drive the UI, but no Convex function checks a role. | "I have roles that drive what each user sees. The backend checks authentication but not the role yet — that's the first thing on my list." |
| "I built the video infrastructure." | Stream provides all of it. | "I integrated Stream's SDK. I didn't build WebRTC — I can explain why you'd need an SFU, which is exactly why I didn't." |
| "Code execution is handled by my backend." | The current call goes from the browser straight to Judge0. | "Code execution goes to Judge0. Right now the call is from the browser, which is a flaw I'd fix by putting it behind a server function." |
| "Convex synchronizes the code editor." | Convex syncs interview records and comments, not the editor. | "Convex keeps the interview record and feedback in sync. The editor isn't synced — that's a separate problem." |
| "It's production-ready / secure / scalable." | It hasn't been load tested, there's no rate limiting, and there's a known credential exposure. | "It works end to end and I know exactly what I'd need to fix before it handled real users — I can list them in order." |

**The general rule:** if you're about to claim you *built* something, check §5 first. Precision about what you integrated makes everything else you say more credible.

---

## 31. The Ten Topics, in Interview Format

Each topic: what to understand, a 20-second spoken answer, the likely follow-up, a good answer, a deeper follow-up, and what the interviewer is actually testing.

---

### Topic 1 — Architecture

**What I should understand.** It's a Next.js app where the browser talks to four services directly. The only server-side code I wrote is one server action and the Convex functions.

**20-second answer**
> "It's a Next.js app, and almost all of it runs in the browser. The browser talks to four services directly — Clerk for auth, Convex for the database and backend functions, Stream for the video call, and Judge0 for running code. I didn't build an API server of my own; the only server-side code I wrote is one Next.js server action that mints the Stream token, plus the Convex functions."

**Likely follow-up:** *"Why no backend of your own?"*
> "Because I didn't need one. Convex already hosts my backend functions and gives me typed access to them from the client. The one thing that genuinely had to be server-side was minting the Stream token, because it needs a secret. So I used a single server action for that instead of standing up a whole service."

**Deeper follow-up:** *"What's the downside of the browser talking to everything directly?"*
> "Two things. I have no central place to enforce rules or log what's happening — every Convex function has to protect itself. And it pushed me into a mistake: because I had no server-side place to put the Judge0 call, I made it from the browser with the key inline. If I'd had one route handler from the start, that wouldn't have happened."

**What the interviewer is testing:** whether you understand your own system's shape, whether you chose it deliberately, and whether you can see the consequences of that shape rather than just describing boxes.

---

### Topic 2 — Convex

**What I should understand.** Convex is the database *and* the backend functions. Queries are read-only and stay live; mutations are transactional writes.

**20-second answer**
> "Convex is my database and my backend. I write TypeScript functions — queries for reads, mutations for writes — and Convex hosts them and generates types from my schema. The reason I picked it is that queries stay live: if a mutation changes data a query read, Convex re-runs it and pushes the new result to every browser that's subscribed. So a candidate's interview list updates the moment an interviewer schedules something."

**Likely follow-up:** *"Why not PostgreSQL and an Express API?"*
> "That would have been Postgres plus an ORM plus Express plus either polling or a websocket layer plus cache invalidation — four more pieces to build and deploy on my own. Convex collapsed that into one. The trade-offs are real though: it's a document store, so there are no joins, which is why I fetch users separately and match IDs on the client instead of joining. And it's lock-in — the functions aren't portable."

**Deeper follow-up:** *"What if Convex goes down?"*
> "The app basically stops. Queries never resolve, so the components sit on loading spinners, because I check for `undefined` to mean loading and it never becomes defined. Mutations reject and those I do catch, so at least the user gets a toast. The video call would keep working since Stream is independent. What I'd add is a timeout on loading states and an error boundary, so the user gets told something instead of staring at a spinner."

**What the interviewer is testing:** whether you picked a technology for a reason, whether you know the alternatives, and whether you've thought about it failing.

---

### Topic 3 — Authentication

**What I should understand.** Clerk issues a JWT, Convex verifies it, and `identity.subject` is the Clerk user ID — which is the join key everywhere.

**20-second answer**
> "Clerk handles sign-in and gives me a signed token. My Convex provider attaches that token to every backend call, and Convex verifies it against the issuer I configured. So inside any Convex function I can call `getUserIdentity()` and `subject` gives me the Clerk user ID. That one ID is the key I use everywhere — on interviews, on comments, and as the Stream user ID."

**Likely follow-up:** *"How does the user end up in your database?"*
> "Through a webhook. Clerk creates the user, then fires a `user.created` event at an HTTP endpoint I expose from Convex. I verify the Svix signature on it, and if it's genuine I insert the user with a default role of candidate. It's idempotent — if that Clerk ID already exists, it returns without inserting — which matters because webhooks retry."

**Deeper follow-up:** *"Why a webhook instead of creating the user on first page load?"*
> "Because the create event happens inside Clerk, not in my app — there's no moment in my client code that reliably means 'this user is new'. And doing it from the browser would mean trusting the client to tell me a user's email and ID. The webhook is signed, so I know it came from Clerk."

**What the interviewer is testing:** whether you understand token-based auth as a chain rather than a magic library, and whether you know why signature verification exists.

---

### Topic 4 — Authorization

**What I should understand.** Roles exist and drive the UI. Backend enforcement is incomplete, and I can name exactly where and how I'd fix it.

**20-second answer**
> "I have two roles, candidate and interviewer, stored on the user row in Convex. A hook reads the role and the UI branches on it — interviewers get the dashboard and scheduling, candidates get their interview list. That part works. What's incomplete is the backend: my Convex functions check that you're signed in, but they don't check your role."

**Likely follow-up:** *"So can a candidate access the dashboard?"*
> "Yes, if they type the URL. The dashboard button is hidden for candidates, but the route itself has no role check, so they'd see every interview and all the feedback. That's the clearest gap I have. The fix is a layout on that route group that checks the role, plus a check inside the Convex functions — because hiding a button doesn't stop anyone calling the function directly."

**Deeper follow-up:** *"How would you actually implement that?"*
> "A helper in my Convex folder — `requireInterviewer(ctx)` — that gets the identity, loads the user record from it, and throws if they're not an interviewer. Then call it at the top of every mutation, plus a check that they're actually on that interview where it applies. I already have the pattern in the right form: `addComment` takes the author from the verified token instead of a parameter, and `getMyInterviews` filters by the identity rather than by a client argument. I just didn't apply it consistently."

**What the interviewer is testing:** whether you know the difference between authentication and authorization, whether you know that client-side checks aren't security, and — most importantly — whether you can audit your own code honestly.

---

### Topic 5 — Stream and video

**What I should understand.** Stream provides the call; I authenticate to it with a token minted server-side from the Clerk identity.

**20-second answer**
> "Stream handles the actual call — the media, who's in the room, mute and camera state, and recordings. It also ships React components like a speaker layout and call controls, which is why my meeting room file is only about 120 lines. My app creates the call, joins it, and listens for the `call.ended` event."

**Likely follow-up:** *"Why is the Stream token generated on the server?"*
> "Because signing it needs the Stream secret key, and that key can mint a token for any user on my app. If it were in the browser bundle, anyone could impersonate any user and join any call. So I do it in a Next.js server action. The important detail is that the function takes no parameters — it asks Clerk who the current user is on the server, so you can't request a token for someone else."

**Deeper follow-up:** *"Who can join a given call?"*
> "More people than should be able to, honestly. I create calls without passing a members list, so access is decided by Stream's default call type rather than by my interview record. In practice the call ID in the URL is doing the access control — it's a random UUID so it isn't guessable, but sharing the link shares the interview. The fix is passing the candidate and interviewer IDs as members. That also fixes a side effect I noticed: candidates see no recordings, because my recordings query filters on creator-or-member and they're neither."

**What the interviewer is testing:** client/server boundaries, secret management, and whether you understand what the SDK is actually doing rather than just calling it.

---

### Topic 6 — Judge0 and code execution

**What I should understand.** I POST source, a language ID and stdin; Judge0 runs it in a sandbox and returns stdout/stderr plus a status. Status 3 means success.

**20-second answer**
> "The editor holds the code in React state. When the candidate hits Run, I map the language to a Judge0 language ID — 63 for Node, 71 for Python, 62 for Java, 54 for C++ — and post the source plus whatever they typed into the input box. I use `wait=true` so the request comes back once execution finishes. Judge0 returns a status and the output; status ID 3 means it ran fine, so I show stdout, and anything else I show as an error."

**Likely follow-up:** *"Why Judge0 rather than running it yourself?"*
> "Because running untrusted code is the dangerous part. Judge0 already handles the sandboxing, the CPU and memory limits, and the toolchains for a lot of languages. Doing it myself would mean containers per submission, resource limits, network isolation and a job queue — and if I got the isolation wrong, someone's code runs on my machine. With Judge0, adding a language is one line in a map."

**Deeper follow-up:** *"Is your implementation secure?"*
> "The execution is — it never runs on my infrastructure. My implementation isn't, and I know why: I call Judge0 straight from the browser with the API key in the component, so the key is in the bundle. It should be rotated and moved behind a server function. That also fixes two other things — I'd be able to rate-limit per user, and I'd actually see the errors instead of them disappearing into the browser console."

**What the interviewer is testing:** whether you understand the security model of running untrusted code, and whether you can spot the flaw in your own implementation before they do.

---

### Topic 7 — Database design

**What I should understand.** Three tables, three indexes, and the deliberate choice to use Clerk IDs as the join key.

**20-second answer**
> "Three tables. Users with a role and their Clerk ID. Interviews with a title, start time, status, the participants' Clerk IDs, and the Stream call ID. Comments with a rating, content, and a reference to the interview. Three indexes — one for looking up a user by Clerk ID, one for a candidate's interviews, one for an interview's comments."

**Likely follow-up:** *"Why is `candidateId` a string rather than a reference to the users table?"*
> "Because it's the Clerk ID, not the Convex document ID. That makes a few things easy — inside a function, `identity.subject` is directly comparable to `candidateId`, so a candidate's own interview list needs no extra lookup. The cost is that Convex can't validate the reference, so I could store an interview for a candidate who doesn't exist. If I did it again I'd use a real reference and accept the extra read."

**Deeper follow-up:** *"Why those three indexes specifically?"*
> "Each one backs a query that runs constantly. The role lookup happens on every page load, a candidate's interview list is their home page, and the comments index is for one interview's feedback. Without them each of those is a full table scan. There's actually a fourth place I should have used an index and didn't — my user-sync function uses a filter instead of the index that already exists, so it scans the whole table on every signup. In Convex, `withIndex` uses the index and `filter` scans in memory."

**What the interviewer is testing:** whether you designed the schema or copied it, whether you know why indexes exist, and whether you understand the cost of your own shortcuts.

---

### Topic 8 — Real-time updates

**What I should understand.** Two separate real-time systems, and the editor isn't in either.

**20-second answer**
> "There are two real-time systems and I try to keep them separate in my head. Stream is real-time for the conversation — the video, who's in the call, and the event when someone ends it. Convex is real-time for the record — interview status and feedback. If an interviewer marks something completed, an open dashboard updates on its own."

**Likely follow-up:** *"How does Convex actually do that?"*
> "When a query runs, Convex records which documents it read. Later, when a mutation writes one of those documents, it knows that query's result is stale, re-runs it, and pushes the new result down the websocket to everyone subscribed. From my side it's just `useQuery` — the component re-renders when the data changes. I never wrote polling or socket code."

**Deeper follow-up:** *"So is the code editor synced?"*
> "No, and that's the thing I'd want to be clear about. The code is plain React state in the editor component — it's never written to Convex or sent over Stream. So the interviewer can't see the candidate typing, and a refresh loses the work. Making it collaborative is the biggest feature I'd add. Either Yjs with the Monaco binding for proper character-level merging, or — since I already have Convex — debouncing the buffer into a row keyed by the call ID. The Convex version is simpler and survives refreshes, but it's last-write-wins, so simultaneous typing would lose characters."

**What the interviewer is testing:** whether you understand what "real-time" means mechanically, and whether you overstate what your app does.

---

### Topic 9 — Scalability

**What I should understand.** Which two things break first, and why, without pretending the project already solves scale.

**20-second answer**
> "At the scale I built it for it's fine, but I know where it breaks. The first thing would be two queries that fetch entire tables — the user list and all interviews — because they're unbounded and they're on hot pages. The second would be Judge0, because it's a free tier with one shared quota called straight from the browser."

**Likely follow-up:** *"How would you fix the queries?"*
> "Pagination, and returning less. The user dropdown needs a name and an avatar, not every user's email — so I'd replace that with a search endpoint that returns a limited set. For the dashboard I'd query per status bucket with a compound index instead of fetching everything and grouping on the client. My candidate interview query is already fine, because it's indexed and scoped to one user — that's the shape the others should be."

**Deeper follow-up:** *"What about all those live subscriptions?"*
> "That's the subtler cost. Every open dashboard subscribes to all interviews, so a single write re-runs and re-pushes that query to every connected dashboard. Scoping subscriptions to one page of data fixes most of it, and I'd stop making data that barely changes live at all. Honestly though, the first thing I'd actually add is measurement — right now I have `console.log`, so at that scale I'd be guessing about what's slow."

**What the interviewer is testing:** whether you can identify real bottlenecks in your own system, whether you separate "what it does now" from "what I'd change", and whether you avoid inventing scale problems you don't have.

---

### Topic 10 — Security

**What I should understand.** Lead with what's right, then be specific and unemotional about what isn't.

**20-second answer**
> "The parts I'm confident about: the Stream secret never reaches the browser, the token function takes no parameters so you can't get someone else's token, and my Clerk webhook verifies its signature before writing anything. The part I'm not: my Judge0 API key is in a client component, so it's in the bundle. That needs rotating and moving server-side."

**Likely follow-up:** *"What else would you look at?"*
> "Authorization. My Convex functions are public endpoints, so anything not checked in the function isn't checked at all. One mutation — the one that sets an interview's pass/fail status — doesn't check identity at all, and a few queries return data without checking who's asking. The pattern is that I put checks on the client side of the trust boundary in a few places, and I'd move them all to the server."

**Deeper follow-up:** *"Walk me through the worst case."*
> "Someone reads my client bundle, gets the Convex deployment URL and my Judge0 key. With the key they burn my quota. With the deployment URL they can call any public Convex function — so with an interview ID they could read the feedback about a candidate, or change a pass to a fail. The IDs aren't guessable, which limits it, but 'hard to guess' isn't access control. The fix is per-function checks that derive the user from the verified token, which is the pattern two of my functions already use."

**What the interviewer is testing:** whether you can reason about trust boundaries, whether you know a vulnerability from a rough edge, and whether you can discuss your own security gaps without either hiding them or panicking.

---

## 32. Interviewer Intent — Quick Reference

For questions not covered above. Knowing what's being tested lets you answer the question rather than recite documentation.

| Question | What they're actually testing |
|---|---|
| "Tell me about CodeSync." | Can you explain a system clearly and concisely to someone who's never seen it |
| "Why did you choose Convex?" | Do you understand trade-offs, did you choose deliberately, do you know the alternatives |
| "Why is the Stream token generated on the server?" | Client/server boundary, secret management, authentication vs authorization |
| "How would you scale this?" | Can you find real bottlenecks, do you separate current from future architecture, do you avoid inventing problems |
| "What happens if [service] goes down?" | Have you thought past the happy path; do you know your dependencies |
| "How do you know the webhook is really from Clerk?" | Do you understand signature verification, or did you copy it from a tutorial |
| "What would you do differently?" | Self-awareness, and whether your judgement improved while building |
| "Why are there indexes on those fields?" | Did you design the data access or copy a schema |
| "Is the code editor collaborative?" | Whether you overstate your project — this one is a trap if you're careless |
| "Walk me through a bug you hit." | Debugging process, not the bug |
| "What was the hardest part?" | Whether you can identify genuine difficulty vs busywork |

---

## 33. The Project Story

A 2–3 minute spoken narrative. Use it when someone says "tell me about a project" and leans back.

> **The problem.** I was doing a lot of interview prep, and I noticed that every technical interview I sat in ran the same awkward way. Video call in one tab, some coding pad in another, and then the interviewer scribbling feedback somewhere I never saw. Three tools, and everyone spends the first two minutes pasting links.
>
> **The idea.** Put them in one place. One URL per interview: you open it and you get the video and the editor side by side, and the interview record that ties them together already exists — so when the call ends, that same record picks up a pass/fail and a rating.
>
> **The architecture.** I decided early that I wasn't going to build the hard infrastructure. Clerk for authentication, Stream for video, Judge0 for running code, and Convex as my database and backend. It's a Next.js app and the browser talks to all four directly — the only server-side code I wrote is one server action plus my Convex functions.
>
> **The most interesting part.** Getting four services to agree about who a user is. Clerk creates the user, and I take the Clerk user ID and use it as the key for everything — it's on my user rows, on interviews as the candidate and interviewer IDs, and it's the user ID I give Stream. So there's one string that identifies a person across three systems, and I never have to translate between them. The same idea shows up with the call: when you schedule an interview I generate a UUID in the browser, use it as the Stream call ID, and store it on the interview row. That's how, from inside a call, I can find the interview record I need to update.
>
> **The technical challenge.** The Stream token. Stream needs a signed token to let a browser join, and signing needs a secret that can mint a token for *any* user on my app. So it obviously couldn't go in the browser. I ended up with a Next.js server action that asks Clerk who's currently signed in and mints a token for exactly that user. The detail I'm happiest with is that the function takes no parameters — the user ID comes from the session, so there's no way to ask for someone else's token. It's twelve lines, and it's the cleanest thing in the project.
>
> **A design decision I'd defend.** Convex over a normal REST API and Postgres. I wanted the candidate's interview list to update the moment an interviewer scheduled something, without polling. Convex tracks which documents each query read and re-pushes when they change, so that was one line of client code instead of a whole socket layer. The trade-off I accepted is lock-in and no joins — which is why in a couple of places I fetch a list and match IDs on the client instead of joining.
>
> **A limitation I know about.** The code editor isn't shared. It's plain React state, so the interviewer can't actually see the candidate typing, and a refresh loses the work. That's a bit ironic for an interview platform, and it's the first feature I'd build next — either Yjs for proper collaborative editing, or a simpler version where I debounce the buffer into Convex, which would at least make it persist and be reviewable afterwards.
>
> **What I learned.** Two things, really. The first is about trust boundaries — I put my Judge0 API key in a client component because it was the fastest way to make Run work, and it took me a while to internalise that "in the browser" means "public". The second is that authorization is a thing you design once, up front, not something you sprinkle on. I have functions that do it perfectly, deriving the user from the verified token, and functions right next to them that don't check anything, purely because I wrote them at different times.
>
> **What I'd improve.** In order: rotate that key and move code execution behind a server function; add role checks inside every Convex function instead of just in the UI; and then make the editor shared and persisted, because that's the feature that would actually change what the product is.

*Why this works:* it has a problem, a decision, a technical detail you can go deep on, an honest limitation, and something you learned. That's the shape interviewers are listening for.

---

## 34. Deep Follow-Up Survival Map

Where an interviewer can go after your first answer. Glance at this before you walk in.

```
CodeSync
│
├─ Architecture
│   ├─ Why no backend of your own?            -> §31 Topic 1
│   ├─ What's the downside of that?           -> no central enforcement; led to the Judge0 mistake
│   └─ Which service does what?               -> §1 mental model
│
├─ Convex
│   ├─ Why Convex?                            -> live queries, no API tier, types from schema
│   ├─ Why not PostgreSQL?                    -> 4 fewer pieces; cost = lock-in, no joins
│   ├─ How do live updates work?              -> tracks documents read, re-pushes on change
│   ├─ What about scale?                      -> two unbounded queries break first
│   ├─ Concurrent updates?                    -> transactions are safe; my status logic is last-write-wins
│   └─ What if Convex fails?                  -> queries hang, mutations toast, video still works
│
├─ Authentication
│   ├─ Why Clerk?                             -> auth is high-risk, not the point of the project
│   ├─ How does the JWT reach Convex?         -> ConvexProviderWithClerk -> auth.config.ts -> identity.subject
│   ├─ Why a webhook?                          -> creation happens inside Clerk; don't trust the client
│   ├─ How is the webhook verified?           -> Svix HMAC over raw body + timestamp
│   └─ Auth vs authorization here?            -> authn solid, authz UI-only (be honest)
│
├─ Authorization
│   ├─ Can a candidate reach /dashboard?      -> yes, no role guard on the route
│   ├─ Isn't hiding the button enough?        -> no, Convex functions are public endpoints
│   ├─ Which function is worst?               -> updateInterviewStatus, no identity check at all
│   └─ How would you fix it?                  -> requireInterviewer(ctx) at the top of every function
│
├─ Video
│   ├─ Why Stream?                            -> multi-party needs signalling + TURN + an SFU
│   ├─ Why not raw WebRTC?                    -> same, plus it's not what the project is about
│   ├─ How are tokens generated?              -> server action, no params, Clerk session -> user_id
│   ├─ Why can't the secret be client-side?   -> it can impersonate any user
│   ├─ Who can join a call?                   -> default call type; no members list (known gap)
│   └─ What if Stream is down?                -> whole (route) group loaders forever; dashboard survives
│
├─ Code execution
│   ├─ Why Judge0?                            -> sandboxing + limits + toolchains already solved
│   ├─ Security?                              -> execution safe; my key is in the client (rotate + move)
│   ├─ Rate limiting?                          -> impossible today; needs a server-side proxy first
│   ├─ Timeouts?                               -> none; wait=true can hang the UI
│   ├─ Compile errors?                        -> I read stderr but not compile_output
│   └─ Scaling?                                -> queue + async API + per-user limits + self-hosted workers
│
├─ Database
│   ├─ Why these three tables?                -> users / interviews / comments; nothing else has state
│   ├─ Why these indexes?                     -> each backs a query that runs constantly
│   ├─ Why Clerk IDs as keys?                 -> one ID across three systems, no translation
│   ├─ What does that cost?                   -> no referential integrity on candidateId
│   ├─ Why no index for interviewers?         -> it's an array field; needs a join table
│   └─ Consistency with Stream?               -> shared UUID, but two writes with no transaction
│
└─ Real-time
    ├─ What's actually live?                  -> interview records + comments (Convex); the call (Stream)
    ├─ What isn't?                            -> the editor, language/question choice, output, recordings
    └─ How would you sync the editor?         -> Yjs + y-monaco, or debounced Convex row (last-write-wins)
```

---

## 35. Question Bank

Model answers are written to be *spoken*. Keep them short; let the interviewer pull you deeper.

### Beginner

**What is CodeSync?**
> "A remote technical interview platform. It puts a video call and a code editor on the same screen, so an interviewer can talk to a candidate and watch them solve a problem without switching tools. It also handles scheduling and the feedback afterwards."

**Why did you build it?**
> "I wanted something that wasn't just CRUD. This one has real-time data, four third-party integrations, video, and running untrusted code — things I hadn't combined before. And it's a domain I understand, because I'm going through interviews myself."

**What technologies did you use?**
> "Next.js, React and TypeScript on the front end. Convex is my database and backend. Clerk for auth, Stream for video, Monaco for the editor, Judge0 for running code, and Tailwind with shadcn/ui for styling."

**What does Convex do?**
> "It's my database and my backend. I write TypeScript functions and Convex hosts them and generates types from my schema. The useful part is that queries stay live — if data a query read changes, Convex re-runs it and pushes the result to the browser. No polling."

**What does Clerk do?**
> "Sign-in, sign-up, sessions, and identity. It gives me a signed token that Convex verifies, so on the backend I know who's calling. I never store passwords."

**What does Stream do?**
> "The video call — the media, who's in the room, mute and camera state, and recordings. It also gives me React components for layouts and controls, which is why my meeting room file is short."

**What is Monaco?**
> "The editor that powers VS Code, as a React component. I get syntax highlighting, line numbers, undo, and keybindings people already know, without writing an editor."

**What are the roles?**
> "Candidate and interviewer, stored on the user row in Convex. Interviewers schedule, see the dashboard, end calls and leave feedback. Candidates see and join their own interviews. Everyone starts as a candidate — I set interviewers by hand in the Convex dashboard, which is one thing I'd build a proper flow for."

### Intermediate

**Walk me through authentication.**
> "You sign in with Clerk, which sets a session. My Convex provider takes Clerk's auth hook and attaches a JWT to every Convex call. Convex verifies it against the issuer I configured, and then inside any function `getUserIdentity()` gives me the identity, where `subject` is the Clerk user ID. That ID is the key I use everywhere — on interviews, on comments, and as the Stream user ID."

**How does a user get created in the database?**
> "A webhook. Clerk fires `user.created` at an endpoint I expose from Convex. I verify the Svix signature, then insert the user with a default role. It's idempotent — if that Clerk ID exists already it returns without inserting — which matters because webhooks retry."

**How does a meeting token get generated?**
> "The Stream client needs a signed token. I give it a token provider that's a Next.js server action. On the server it asks Clerk who the current user is, throws if there's no session, and signs a token for that user ID with the Stream secret. The function takes no arguments, so you can't ask for someone else's token."

**How does code execution work?**
> "The editor holds the code in React state. On Run I map the language to a Judge0 language ID and post the source plus the stdin box, with `wait=true` so it comes back when execution finishes. Judge0 returns a status, stdout and stderr. Status 3 means it ran, so I show stdout; otherwise I show the error."

**Why is Judge0 used?**
> "Running untrusted code is the dangerous part, and Judge0 already handles sandboxing, resource limits and the toolchains. Doing it myself would mean containers per submission, isolation and a job queue — a project on its own. With Judge0, adding a language is one line."

**How are interviews stored?**
> "One table. Title, description, start time as epoch milliseconds, an optional end time, a status, the Stream call ID, the candidate's Clerk ID, and an array of interviewer IDs. The interesting bit is that the Stream call and the row share the same UUID — I generate it in the browser and use it in both places, so I can get from a call back to its interview record."

**Why are indexes used?**
> "So a lookup isn't a full table scan. I have three: user by Clerk ID for the role check on every page load, interviews by candidate for the home page, and comments by interview. One thing I'd fix — my user-sync function uses a filter instead of the index that already exists, so it scans on every signup."

**How does Convex provide real-time updates?**
> "When a query runs, Convex records which documents it read. When a mutation writes one of them, it re-runs the query and pushes the new result to every subscribed client over a websocket. On my side it's just `useQuery` — the component re-renders when data changes."

**How does the app know an interview is over?**
> "The interviewer clicks End Meeting. That calls Stream's `endCall`, which pushes a `call.ended` event to everyone — each browser listens and navigates home. The same click also runs a Convex mutation that sets the status to completed. The weakness is that only the owner's browser does that second part, so if it crashes in between, the call ends but the record stays 'upcoming'. I'd move it to a Stream webhook."

**How is the screen split?**
> "`react-resizable-panels`. The room is a horizontal panel group — video at 35%, editor at 65%, with a drag handle. The editor panel is itself a vertical group: problem statement, Monaco, input box, terminal. Monaco is set to `automaticLayout` so it re-measures when you drag."

### Advanced

**How would you secure code execution?**
> "The execution is already safe — it's on Judge0's infrastructure, not mine. My problem is the call. The key is in the bundle, so anyone can take it, and I can't rate-limit because the browser talks to Judge0 directly. I'd move the call into a Convex action or a route handler with the key in the server environment, then add a per-user rate limit, a timeout, and a cap on source size. At higher volume I'd switch to Judge0's async API — submit and poll — so I'm not holding a synchronous request open."

**How would you prevent unauthorized access to interviews?**
> "Today I mostly don't, and I know where. Roles gate the UI but not the backend, and Convex functions are public endpoints, so hiding a button changes nothing. The fix is a `requireInterviewer` helper that loads the caller's user record from the verified identity, checks the role, and checks they're actually on that interview — called at the top of every function. On the read side I'd narrow the queries that return everything to everyone."

**What happens during concurrent updates?**
> "Convex mutations are transactions and they serialise, retrying on conflict, so I don't lose or tear a write. The problem isn't storage, it's my business rule — my status update is a blind patch, so if one interviewer clicks Pass and another clicks Fail, the second silently wins. I'd either reject transitions out of a terminal state, or store each interviewer's decision separately and derive the outcome, which is more honest for a panel anyway."

**How would you scale Judge0 usage?**
> "Right now everyone shares one free-tier key called from the browser, so the quota is a single global bottleneck. First, put it behind my own server so I control the key. Then per-user rate limits — nobody needs more than a run every few seconds. Then the async API with a queue instead of `wait=true`. At real volume, self-hosted Judge0 workers that scale horizontally, with a circuit breaker so an outage fails fast instead of hanging every editor."

**How would you implement collaborative editing?**
> "Two options. The proper one is a CRDT — Yjs with the `y-monaco` binding — where each keystroke is an operation that merges regardless of order, so both sides converge and you get cursors too. Transport could be a small websocket server. The cheaper one, since I already have Convex, is debouncing the buffer into a row keyed by the call ID and letting both sides subscribe. That's simpler and survives refreshes, but it's last-write-wins, so simultaneous typing loses characters. For an interview where usually one person types, the Convex version is probably good enough — and it has the bonus of persisting the session for review."

**Why not use WebSockets directly?**
> "For video I'd be reinventing WebRTC — signalling, TURN, an SFU — which isn't a good use of my time. For application state, Convex already runs a websocket underneath and gives me more than a raw socket would: it knows which queries read which documents, so it pushes exactly the right results. With a raw socket I'd be writing my own message protocol, my own subscription registry and my own invalidation, and probably getting reconnection wrong."

**Why Convex instead of PostgreSQL and Express?**
> "It removed a whole tier — no API server, no ORM, no migrations, no socket layer — and my schema generates the types my components use. Live updates were the deciding factor. The costs are real: lock-in, no joins, and every function is a public endpoint so authorization has to be written into each one rather than sitting in middleware. If the product needed serious reporting across interviews, I'd want SQL."

**How would you redesign this for 100,000 users?**
> "Most of the video and execution scaling isn't mine to solve — Stream and Judge0 scale, they just cost money. What I'd change is my own layer: paginate every query that fetches a whole table, stop the dashboard subscribing to all interviews, move code execution behind a queue with rate limits, and give the user picker a real search endpoint. And I'd add observability first, because at that scale I'd want to know what's actually slow rather than guess."

**How would you handle external service failures?**
> "Today, not well — Judge0 failures collapse into one generic string, and if Stream doesn't initialise the user sits on a spinner forever, on the home page as well as the meeting page, because the provider wraps the whole route group. I'd add timeouts everywhere, retry with backoff for the idempotent calls, a circuit breaker so a sustained outage fails fast, and per-service degradation — if Stream is down, still show me my interviews and tell me video is unavailable. And make the failures distinguishable: 'quota exceeded' and 'network error' shouldn't look identical."

**How would you make the system observable?**
> "Right now it's `console.log`, so I find out about failures when someone tells me. I'd add Sentry on the client with the user ID attached, structured logs inside Convex functions so I can trace one interview end to end, and a few metrics that matter for this product — code-execution success rate and latency by language, call join success rate, and webhook delivery failures. Then alerts on the ones users feel, especially webhook failures, because that silently means a user who exists in Clerk but not in my database."

**How would you implement rate limiting?**
> "It has to be server-side, which today it can't be for code execution, so step one is moving that behind my own server. After that, a Convex table keyed by user ID with a counter and a window, checked at the start of the mutation. Convex mutations are transactional, so read-check-increment is safe without extra locking. At larger scale I'd move the counters to Redis so they aren't database writes."

**How would you improve consistency between Stream and Convex?**
> "Scheduling does two independent writes with no transaction, so a failure in between leaves an orphaned call. And ending a call depends on the owner's browser doing two things in sequence. I'd invert both: write the Convex row first as pending, create the Stream call from a server function keyed by the same UUID so retries are idempotent, then mark it ready. For the ending, subscribe to Stream's `call.ended` webhook and update status server-side. Then a periodic job to reconcile anything that still drifts."

**If you rebuilt it, what would you do differently?**
> "Three things. Design the authorization model before writing any functions instead of adding checks ad hoc. Never let a third-party key near a client component — anything with a key goes behind a server function from day one. And treat the code buffer as real persisted data from the start, because 'the interviewer can see and keep the candidate's code' is the actual product, and I built it as throwaway local state."
---

## 36. Follow-Up Question Chains

Practise these out loud. The goal is surviving five to ten minutes of drilling on one topic. (The map in §34 shows where each chain can branch.)

### Chain 1 — Convex

**"Why did you use Convex?"**
> "I needed a database, a backend, and live updates. Convex gives all three — I write TypeScript functions that read and write documents, and any query the client subscribes to updates itself when the data changes. For a solo project that meant no API server, no ORM and no socket layer."

**"Why not PostgreSQL?"**
> "Postgres would have been Postgres plus an ORM plus Express plus polling or sockets plus invalidation — four more things to build and deploy. Convex collapsed that into one. The trade-off is that it's a document store with no joins, so where I'd have written a join I fetch users separately and match IDs on the client. And it's lock-in."

**"What if Convex goes down?"**
> "The app stops. Queries never resolve, so components sit on spinners — I use `undefined` to mean loading and it never becomes defined. Mutations reject and those I catch, so at least there's a toast. The video call keeps working, since Stream is independent. I'd add a timeout on loading states and an error boundary so the user gets told something."

**"What happens if two users update the same record?"**
> "Convex mutations are transactions — they serialise and retry on conflict, so nothing is lost or half-written. But my status update is a blind patch, so if two interviewers click Pass and Fail at the same time the last one wins silently. That's my business logic, not the database. I'd reject changes out of a terminal state, or record each interviewer's decision separately."

**"Would you still use Convex at 10 million users?"**
> "Probably not for everything. The parts that would hurt first are mine — queries that fetch entire tables, and every dashboard subscribing to every interview. Some of that I'd fix inside Convex with pagination and better indexes. But at that scale I'd want SQL for reporting, and I'd think hard about lock-in, because migrating means rewriting every backend function and the whole real-time story. For where this project is, Convex is the right call."

### Chain 2 — Clerk

**"Why Clerk instead of building auth?"**
> "Auth is high-risk and it isn't what the project is about. Clerk gave me sign-in, sessions, OAuth and a user-management UI in about an hour, plus components that look finished. It also has a first-class Convex integration, so the JWT plumbing was solved."

**"Where do you store the user then?"**
> "Both places, deliberately. Clerk owns identity — credentials, sessions, profile. Convex has a copy with the role attached, because the role is my application's concept, not Clerk's. A webhook keeps them in sync."

**"What if the webhook fails?"**
> "Then the user exists in Clerk but not Convex. They can sign in, but they have no role and they won't appear in the candidate dropdown. Svix retries on non-2xx, so a transient failure recovers. What I don't have is a fallback for a permanent one — I'd add a self-sync mutation that runs when a signed-in user has no record, deriving everything from the verified identity rather than from client arguments."

**"How do you know the webhook is really from Clerk?"**
> "Svix signs it. I require the three Svix headers and verify an HMAC over the raw body with a shared secret before I look at any data. Forged requests fail, and the timestamp is part of the signature so old ones can't be replayed. On failure I return 400 and never touch the database."

**"Could someone call your Convex functions without a Clerk token?"**
> "Yes — and that's the thing I'd fix first. Convex functions are public endpoints and the deployment URL is in my client bundle. Four of my functions check the identity; the rest don't, including one that writes. So an unauthenticated caller with an interview ID could change its outcome. The fix is a shared helper at the top of every function."

### Chain 3 — Stream

**"Why Stream and not raw WebRTC?"**
> "Two-party WebRTC is doable. Multi-party isn't a weekend project — you need signalling, STUN and TURN, and an SFU so each participant isn't uploading a separate stream to everyone else. Stream gives all that plus React components, which is why my meeting room is about 120 lines."

**"How does a user authenticate to Stream?"**
> "With a JWT I mint server-side. The browser's Stream client gets a token provider, which is a Next.js server action. That action asks Clerk who the current user is, then signs a token for exactly that user ID with the Stream secret. It takes no parameters, so nobody can request someone else's token."

**"Why not put the Stream secret in the client?"**
> "Because that key can mint a token for any user on my Stream app. In the bundle, anyone could impersonate anyone, join any call and query recordings. Next only inlines `NEXT_PUBLIC_` variables into the client, so the secret stays server-side by construction."

**"Who can join a given call?"**
> "More people than should, honestly. I create calls without a members list, so access is decided by Stream's default call type rather than my interview record. In practice the call ID in the URL is doing the access control — it's a random UUID so it isn't guessable, but sharing the link shares the interview. The fix is passing the candidate and interviewer IDs as members. That would also fix a side effect: candidates see no recordings, because my recordings query filters on creator-or-member and they're neither."

**"What happens if Stream is down?"**
> "My provider never finishes building the client, so it renders a loader forever. And because it wraps the whole route group, that takes out the home page and the schedule page too, not just meetings. That's a design mistake — I'd add a timeout, show an error, and let the non-video pages render with video disabled."

### Chain 4 — Judge0 and code execution

**"How does code execution work?"**
> "The browser posts the source, a Judge0 language ID and the input box contents, with `wait=true` so the response comes back once it's finished. Judge0 returns a status, stdout and stderr. Status 3 means it ran, so I show stdout; otherwise I show the error."

**"Where does the API key live?"**
> "That's the weak point — it's a hardcoded string in the editor component, which is a client component, so it's in the bundle and in git history. I'd treat it as compromised, rotate it, and move the call behind a server function that reads it from the environment."

**"Why is calling from the browser a problem beyond the key?"**
> "Because I can't rate-limit, I can't log failures, and I can't queue. Anyone can hammer Judge0 with my quota and I'd never know until it ran out mid-interview. Once it's server-side I get all three."

**"What if Judge0 is slow or hangs?"**
> "Today it hangs — `wait=true` with no timeout and no `AbortController`, so the terminal is stuck on 'Running...'. I'd add an AbortController with about a ten-second timeout and a Cancel button, and switch to the async API so a slow submission doesn't hold an open request."

**"How would you run code without Judge0?"**
> "I'd need per-submission isolation — containers, or something like gVisor or Firecracker — plus CPU and memory limits, no network from inside the sandbox, a job queue, and compiler toolchains for every language. And if I got the isolation wrong, it's arbitrary code execution on my machines. That's exactly why using a service here is the right call rather than a lazy one."

**"Can the candidate's code attack your system?"**
> "Not through execution — it never runs on my infrastructure. The realistic risks are quota abuse through the exposed key, and the fact that the candidate's code leaves my systems and goes to a third party, which I'd want to be explicit about with real users."

### Chain 5 — Authentication and authorization

**"Walk me through what happens when a user signs in."**
> "Clerk handles it and sets a session. My Convex provider attaches a JWT to every Convex call. Convex verifies the issuer and gives me the identity, where `subject` is the Clerk user ID. That one string is my join key — it's on the user row, on interviews as the candidate and interviewer IDs, on comments as the author, and it's the Stream user ID."

**"How do you know someone is an interviewer?"**
> "The role is on the Convex user row, so I look the user up by Clerk ID and read it. In the UI a hook gives me `isInterviewer` and I branch on it."

**"Is that secure?"**
> "The UI part isn't security, it's presentation. Convex functions are public endpoints, so hiding a button doesn't stop anyone calling the mutation. Some of my functions check that you're signed in; none check the role. And the dashboard route has no check at all, so a candidate who types the URL sees every interview and every comment."

**"So how would you fix it?"**
> "A `requireInterviewer(ctx)` helper in Convex that loads the user from the verified identity, checks the role, and where relevant checks they're on that specific interview — called at the top of every function. Plus a layout guard on the admin route group. The pattern already exists in my code in the right form: `addComment` takes the author from the token, and my candidate interview query filters by identity rather than a client argument. I just didn't apply it consistently."

**"Could someone escalate to interviewer?"**
> "Not through the app, because nothing writes the role — everyone is created as a candidate and I change it by hand. But my user-sync mutation is public with no auth check, so someone could insert arbitrary user rows. It should be an internal mutation callable only from my webhook handler."

### Chain 6 — Database design

**"Walk me through your schema."**
> "Three tables. Users: name, email, image, role, Clerk ID, indexed by Clerk ID. Interviews: title, description, start and optional end time, status, the Stream call ID, the candidate's Clerk ID, and an array of interviewer IDs — indexed by candidate and by Stream call ID. Comments: content, rating, author's Clerk ID, and a real reference to the interview, indexed by interview."

**"Why is `candidateId` a string rather than a reference to users?"**
> "Because it's the Clerk ID, not the Convex document ID. That makes things easy — inside a function, `identity.subject` is directly comparable to it, so the candidate's own interview query needs no lookup. The cost is that Convex can't validate the reference, so I could store an interview for a candidate who doesn't exist. If I redid it I'd use a real reference and accept the extra read."

**"Why those three indexes?"**
> "Each backs a query that runs constantly — the role lookup on every page load, a candidate's interview list, and a comment thread. Without them each is a full scan. There's a fourth I should have used and didn't: my sync function uses a filter instead of the index that already exists."

**"Why no index for an interviewer's interviews?"**
> "Because interviewers are stored as an array, and I can't do an equality index into an array field this way. That's why my dashboard fetches everything and doesn't filter — fine at demo scale, wrong at real scale. The proper fix is a join table: one row per interview-interviewer pair, indexed by interviewer."

**"How do you keep the Stream call and the interview row in sync?"**
> "I generate a UUID in the browser and use it as both the Stream call ID and `streamCallId` on the row, so I can go from either to the other. The weakness is that they're two separate writes with no transaction — if the Convex insert fails after the Stream call is created, I have an orphaned call and nothing cleans it up."

### Chain 7 — Scalability

**"What breaks first as you grow?"**
> "The two queries that fetch whole tables — the user list and all interviews. They're on hot pages and unbounded, so they get heavier in lockstep with the data. Right behind them is the Judge0 free tier, because it's one shared quota called from the browser."

**"How would you fix the queries?"**
> "Pagination, plus returning less. A real search endpoint for the user picker instead of shipping every row, and only the fields the UI needs — the dropdown needs a name and an avatar, not an email. On the dashboard I'd query per status bucket with a compound index instead of fetching everything and grouping on the client."

**"What about all those live subscriptions?"**
> "That's the subtler cost. Every open dashboard subscribes to all interviews, so one write re-runs and re-pushes to every dashboard. Scoping subscriptions to a page fixes most of it, and I'd stop making genuinely static data live."

**"And video at that scale?"**
> "Architecturally not my problem — Stream is built for it. Commercially it's the whole bill, so at scale the interesting decisions are about recording retention and resolution, not my code."

**"What would you measure to know any of this?"**
> "That's the honest gap — I'd be guessing, because I have `console.log` and nothing else. I'd want execution latency and success rate by language, call join success rate, query latency on the heavy queries, and webhook failures. Observability before optimisation."

---

## 37. Resume Claim → Actual Implementation

| Resume claim | Where it lives | How to explain it | Confidence / caveat |
|---|---|---|---|
| "Remote technical interview platform" | The whole app; scheduling in `(route)/schedule/`, meetings in `(route)/meeting/[id]/` | "Interviewers schedule, both sides join one URL, feedback is recorded afterwards." | **Accurate.** |
| "Pairing a live video call with an in-browser code editor" | `MeetingRoom.tsx` — a horizontal `ResizablePanelGroup`, video 35% / editor 65% | "One screen, resizable split — video left, code right." | **Accurate**, and the most demo-able part of the project. |
| "Multi-language code execution" | `CodeEditor.tsx` `runCode()` — four Judge0 language IDs | "JavaScript, Python, Java and C++, mapped to Judge0 IDs, with stdin support." | **Accurate.** Caveat: no test cases or expected-output checking, and only status 3 is handled well. |
| "Next.js, React, TypeScript" | Throughout | "App Router, route groups, nested layouts, and one server action." | **Accurate**, but be ready for "how much is server-rendered?" — honest answer: almost none, nearly every page is `"use client"`. |
| "Convex" | `convex/schema.ts`, `users.ts`, `interviews.ts`, `comments.ts`, `http.ts` | "Database plus backend functions plus live query updates." | **Accurate.** |
| "Clerk" | `ConvexClerkProvider`, `middleware.ts`, root layout, `auth.config.ts`, `http.ts` | "Authentication, and the identity Convex verifies." | **Accurate.** |
| "Stream Video SDK" | `StreamClientProvider`, `stream.actions.ts`, `MeetingRoom`, `MeetingSetup`, `useGetCallById`, `useGetCalls` | "Both the browser SDK and the Node SDK — the Node one only for minting tokens server-side." | **Accurate**, and the token flow is a strong thing to walk through. |
| "Monaco Editor" | `CodeEditor.tsx` via `@monaco-editor/react` | "Controlled component: `value` is React state, `language` drives highlighting, `automaticLayout` handles the resizable panel." | **Accurate.** Caveat: single-user, not collaborative. |
| "Judge0 API" | `runCode()` | "POST source + language ID + stdin with `wait=true`, then interpret the status." | **Accurate**, but **flag the key yourself**. Owning it with a concrete fix reads far better than being caught by it. |
| "Tailwind CSS" | `globals.css` (Tailwind 4 via `@import`), `@tailwindcss/postcss`, shadcn/ui in `src/components/ui/` | "Tailwind 4 with shadcn/ui on top of Radix primitives." | **Accurate.** Minor: a stale v3 `tailwind.config.js` sits unused. |
| "Convex real-time synchronization for interview state and feedback" | `useQuery` on `getMyInterviews`, `getAllInterviews`, `getComments`; the three mutations | "Interview records, status changes and comments push to connected clients automatically." | **Accurate as written — but scope it out loud.** "Interview state" means the *database record*, not the editor. If someone hears "real-time sync" and assumes shared code editing, correct it before they find out: "the record syncs in real time; the editor is local state, and making it collaborative is my next step." |
| "Role-based access control" | `role` in the schema, `useUserRole()`, UI gating in `DashboardBtn`, home page, `/schedule` | "Two roles stored in Convex that decide what each user sees." | **This is the one claim stronger than the code.** Roles gate the UI, but no Convex function checks a role, `/dashboard` has no guard, and `updateInterviewStatus` has no auth check. **Don't say "I implemented complete RBAC."** Say: "I have roles that drive what each user sees, and I know the enforcement is client-side today — the backend checks authentication but not the role. That's first on my list, and I know exactly which functions need it." That answer is stronger than the claim, because it shows you can audit your own work. |
| "Authentication" | Clerk + Convex JWT verification + Svix webhook verification | "Clerk issues the token, Convex verifies it, and the Clerk user ID is the key everywhere." | **Accurate and well implemented** — your strongest security talking point. |

**Optional resume rewording, closer to the code:**
- "role-based access control" → "role-aware interviewer and candidate experiences backed by a Convex user model" (true today) — or fix the backend checks and keep the original wording honestly.
- Consider adding "webhook-driven user provisioning with signature verification". It's implemented correctly and it's a more distinctive thing to have built than most items on the list.

---

## 38. 30-Second / 1-Minute / 3-Minute Explanations

### 30 seconds

> "CodeSync is a remote technical interview platform. Normally an interview means a video call in one tab and a coding tool in another, with feedback ending up somewhere else again — CodeSync puts all three in one place. It's Next.js, with Convex for the database and real-time updates, Clerk for auth, Stream for video, Monaco for the editor and Judge0 for running the code."

### 1 minute

> "CodeSync is a remote technical interview platform. The idea is that a technical interview needs three things — a conversation, a shared coding surface, and a record of how it went — and normally those live in three separate tools.
>
> An interviewer signs in, schedules an interview by picking a candidate and a time, and that creates two things at once: a record in my database and a video call in Stream, linked by a shared ID. When the time comes, both people open the same URL and get a split screen — video on the left, a Monaco editor on the right with a problem statement, an input box and a terminal. The candidate picks a language, writes code, hits Run, and it executes through Judge0.
>
> When the call ends, the interview gets marked completed, and the interviewer can mark it passed or failed and leave a rating and written feedback.
>
> Under the hood it's Next.js and TypeScript, Clerk for authentication, and Convex for the database and backend functions — and Convex pushes query results to the browser when data changes, so a candidate's interview list updates the moment one is scheduled."

### 3 minutes (technical interviewer)

> "CodeSync is a remote technical interview platform — video call and code editor on one screen, with the interview record and feedback in the same system.
>
> **Architecture.** It's a Next.js App Router app, and almost all of it runs in the browser. There's no API server of my own — the client talks to four services directly. Clerk for authentication, Convex for the database and backend functions, Stream for video, Judge0 for code execution. The only server-side code I wrote is one Next.js server action plus the Convex functions.
>
> **Authentication.** Clerk handles sign-in and issues a JWT. A Convex provider attaches that token to every backend call, and Convex verifies it, so inside any function I can call `getUserIdentity()` and `subject` gives me the Clerk user ID. That ID is my join key everywhere — user rows, interview participants, comment authors, and the Stream user ID. When someone signs up, Clerk fires a `user.created` webhook at an endpoint Convex exposes; I verify the Svix signature and insert a user row with a default role.
>
> **Data model.** Three tables. Users with a role. Interviews with a title, start time, status, participant IDs and a Stream call ID. Comments with a rating, content and a reference to the interview. Three indexes, each backing a query that runs constantly — the role lookup, a candidate's interview list, and a comment thread.
>
> **Scheduling.** The interviewer picks a candidate and a slot. I generate a UUID, create the Stream call with it, and insert the Convex row carrying the same UUID. That shared ID is how I get from 'the call I'm in' back to 'the interview record' — which is exactly what the End Meeting button needs.
>
> **The meeting.** Both people open `/meeting/<id>`. A resizable split: Stream's video components on the left, my editor panel on the right. The Stream client authenticates with a token minted by a server action — Clerk tells the server who's calling, and the server signs a token for that user. The secret never reaches the browser, because it can mint a token for any user on my Stream app.
>
> **Code execution.** Monaco holds the code as React state. Run posts the source, a Judge0 language ID and the input box to Judge0, waits for the result, and renders stdout or the error.
>
> **Real-time.** Two systems, and I keep them separate: Stream is real-time for the conversation, over WebRTC. Convex is real-time for the record — it tracks which documents each query read and pushes new results when they change. So a candidate's interview list updates when one is scheduled, and a comment appears for another interviewer without a refresh.
>
> **What I know is weak.** Three things. My Judge0 key is in a client component, so it's in the bundle — that needs rotating and the call needs to move server-side. Authorization is client-side: roles gate the UI, but my Convex functions check authentication and not the role, and one mutation checks nothing at all. And the editor isn't collaborative — it's local state, so the interviewer can't see the candidate typing, and a refresh loses the work. Those are the three things I'd fix first, in that order."

*(That last paragraph is deliberate. Volunteering three specific, correctly-diagnosed weaknesses with fixes lands well. Waiting to be caught doesn't.)*

---

## 39. Whiteboard Version

Draw this. It takes about 45 seconds.

```
        [ BROWSER: Next.js + React ]
          |     |      |       |
          |     |      |       +-------> JUDGE0   (run code, get stdout)
          |     |      +---------------> STREAM   (video, WebRTC)
          |     +----------------------> CONVEX   (DB + functions + live queries)
          +----------------------------> CLERK    (sign in, JWT)

        one small server bit:
          browser -> Next server action -> Stream secret -> token -> browser


        CONVEX TABLES
          users( clerkId, role )
              |                  \
          interviews( streamCallId, candidateId, interviewerIds, status )
              |
          comments( interviewId, rating, content )
```

**What to say while drawing it:**

1. *Draw the browser box.* "Everything is a Next.js app in the browser. There's no API server of my own."
2. *Draw the four arrows.* "It talks to four services directly. Clerk for auth, Convex for data, Stream for video, Judge0 for running code."
3. *Point at Clerk.* "Clerk signs the user in and gives a token. Convex verifies it, so on the backend I know who's calling — and the Clerk user ID is the key I use everywhere."
4. *Point at Convex.* "Convex is the database and the backend functions. The useful bit is that queries stay live — if a mutation changes data a query read, Convex re-runs it and pushes it to the browser."
5. *Draw the server-action line.* "One exception to 'no server': minting the Stream token needs a secret that can impersonate any user, so that happens in a server action. The user ID comes from the Clerk session, not from a parameter."
6. *Draw the three tables.* "Three tables. Users have a role. Interviews carry the Stream call ID — same UUID on both sides, that's the link. Comments hang off an interview."
7. *Point at Judge0.* "Code execution goes to Judge0. And I'll flag it — in my version that call happens from the browser with the key inline, which is wrong. It should be behind a server function."

Say that last line unprompted. It turns the biggest flaw in the project into evidence that you can review your own code.

---

## 40. CodeSync — Last-Minute Revision

### 1. Project in 5 lines
1. Remote technical interview platform: video call and code editor on one screen.
2. Interviewer schedules; both join one URL; candidate codes; interviewer marks pass/fail and leaves feedback.
3. Next.js App Router app; almost everything runs client-side.
4. The browser talks to four services directly — Clerk, Convex, Stream, Judge0.
5. The only server-side code I wrote: one Next.js server action plus the Convex functions.

### 2. Architecture

```
   BROWSER (Next.js + React)
     |--> CLERK    sign in, JWT
     |--> CONVEX   database + backend functions + live queries
     |--> STREAM   video call, recordings
     |--> JUDGE0   runs the code

   browser -> Next server action -> STREAM_SECRET_KEY -> token -> browser
```

### 3. Five technologies and their roles
| Tech | Role |
|---|---|
| Clerk | Who is the user? (JWT; `identity.subject` = Clerk user ID) |
| Convex | What is the interview record? (DB + functions + live updates) |
| Stream | How do they talk? (video, participants, recordings) |
| Monaco | Where does the candidate write code? (single-user editor) |
| Judge0 | Where does the code run? (JS 63, Python 71, Java 62, C++ 54) |

### 4. Three database tables
- `users` — name, email, image, role (`candidate` \| `interviewer`), `clerkId`. Index: `by_clerk_id`.
- `interviews` — title, description, `startTime`, `endTime?`, status, `streamCallId`, `candidateId`, `interviewerIds[]`. Indexes: `by_candidate_id`, `by_stream_call_id`.
- `comments` — content, rating, `interviewerId`, `interviewId`. Index: `by_interview_id`.

### 5. Authentication flow
Clerk sign-in → JWT → `ConvexProviderWithClerk` attaches it → Convex verifies against `auth.config.ts` → `identity.subject` = Clerk user ID.
Separately: Clerk `user.created` → webhook → Svix signature verified → `syncUser` → users table, role `candidate`.

### 6. Meeting flow
Schedule → `crypto.randomUUID()` → Stream `getOrCreate` **+** Convex `createInterview` (same UUID) → both open `/meeting/<uuid>` → Stream token from the server action → `MeetingSetup` → `call.join()` → `MeetingRoom` (video 35% | editor 65%) → End Meeting → `call.endCall()` **+** status `completed` → dashboard Pass/Fail + rating and comment.

### 7. Code execution flow
Monaco state → Run → POST to Judge0 (`wait=true`, language ID, stdin, 5s CPU, 128 MB) → `status.id === 3` ? stdout : error + stderr → terminal panel.

### 8. Three important design decisions
1. **One Clerk user ID as the join key** across Clerk, Convex and Stream — no translation between systems.
2. **One shared UUID** linking the Convex interview row to the Stream call — how a call finds its record.
3. **Buy, don't build** — video, auth and code execution are all integrated, not written.

### 9. Three important limitations
1. The editor is local React state — not shared, not persisted, lost on refresh.
2. Backend authorization is incomplete — roles gate the UI, not the Convex functions.
3. The Judge0 API key is in a client component — must be rotated and moved server-side.

### 10. Ten likely questions
1. Tell me about CodeSync. → §38
2. Walk me through the architecture. → §31 Topic 1, §39
3. Why Convex instead of Postgres? → §31 Topic 2, §36 Chain 1
4. How does authentication work? → §31 Topic 3
5. Why is the Stream token minted on the server? → §31 Topic 5
6. How does code execution work, and is it secure? → §31 Topic 6
7. How does Convex give you real-time updates? → §31 Topic 8
8. Why those indexes? → §31 Topic 7
9. What if Judge0 / Stream / Convex is down? → §25
10. What would you improve with more time? → §29

### 11. Five things I must remember
1. **`identity.subject` is the Clerk user ID** — the join key across all three systems.
2. **One UUID** is both the Stream call ID and the Convex `streamCallId`.
3. **Convex tracks which documents a query read**, and re-pushes when they change. That's the whole real-time story.
4. **The Stream secret can impersonate any user** — which is why the token is minted in a server action that takes no parameters.
5. **Name my three weaknesses before I'm asked** — Judge0 key in the client, UI-only authorization, non-collaborative editor — each with a specific fix.
