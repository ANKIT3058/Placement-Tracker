import OpenAI from "openai";

// The single shared OpenAI client, and the one place the API key is read.
//
// WHY IT LIVES HERE.
//
// This function was defined in extraction.service, and `ai/openai-provider`
// imported it from there — which closed a cycle:
//
//   ai/index -> structured-completion -> openai-provider
//            -> extraction.service -> ai/index
//
// Under ESM that cycle resolves cleanly (bindings are linked before any module
// is evaluated), which is why it never affected production. Under the CommonJS
// output ts-jest produces it does not: `exports` is populated top-down, so
// extraction.service re-entered a half-initialised `ai/index` and read
// `RetryPolicy` as undefined at module scope. Any test that imported the real
// chain failed to load.
//
// Moving the client to a LEAF module removes the edge entirely. Nothing under
// `ai/` reaches back into `extraction/` now, so the cycle cannot re-form
// whichever module is entered first.
//
// `extraction.service` re-exports this symbol, so every existing consumer —
// the document-intelligence extractors, and the tests that mock that module —
// keeps importing it from exactly where it did before.
//
// Behaviour is unchanged from the original: lazy, memoised, and it throws when
// the key is absent rather than constructing a client that cannot work.
let client: OpenAI | null = null;

// Lazily construct and memoize the single shared OpenAI client. Exported so
// other AI features (e.g. the DocumentClassifier) reuse the exact same provider
// instance and API-key handling instead of standing up a second client.
export const getOpenAIClient = () => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }

  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return client;
};
