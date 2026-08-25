// Public surface of the AI Core: one place for constructing an OpenAI request,
// stripping markdown code fences, parsing JSON, and handling malformed
// responses. Email extraction and document classification go through it; the
// event and participant extractors still call the provider directly and have
// not been migrated.
//
// The one function most callers need is `structuredCompletion<T>()`. The rest of
// the exports (provider, parser, retry policy, errors, config) are the seams it
// is built from — exposed so services can inject fakes in tests or compose their
// own variant.
//
// NOTHING UNDER `ai/` MAY IMPORT A MODULE THAT IMPORTS `ai/`. `getOpenAIClient`
// lives in the leaf `openai-client` for exactly this reason: it previously sat
// in `extraction.service`, which closed a cycle through this barrel. That cycle
// is harmless under production ESM and breaks the CommonJS output ts-jest
// produces, so re-forming it fails only in tests — often in an unrelated suite.

export { structuredCompletion } from "./structured-completion.js";
export type { StructuredCompletionParams } from "./structured-completion.js";

export type { AIProvider, CompletionRequest } from "./ai-provider.interface.js";
export { OpenAIProvider, openAIProvider } from "./openai-provider.js";

export {
  JsonResponseParser,
  jsonResponseParser,
} from "./json-response-parser.js";

export {
  RetryPolicy,
  defaultRetryPolicy,
  isTransientError,
} from "./retry-policy.js";
export type { RetryPolicyOptions } from "./retry-policy.js";

export type { ModelConfig } from "./model-config.js";
export { DEFAULT_MODEL_CONFIG } from "./model-config.js";

export {
  AIError,
  EmptyResponseError,
  MalformedResponseError,
  ProviderError,
} from "./ai-errors.js";
