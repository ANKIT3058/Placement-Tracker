/** @type {import("jest").Config} */
module.exports = {
  testEnvironment: "node",
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