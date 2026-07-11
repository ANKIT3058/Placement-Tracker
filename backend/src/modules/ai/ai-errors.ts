// The typed error hierarchy for the AI Core. Callers can catch `AIError` to
// handle any AI failure, or narrow to a specific subclass to distinguish an
// empty response from malformed JSON from a provider fault. Every error thrown
// out of `structuredCompletion` is one of these types.

// Base class for every failure originating in the AI Core. Never thrown
// directly — always one of the subclasses below.
export class AIError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    // Preserve the underlying error (e.g. the OpenAI SDK error or JSON parse
    // error) without losing our own message. `cause` is standard on Error but
    // we set it explicitly so it survives targets that don't pass options up.
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

// The provider returned a response with no usable text content. Retryable: a
// re-request may yield content. Mirrors the previous "Empty response from
// OpenAI" throw in the existing services.
export class EmptyResponseError extends AIError {
  constructor(message = "Empty response from AI provider", options?: { cause?: unknown }) {
    super(message, options);
  }
}

// The provider returned text that could not be parsed as JSON (after stripping
// markdown code fences). Retryable: the model may return valid JSON next time.
// Mirrors the previous "Invalid JSON from OpenAI" throw. Carries the raw text
// so callers can log what actually came back.
export class MalformedResponseError extends AIError {
  constructor(
    message: string,
    public readonly rawResponse: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

// The provider call itself failed (network error, rate limit, 5xx, timeout).
// `retryable` distinguishes transient faults (rate limits, server errors) from
// permanent ones (bad request, auth) so the RetryPolicy knows whether another
// attempt is worthwhile.
export class ProviderError extends AIError {
  constructor(
    message: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
