/* Placeholder shown when a dashboard section has no rows.
   Icons are named rather than passed in as nodes: the two call sites
   want a consistent glyph, not arbitrary markup, and this keeps the SVG
   paths out of the page component. Adding one is a single map entry. */

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const ICONS = {
  calendar: (
    <svg {...iconProps}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  ),
  check: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  ),
  search: (
    <svg {...iconProps}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.9-3.9" />
    </svg>
  ),
};

export default function EmptyState({
  icon,
  title,
  description,
  tone = "default",
}: {
  icon: keyof typeof ICONS;
  title: string;
  description?: string;
  tone?: "default" | "positive";
}) {
  return (
    <div
      className={`empty-state ${tone === "positive" ? "empty-state--positive" : ""}`}
    >
      <span className="empty-state__icon" aria-hidden="true">
        {ICONS[icon]}
      </span>
      <p className="empty-state__title">{title}</p>
      {description && <p className="empty-state__description">{description}</p>}
    </div>
  );
}
