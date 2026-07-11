// Public surface of the AI Core. This module centralizes the request/parse/retry
// logic that the AI-powered services (email extraction, document
// classification, event/participant extraction) each duplicate today:
// constructing an OpenAI request, stripping markdown code fences, parsing JSON,
// and handling malformed responses.
//
// The one function most callers need is `structuredCompletion<T>()`. The rest of
// the exports (provider, parser, retry policy, errors, config) are the seams it
// is built from — exposed so services can inject fakes in tests or compose their
// own variant. Introducing this module changes NO existing behaviour: the
// current services are untouched and continue to work exactly as before. See the
// migration note at the bottom for how they can adopt it incrementally.

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
