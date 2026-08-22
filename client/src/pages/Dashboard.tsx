import { useCallback, useEffect, useState } from "react";
import { getEvents } from "../api/eventApi";
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

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const data: Event[] = await getEvents();
      setEvents(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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
        </header>

        <main className="dashboard-main">
          <EmailInput refresh={fetchData} />

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
