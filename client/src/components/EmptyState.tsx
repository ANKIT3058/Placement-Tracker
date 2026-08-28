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
  compact = false,
  action,
}: {
  icon: keyof typeof ICONS;
  title: string;
  description?: string;
  tone?: "default" | "positive";
  /* One quiet line instead of a panel, for a section whose emptiness is
     the expected state rather than a gap to fill.

     "Nothing needs review" is good news, and it was being delivered in a
     dashed box roughly the height of an event card: a 44px ringed icon,
     a heading, and a sentence explaining a queue that is empty. The
     compact form keeps the icon and the title inline and drops the
     panel; the caller simply stops passing a description.

     A VARIANT RATHER THAN A SECOND COMPONENT, because everything else —
     the icon set, the tone tokens, the title — is identical, and the
     four other call sites keep the panel by doing nothing. */
  compact?: boolean;
  /* Optional call to action rendered under the description — the
     signed-out state needs a sign-in link, and every other caller keeps
     working unchanged because it is optional. */
  action?: React.ReactNode;
}) {
  return (
    <div
      className={[
        "empty-state",
        compact ? "empty-state--compact" : "",
        tone === "positive" ? "empty-state--positive" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="empty-state__icon" aria-hidden="true">
        {ICONS[icon]}
      </span>
      <p className="empty-state__title">{title}</p>
      {description && <p className="empty-state__description">{description}</p>}
      {action}
    </div>
  );
}
