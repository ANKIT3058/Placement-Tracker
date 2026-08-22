/* Vitest setup, loaded once per test file (see `test.setupFiles` in
   vite.config.ts).

   Two things happen here, both consequences of running Vitest WITHOUT
   `globals: true`. Explicit imports match how the rest of this codebase is
   written — `verbatimModuleSyntax` is on and nothing relies on ambient
   globals — so the test APIs are imported per file rather than injected.

   1. jest-dom matchers. The `/vitest` entry point registers them on Vitest's
      `expect` and carries the type augmentation, so `toBeInTheDocument()` is
      available and typed in every test file.

   2. Explicit cleanup. React Testing Library auto-registers `afterEach(cleanup)`
      only when a global `afterEach` exists, which it does not here. Without
      this, mounted trees would leak between tests in the same file and queries
      would match nodes left over from an earlier render. */

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
