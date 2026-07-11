import type { ModelConfig } from "./model-config.js";

// A single structured request to an AI provider. Deliberately minimal: a system
// prompt, a user prompt, and the model configuration. This is the exact shape
// every existing AI service builds today (two messages + model + temperature),
// so wrapping them behind this interface changes nothing about the request.
export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  model: ModelConfig;
}

// The contract every AI backend implements. It returns the model's raw text
// content and knows nothing about JSON, code fences, or retries — those concerns
// live in the parser and retry policy. Swapping providers (or mocking one in a
// test) means implementing this single method; nothing above it changes.
export interface AIProvider {
  // Send one completion request and return the raw text content of the reply.
  // Implementations MUST throw `EmptyResponseError` when the provider returns no
  // content, and wrap transport/provider faults in `ProviderError` (marking
  // transient ones retryable) so callers get a uniform, typed failure surface.
  complete(request: CompletionRequest): Promise<string>;
}
