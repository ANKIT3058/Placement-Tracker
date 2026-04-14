import { useCallback, useEffect, useState } from "react";
import { getEvents } from "../api/eventApi";
import EventCard from "../components/EventCard";
import ReviewCard from "../components/ReviewCard";
import EmailInput from "../components/EmailInput";

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
      <header className="dashboard-header">
        <h1>Placement Tracker</h1>
        <p className="dashboard-subtitle">
          AI-powered placement event extraction and tracking
        </p>
      </header>

      <EmailInput refresh={fetchData} />

      {loading ? (
        <div className="loading-state">
          <span className="spinner" />
          <span>Loading events…</span>
        </div>
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
                <p className="empty-hint">Paste an email above to get started</p>
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
    </div>
  );
}
