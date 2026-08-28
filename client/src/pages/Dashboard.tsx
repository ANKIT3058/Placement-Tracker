import { useCallback, useEffect, useState } from "react";
import { getEvents } from "../api/eventApi";
import { logout } from "../api/authApi";
import EventCard from "../components/EventCard";
import EventCardSkeleton from "../components/EventCardSkeleton";
import EmptyState from "../components/EmptyState";
import EventDetailsDrawer from "../components/EventDetailsDrawer";
import ReviewCard from "../components/ReviewCard";
import EmailInput from "../components/EmailInput";
import StudentProfileSection from "../components/StudentProfileSection";
import ShortlistSection from "../components/ShortlistSection";
import type { Event } from "../types/event";

/* Stable keys for the placeholder cards. Three fills a desktop row
   without pushing the fold down on mobile. */
const SKELETON_CARDS = ["a", "b", "c"];

/* The extraction pipeline emits one of four canonical stages, but
   ReviewCard lets a reviewer retype the field freehand — so each chip
   matches its canonical value plus the same variants EventCard's badge
   map already recognises. Word boundaries keep "OA" from matching
   incidental letter pairs. */
const STAGE_FILTERS: { id: string; label: string; pattern: RegExp | null }[] = [
  { id: "all", label: "All", pattern: null },
  { id: "registration", label: "Registration", pattern: /\bregistrations?\b|\bregister\b/i },
  { id: "oa", label: "OA", pattern: /\boa\b|\bonline assessment\b|\bassessment\b/i },
  { id: "interview", label: "Interview", pattern: /\binterview\b/i },
  { id: "ppt", label: "PPT", pattern: /\bppt\b|\bpre[-\s]?placement talk\b/i },
];

/* Where signing in begins. OAuth is a top-level browser navigation — the
   backend answers /gmail/auth with a 302 to Google — so this is an anchor
   the browser follows, never a fetch. The base path is read from the
   environment exactly as the API modules read it. */
const SIGN_IN_URL = `${import.meta.env.VITE_API_URL}/gmail/auth`;

/* 401 is the only failure that means "sign in". Every other failure —
   500, a network drop — is ours, and offering a sign-in link for it would
   send the user round a loop that cannot fix anything. */
const isAuthenticationRequired = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { status?: unknown }).status === 401;

/* Why a failed logout could not be reported.
 *
 * Only two outcomes are reachable: the endpoint answers 200 for a caller with
 * no session, and it is not behind requireAuth, so neither 401 nor 400 can
 * occur. A status at all means the server answered and refused; its absence
 * means it was never reached.
 *
 * Deliberately not folded into EmailInput's and ReviewCard's equivalents: those
 * two differ from each other in how they treat a 400 (ReviewCard shows the
 * server's message, EmailInput does not) and this one has no 400 branch at all.
 * They are three similar-looking functions, not three copies of one. */
const logoutErrorMessage = (error: unknown): string => {
  const status =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown }).status
      : undefined;

  return typeof status === "number"
    ? "Could not log you out. Please try again."
    : "Could not reach the server. Check your connection and try again.";
};

function SearchIcon() {
  return (
    <svg
      className="section-search__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.9-3.9" />
    </svg>
  );
}

/* The disclosure's only state indicator. Decorative on purpose: <details>
   already exposes expanded/collapsed to assistive technology, so a second,
   hand-maintained announcement would be one more thing able to disagree
   with the element's real state. */
function ChevronIcon() {
  return (
    <svg
      className="past-events__chevron"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}


export default function Dashboard() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [stageId, setStageId] = useState("all");
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  /* Whether the Past Events disclosure is open. Collapsed on first paint
     because history is the least actionable thing this page holds — with
     68 expired events against 3 upcoming, rendering it by default buries
     the answer to "what do I need to care about right now?".

     Local, and not persisted: a remembered preference would need a
     storage key and a migration story for a single boolean, and the
     collapsed default is the one that should win on every visit anyway.
     `<details>` owns the real state; this mirrors it so the cards can be
     left unrendered while closed. */
  const [pastEventsOpen, setPastEventsOpen] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const data: Event[] = await getEvents();
      setEvents(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      /* Required, not defensive: `getEvents` rejects on any non-2xx
         response, and this function's result is not awaited by the
         effect that calls it — without a catch a failed load would be an
         unhandled rejection and the UI would silently keep the previous
         (or empty) list. */
      setError(err);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* Ending the session is the server's job; this only asks and then re-reads
     the answer.

     No optimistic signed-out state. If the request fails the session may still
     be live, and a screen claiming otherwise is the most dangerous thing this
     page could say — on a shared machine especially. So the UI changes only
     after `fetchData` comes back 401, which is the same signal that drives
     every other authentication decision here. */
  const handleLogout = async () => {
    if (loggingOut) {
      return;
    }

    setLoggingOut(true);
    setLogoutError(null);

    try {
      await logout();
      await fetchData();
    } catch (err) {
      setLogoutError(logoutErrorMessage(err));
    } finally {
      setLoggingOut(false);
    }
  };

  const reviewEvents = events.filter((e) => e.status === "review");

  /* Review is a lifecycle state with its own section, so it is taken out
     first; the temporal split applies only to what remains. An event
     awaiting review is not "upcoming" or "expired" as far as this page is
     concerned — it is waiting for a person. */
  const datedEvents = events
    .filter((e) => e.status !== "review")
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  /* Temporal placement comes from the backend and nowhere else. The server
     derives temporalStatus from date, time and isTimeEstimated against an
     authoritative clock in IST; re-deriving it here would give the viewer's
     timezone a vote in a decision already made, and would disagree with it
     for anyone outside IST.

     Only "expired" is matched positively. An unrecognised value — a newer
     backend, a partial deploy — falls through to Upcoming rather than
     vanishing from both sections, matching how STATUS_TONE and STAGE_BADGE
     already treat unknown values from the API. Showing an event that has
     passed is a much smaller failure than silently dropping one. */
  const expiredEvents = datedEvents.filter(
    (e) => e.temporalStatus === "expired",
  );
  const upcomingEvents = datedEvents.filter(
    (e) => e.temporalStatus !== "expired",
  );

  /* Derived, not stored: the filter is a view of upcomingEvents, so it
     can never drift out of sync with the fetched data. Search and stage
     are two predicates over one pass — adding a third would go here. */
  const term = search.trim();
  const query = term.toLowerCase();
  const activeStage =
    STAGE_FILTERS.find((f) => f.id === stageId) ?? STAGE_FILTERS[0];

  const visibleEvents = upcomingEvents.filter(
    (e) =>
      (!query || e.company.toLowerCase().includes(query)) &&
      (!activeStage.pattern || activeStage.pattern.test(e.stage)),
  );

  const stageLabel = activeStage.pattern ? activeStage.label : null;

  /* One concise line, not a panel. Narrowing a list is an ordinary thing
     to do and an ordinary thing to undo — the search box and the stage
     chips are both still on screen, directly above — so a dashed card
     with an icon, a heading and a sentence of advice was answering a
     question nobody had asked. It still says WHICH filter emptied the
     list, because that is the part a student cannot see for themselves
     when both are applied at once. */
  const noMatchMessage =
    term && stageLabel
      ? `No ${stageLabel} events match “${term}”`
      : term
        ? `No events match “${term}”`
        : `No ${stageLabel} events coming up`;

  /* SKELETONS ONLY WHEN THERE IS NOTHING TO SHOW YET.
     `loading` is true for the first load AND for every `refresh()` a
     child triggers, so confirming one review event or extracting one
     email replaced the entire page — five real cards became three
     placeholders and the whole section went `aria-busy` — for the
     length of a round trip. A local action produced a global loading
     state that read as a page reload.

     Keyed on the data rather than on a second flag: if there is
     something to show, showing it beats replacing it with a guess of
     itself. The first load still gets skeletons because there is
     genuinely nothing to draw. */
  const showSkeletons = loading && events.length === 0;

  return (
    <div className="dashboard">
      <div className="dashboard-container">
        <header className="dashboard-header">
          {/* The product's name, not its pitch.
              "Track placement opportunities from your college emails" is
              a sentence written for someone deciding whether to sign up;
              everyone who reads it here has already signed in. At 32px
              across two lines it was also the loudest thing on the page
              and pushed the first event card most of a screen down. The
              subtitle keeps the one piece of context that still earns
              its place — what this page is showing you. */}
          <h1>Placement Tracker</h1>
          <p className="dashboard-subtitle">
            Your placement opportunities at a glance
          </p>

          {/* Offered only once there is a session to end: hidden while the
              first load is still deciding, and hidden in the signed-out state
              where "Log out" beside "Sign in" would be nonsense.

              A button, not a link — ending a session is a state-changing POST,
              and a GET form of it would be CSRF-reachable under SameSite=Lax
              (RFC-001 §11.4). Disabled in flight so a second click cannot
              issue a second request. */}
          {!loading && !isAuthenticationRequired(error) && (
            <div className="dashboard-account">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleLogout}
                disabled={loggingOut}
                aria-busy={loggingOut}
              >
                {/* The label stays put while the request is in flight.
                    EmailInput and ReviewCard swap theirs for "Processing…" /
                    "Saving…", but those are the only control in their section;
                    renaming this one mid-interaction changes its accessible
                    name, which a screen reader announces as a different
                    control. `disabled` + `aria-busy` carry the progress. */}
                Log out
              </button>

              {logoutError && (
                <p className="email-message email-message--error" role="alert">
                  {logoutError}
                </p>
              )}
            </div>
          )}
        </header>

        <main className="dashboard-main">
          {/* THE EVENTS COME FIRST.
              The three tool panels below used to sit here, above everything,
              so the page opened on a raw-email textarea and a registration
              number field and only then reached the events. They are
              maintenance, not the reason anyone opens this page; the order
              now says so. Nothing about them changed except where they are. */}
          {showSkeletons ? (
            <section className="section" aria-busy="true">
              {/* Mirrors the loaded section header so the heading doesn't
                  appear out of nowhere once the fetch resolves. */}
              <div className="section-header">
                <h2>Upcoming Events</h2>
                <span className="skeleton skeleton--count" aria-hidden="true" />
              </div>
              <p className="sr-only" role="status">
                Loading events…
              </p>
              <div className="cards-grid">
                {SKELETON_CARDS.map((key) => (
                  <EventCardSkeleton key={key} />
                ))}
              </div>
            </section>
          ) : error ? (
            /* A failed load is not an empty account. Rendering the usual
               sections here would show "No events yet" to someone whose
               request never succeeded — which, for a signed-out user, is
               the app confidently reporting something it does not know. */
            <section className="section">
              {isAuthenticationRequired(error) ? (
                <EmptyState
                  icon="calendar"
                  title="Sign in to see your events"
                  description="Placement Tracker reads placement announcements from your college inbox. Sign in with the Google account that receives them."
                  action={
                    <a className="btn btn-confirm" href={SIGN_IN_URL}>
                      Sign in with Google
                    </a>
                  }
                />
              ) : (
                <EmptyState
                  icon="calendar"
                  title="Couldn't load your events"
                  description="Something went wrong on our side. Try again in a moment."
                />
              )}
            </section>
          ) : (
            <>
              <section className="section">
                <div className="section-header">
                  <h2>Upcoming Events</h2>
                  <span className="section-count">{visibleEvents.length}</span>
                </div>

                {/* Nothing to search through until there are events, so the
                    field stays out of the way of the first-run empty state. */}
                {upcomingEvents.length > 0 && (
                  <div className="section-controls">
                    <div className="section-search">
                      <label className="sr-only" htmlFor="event-search">
                        Search events by company
                      </label>
                      <SearchIcon />
                      <input
                        id="event-search"
                        type="search"
                        className="section-search__input"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search by company"
                      />
                    </div>

                    <div
                      className="section-filters"
                      role="group"
                      aria-label="Filter by stage"
                    >
                      {STAGE_FILTERS.map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          className={`filter-chip ${
                            f.id === stageId ? "is-active" : ""
                          }`}
                          aria-pressed={f.id === stageId}
                          onClick={() => setStageId(f.id)}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Always mounted so the live region exists before it has
                    anything to announce. */}
                <p className="sr-only" role="status" aria-live="polite">
                  {query || stageLabel
                    ? `${visibleEvents.length} of ${upcomingEvents.length} events match the current filters`
                    : ""}
                </p>

                {upcomingEvents.length === 0 ? (
                  /* Two different situations wore one sentence, and it
                     had also gone stale: it said the email form was
                     "above", which stopped being true when Phase 2 moved
                     the tools below the events. Someone whose drives have
                     all happened was being told to paste an email, with
                     no hint that their history is a section further down
                     — an empty Upcoming is not an empty account. */
                  <EmptyState
                    icon="calendar"
                    title="No events yet"
                    description={
                      expiredEvents.length > 0
                        ? "Nothing is coming up right now — your earlier drives are under Past Events below."
                        : "Paste a placement email below and any events it mentions will show up here."
                    }
                  />
                ) : visibleEvents.length === 0 ? (
                  <EmptyState icon="search" compact title={noMatchMessage} />
                ) : (
                  <div className="cards-grid">
                    {visibleEvents.map((e) => (
                      <EventCard
                        key={e.id}
                        event={e}
                        onSelect={() => setSelectedEvent(e)}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section className="section">
                <div className="section-header">
                  <h2>Needs Review</h2>
                  {/* Amber reads as "needs attention" — wrong signal for a
                      count of zero, so the chip stays neutral when empty. */}
                  <span
                    className={`section-count ${
                      reviewEvents.length > 0 ? "section-count-review" : ""
                    }`}
                  >
                    {reviewEvents.length}
                  </span>
                </div>
                {reviewEvents.length === 0 ? (
                  /* One line, because the empty case is the normal case.
                     A dashed panel with a ringed icon and a sentence
                     explaining the queue was spending an event card's
                     worth of height to report that there is no work —
                     and it said it directly under a heading that already
                     reads "Needs Review · 0".

                     The section still gains its full weight the moment
                     there IS work: the branch below is untouched, and a
                     real ReviewCard carries its reason, its fields, its
                     confidence and Confirm & Save exactly as before. */
                  <EmptyState
                    icon="check"
                    tone="positive"
                    compact
                    title="Nothing needs your attention"
                  />
                ) : (
                  <div className="cards-grid">
                    {reviewEvents.map((e) => (
                      <ReviewCard key={e.id} event={e} refresh={fetchData} />
                    ))}
                  </div>
                )}
              </section>

              {/* Last, because it is the least actionable of the three: what
                  has already happened, kept for reference. The search and
                  stage filters stay scoped to Upcoming — they narrow what you
                  are deciding about, not what you are looking back at.

                  COLLAPSED, because on real data this section is the page.
                  Sixty-eight expired events against three upcoming ones means
                  a student scrolls past everything that already happened to
                  reach the thing that has not. Reference material should stay
                  reachable without being the first thing in the way.

                  A native <details>, not a hand-rolled toggle: it carries
                  keyboard activation, the expanded/collapsed state that
                  assistive technology reads, and focus behaviour, none of
                  which has to be written or kept correct here. */}
              <section className="section">
                <details
                  className="past-events"
                  open={pastEventsOpen}
                  /* `<details>` owns the truth; this mirrors it so the cards
                     below can be left unrendered while closed. Reading
                     `currentTarget.open` rather than negating our own state
                     keeps the two in step even when the element is toggled by
                     something other than a click. */
                  onToggle={(e) => setPastEventsOpen(e.currentTarget.open)}
                >
                  <summary className="past-events__summary">
                    {/* Still an <h2>, so the section keeps its place in the
                        document outline whether it is open or shut. */}
                    <h2 className="past-events__title">Past Events</h2>
                    <span className="section-count">{expiredEvents.length}</span>
                    <ChevronIcon />
                  </summary>

                  {/* NOT RENDERED WHILE CLOSED — hidden with CSS it would
                      still be sixty-eight cards' worth of DOM, and the point
                      of collapsing it is that none of that work happens until
                      someone asks for it. */}
                  {pastEventsOpen && (
                    <div className="past-events__body">
                      {expiredEvents.length === 0 ? (
                        <EmptyState
                          icon="calendar"
                          title="Nothing has expired"
                          description="Events move here once their scheduled date has passed."
                        />
                      ) : (
                        <div className="cards-grid">
                          {expiredEvents.map((e) => (
                            <EventCard
                              key={e.id}
                              event={e}
                              onSelect={() => setSelectedEvent(e)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </details>
              </section>
            </>
          )}

          {/* ── Secondary tools ──────────────────────────────────────
              Below the events, deliberately. Each block is unchanged from
              where it used to sit at the top of the page — same components,
              same props, same authentication guards. Only the order moved.

              Manual ingestion is an authenticated feature: POST /email is
              behind requireAuth and Email.userId is NOT NULL, so a signed-out
              caller has no owner to attribute a row to and is refused.
              Offering the form in that state advertises an action that cannot
              succeed. Only the authentication-required state hides it — a 500
              says nothing about who the user is, and during loading nothing is
              known yet. */}
          {/* ONE BAND, NOT THREE STRAY SECTIONS. The three below were
              already visually secondary after Phase 3, but they still
              arrived as three unrelated blocks at the bottom of the
              page. A single quiet "Tools" label and one wrapper say what
              they have in common — they are things you use, not things
              you read — so a student scrolling past them can stop
              reading once.

              PRESENTATION ONLY. The components, their props, their
              authentication guards and their order are exactly as they
              were; this adds a <section> and a heading around them and
              nothing else. Each still hides itself independently on its
              own failure, so the band shrinks to whatever is available.

              The guard is repeated per child rather than hoisted onto
              the wrapper on purpose: `EmailInput` is gated on the
              Dashboard's auth state, while the other two ALSO hide
              themselves when their own fetch fails. Hoisting would look
              tidier and would quietly change when the label appears. */}
          {!isAuthenticationRequired(error) && (
            <section className="tools" aria-labelledby="tools-title">
              {/* A LABEL, NOT A HEADING, and deliberately so.
                  The three blocks inside each own an <h2> — they are
                  separate components and this phase does not touch them
                  — so an <h2> here would be a heading containing three
                  headings of its own level, which is a worse document
                  outline than the one it replaced. `aria-labelledby` on
                  the <section> gives the same result the heading was
                  wanted for: a named region a screen reader can jump to
                  and skip, with the outline left alone. */}
              <p className="tools__title" id="tools-title">
                Tools
              </p>

              <EmailInput refresh={fetchData} />

              {/* Optional campus information, and deliberately just another
                  section: it gates nothing, and a student who never sets a
                  registration number sees an application that behaves
                  identically. It hides itself when its own load fails, so a
                  500 here adds no second error banner to a page that already
                  reports what went wrong. */}
              <StudentProfileSection />

              {/* Reads the profile section's field indirectly: the server
                  decides whether there is a registration number to check
                  with, and this section explains all four outcomes rather
                  than showing an empty list for two different reasons. It
                  hides itself when its own load fails. */}
              <ShortlistSection />
            </section>
          )}
        </main>
      </div>

      {/* Mounting only while open lets the drawer call showModal() once on
          mount and lets the browser restore focus to the card on close. */}
      {selectedEvent && (
        <EventDetailsDrawer
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </div>
  );
}
