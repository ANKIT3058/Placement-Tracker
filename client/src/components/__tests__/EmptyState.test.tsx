/* Smoke test for the frontend test infrastructure (PR-6A).
   It exists to prove one thing: React + Vitest + jsdom + Testing Library are
   wired together correctly, and a component can be rendered and queried.

   `EmptyState` is the subject because it is the simplest stable component in
   the app — pure presentation, props in and markup out, with no fetch, no
   session, no state and no `import.meta.env` access. Rendering it exercises the
   whole chain (JSX transform, DOM environment, queries, jest-dom matchers)
   without depending on anything that could fail for an unrelated reason.

   It deliberately asserts nothing about events, dates, or temporalStatus —
   that is PR-6. */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import EmptyState from "../EmptyState";

describe("frontend test infrastructure", () => {
  it("renders a component into the DOM", () => {
    render(<EmptyState icon="calendar" title="No events yet" />);

    expect(screen.getByText("No events yet")).toBeInTheDocument();
  });
});

/* The compact variant (Phase 5).
 *
 * "Nothing needs review" was being delivered in a dashed panel with a
 * 44px ringed icon and an explanatory sentence — roughly an event card's
 * worth of height to report that there is no work. The compact form is
 * one line. These pin what it must NOT lose: the message itself, and the
 * fact that the icon stays decorative rather than becoming content. */

describe("the compact variant", () => {
  it("still renders the message", () => {
    render(
      <EmptyState icon="check" tone="positive" compact title="Nothing needs your attention" />,
    );

    expect(
      screen.getByText("Nothing needs your attention"),
    ).toBeInTheDocument();
  });

  /* Panels are the default: four other call sites rely on getting one
     without saying anything, so the variant must be opt-in. */
  it("is opt-in — the default stays a panel", () => {
    const { container } = render(
      <EmptyState icon="calendar" title="No events yet" />,
    );

    expect(container.querySelector(".empty-state")).not.toHaveClass(
      "empty-state--compact",
    );
  });

  it("applies the variant when asked, alongside the tone", () => {
    const { container } = render(
      <EmptyState icon="check" tone="positive" compact title="All clear" />,
    );

    const root = container.querySelector(".empty-state");

    expect(root).toHaveClass("empty-state--compact");
    expect(root).toHaveClass("empty-state--positive");
  });

  /* The state is carried by words, not by the glyph's colour alone. */
  it("keeps the icon decorative", () => {
    const { container } = render(
      <EmptyState icon="check" compact title="All clear" />,
    );

    expect(container.querySelector(".empty-state__icon")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
