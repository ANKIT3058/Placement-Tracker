/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  // Component tests run against the same config as the build — same React
  // plugin, same resolution — so a test can never pass under a transform the
  // application does not use. There are no path aliases to mirror.
  test: {
    // jsdom, because these are DOM component tests. Node is the Vitest default
    // and would fail at `document`.
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Worker threads rather than Vitest's default child-process "forks" pool.
    // A forked worker never completes its handshake in this environment and the
    // run dies with "Timeout waiting for worker to respond"; threads start
    // cleanly. The backend documents the same class of worker-process problem
    // in jest.config.js, which pins maxWorkers to 1 for it.
    pool: "threads",
  },
});
