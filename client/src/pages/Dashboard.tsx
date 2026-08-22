import { useCallback, useEffect, useState } from "react";
import { getEvents } from "../api/eventApi";
import { logout } from "../api/authApi";
import EventCard from "../components/EventCard";
import EventCardSkeleton from "../components/EventCardSkeleton";
import EmptyState from "../components/EmptyState";
import EventDetailsDrawer from "../components/EventDetailsDrawer";
import ReviewCard from "../components/ReviewCard";
import EmailInput from "../components/EmailInput";
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


export default function Dashboard() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [stageId, setStageId] = useState("all");
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

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
  const noMatchDescription =
    term && stageLabel
      ? `No ${stageLabel} events match “${term}”. Try another stage or term.`
      : term
        ? `No company matches “${term}”. Try a shorter or different term.`
        : `No ${stageLabel} events coming up. Pick another stage to see more.`;

  return (
    <div className="dashboard">
      <div className="dashboard-container">
        <header className="dashboard-header">
          <h1>Track placement opportunities from your college emails</h1>
          <p className="dashboard-subtitle">
            AI-powered placement event extraction and tracking
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
          {/* Manual ingestion is an authenticated feature — POST /email is
              behind requireAuth and Email.userId is NOT NULL, so a signed-out
              caller has no owner to attribute a row to and is refused. Offering
              the form in that state advertises an action that cannot succeed,
              directly above the panel explaining they are signed out.

              Only the authentication-required state hides it. A 500 says
              nothing about who the user is, and during loading nothing is known
              yet, so both keep the form exactly where it was. */}
          {!isAuthenticationRequired(error) && (
            <EmailInput refresh={fetchData} />
          )}

          {loading ? (
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
                  <EmptyState
                    icon="calendar"
                    title="No events yet"
                    description="Paste a placement email above and the extracted events will show up here."
                  />
                ) : visibleEvents.length === 0 ? (
                  <EmptyState
                    icon="search"
                    title="No matching events"
                    description={noMatchDescription}
                  />
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
                  <EmptyState
                    icon="check"
                    tone="positive"
                    title="Nothing needs review"
                    description="Events the AI wasn't confident about land here so you can correct and confirm them."
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
                  has already happened, kept for reference. Placing it here
                  also leaves Upcoming and Needs Review exactly where they
                  were. The search and stage filters stay scoped to Upcoming —
                  they narrow what you are deciding about, not what you are
                  looking back at. */}
              <section className="section">
                <div className="section-header">
                  <h2>Expired Events</h2>
                  <span className="section-count">{expiredEvents.length}</span>
                </div>

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
              </section>
            </>
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
