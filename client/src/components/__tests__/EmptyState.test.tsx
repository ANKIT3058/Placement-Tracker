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
