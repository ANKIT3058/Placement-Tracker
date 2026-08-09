import { useCallback, useEffect, useState } from "react";
import { getEvents } from "../api/eventApi";
import EventCard from "../components/EventCard";
import EventCardSkeleton from "../components/EventCardSkeleton";
import EmptyState from "../components/EmptyState";
import ReviewCard from "../components/ReviewCard";
import EmailInput from "../components/EmailInput";

/* Stable keys for the placeholder cards. Three fills a desktop row
   without pushing the fold down on mobile. */
const SKELETON_CARDS = ["a", "b", "c"];

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

interface Event {
  id: number;
  company: string;
  stage: string;
  date: string;
  venue: string | null;
  confidence: number;
  status: string;
  reviewReason?: string;
}

export default function Dashboard() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

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

  const upcomingEvents = events
    .filter((e) => e.status !== "review")
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const reviewEvents = events.filter((e) => e.status === "review");

  /* Derived, not stored: the filter is a view of upcomingEvents, so it
     can never drift out of sync with the fetched data. */
  const query = search.trim().toLowerCase();
  const visibleEvents = query
    ? upcomingEvents.filter((e) => e.company.toLowerCase().includes(query))
    : upcomingEvents;

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
                )}

                {/* Always mounted so the live region exists before it has
                    anything to announce. */}
                <p className="sr-only" role="status" aria-live="polite">
                  {query
                    ? `${visibleEvents.length} of ${upcomingEvents.length} events match ${search.trim()}`
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
                    description={`No company matches “${search.trim()}”. Try a shorter or different term.`}
                  />
                ) : (
                  <div className="cards-grid">
                    {visibleEvents.map((e) => (
                      <EventCard key={e.id} event={e} />
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
            </>
          )}
        </main>
      </div>
    </div>
  );
}
