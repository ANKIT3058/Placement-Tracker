/** @type {import("jest").Config} */
module.exports = {
  testEnvironment: "node",
  // The suite is leak-free (verified: `jest --detectOpenHandles` reports no open
  // handles). In multi-worker mode ts-jest occasionally fails to tear a worker
  // process down within Jest's grace window, emitting a flaky "worker process
  // failed to exit" warning that is NOT a real resource leak. Running in-band
  // removes the worker entirely so the warning cannot occur, while keeping
  // `--detectOpenHandles` meaningful for catching genuine leaks later.
  maxWorkers: 1,
  // Only treat files under a `__tests__` directory named `*.test.ts` as tests.
  // Jest's default testMatch also picks up any file literally named `test.ts`
  // (e.g. the manual Redis smoke-script src/infrastructure/redis/test.ts) plus
  // their compiled copies under dist/. Scoping to src/ + __tests__ excludes both.
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  // Production sources use ESM-style imports with explicit ".js" extensions
  // (e.g. "../event/event.repository.js"), which are correct for the NodeNext
  // runtime. ts-jest emits CommonJS for the test run and cannot resolve those
  // extensions, so strip the trailing ".js" on relative imports at resolution.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    // ts-jest must override the project tsconfig because tsconfig.json targets
    // "module": "ESNext" + "moduleResolution": "bundler" (correct for the app
    // runtime) but Jest runs in a CommonJS environment and cannot handle ESM
    // module syntax at the transform stage.
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          module: "commonjs",
          moduleResolution: "node",
          verbatimModuleSyntax: false, // ESM-only flag; must be off for CJS output
          types: ["node", "jest"],     // jest globals needed in test files
        },
      },
    ],
  },
};