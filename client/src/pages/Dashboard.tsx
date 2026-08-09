import { useCallback, useEffect, useState } from "react";
import { getEvents } from "../api/eventApi";
import EventCard from "../components/EventCard";
import EventCardSkeleton from "../components/EventCardSkeleton";
import ReviewCard from "../components/ReviewCard";
import EmailInput from "../components/EmailInput";

/* Stable keys for the placeholder cards. Three fills a desktop row
   without pushing the fold down on mobile. */
const SKELETON_CARDS = ["a", "b", "c"];

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
                  <span className="section-count">{upcomingEvents.length}</span>
                </div>
                {upcomingEvents.length === 0 ? (
                  <div className="empty-state">
                    <p>No events yet</p>
                    <p className="empty-hint">
                      Paste an email above to get started
                    </p>
                  </div>
                ) : (
                  <div className="cards-grid">
                    {upcomingEvents.map((e) => (
                      <EventCard key={e.id} event={e} />
                    ))}
                  </div>
                )}
              </section>

              {reviewEvents.length > 0 && (
                <section className="section">
                  <div className="section-header">
                    <h2>Needs Review</h2>
                    <span className="section-count section-count-review">
                      {reviewEvents.length}
                    </span>
                  </div>
                  <div className="cards-grid">
                    {reviewEvents.map((e) => (
                      <ReviewCard key={e.id} event={e} refresh={fetchData} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
