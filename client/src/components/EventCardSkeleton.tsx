/* Placeholder shown in place of an EventCard while the dashboard loads.
   It deliberately reuses EventCard's layout classes (.event-card__*) so
   the two stay dimensionally in step — only the leaf content is swapped
   for shimmer blocks. Announcing the load is the caller's job; every
   node here is decorative. */
export default function EventCardSkeleton() {
  return (
    <div className="card event-card skeleton-card" aria-hidden="true">
      <div className="event-card__header">
        <span className="skeleton skeleton--company" />
        <span className="skeleton skeleton--badge" />
      </div>

      <div className="event-card__body">
        {/* Date row: primary line plus the secondary time line. */}
        <div className="event-detail">
          <span className="skeleton skeleton--icon" />
          <span className="event-detail__content">
            <span className="skeleton skeleton--line" />
            <span className="skeleton skeleton--line skeleton--sm" />
          </span>
        </div>

        {/* Venue row: single line. */}
        <div className="event-detail">
          <span className="skeleton skeleton--icon" />
          <span className="event-detail__content">
            <span className="skeleton skeleton--line skeleton--md" />
          </span>
        </div>
      </div>

      <div className="event-card__footer">
        <span className="skeleton skeleton--meter" />
        <span className="skeleton skeleton--status" />
      </div>
    </div>
  );
}
