import {
  EmptyResponseError,
  MalformedResponseError,
  ProviderError,
} from "./ai-errors.js";

export interface RetryPolicyOptions {
  // Total attempts, including the first. `1` disables retrying. Default 3.
  maxAttempts?: number;

  // Base delay between attempts in ms; each attempt waits `delayMs * attempt`
  // (linear backoff). Default 250ms. Set 0 to retry immediately.
  delayMs?: number;

  // Decides whether a thrown error is worth retrying. Defaults to
  // `isTransientError` below: malformed JSON, empty responses, and provider
  // errors flagged retryable. Anything else fails fast.
  isRetryable?: (error: unknown) => boolean;
}

// The errors a re-request might plausibly fix: a model that returned prose
// instead of JSON, an empty reply, or a transient provider fault (rate limit,
// 5xx, timeout, network). Permanent faults (bad request, auth) are not retried.
export const isTransientError = (error: unknown): boolean =>
  error instanceof MalformedResponseError ||
  error instanceof EmptyResponseError ||
  (error instanceof ProviderError && error.retryable);

// A small, dependency-free retry helper for AI calls. It re-runs an operation
// up to `maxAttempts` times while the error looks transient, with linear
// backoff between attempts, and re-throws the last error once attempts are
// exhausted or the error is non-retryable. Intentionally simple — this is not a
// general resilience framework, just enough to smooth over the occasional
// malformed response or rate limit.
export class RetryPolicy {
  private readonly maxAttempts: number;
  private readonly delayMs: number;
  private readonly isRetryable: (error: unknown) => boolean;

  constructor(options: RetryPolicyOptions = {}) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.delayMs = Math.max(0, options.delayMs ?? 250);
    this.isRetryable = options.isRetryable ?? isTransientError;
  }

  // Run `operation`, retrying on retryable errors. Resolves with its result or
  // rejects with the error from the final attempt.
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        const hasAttemptsLeft = attempt < this.maxAttempts;
        if (!hasAttemptsLeft || !this.isRetryable(error)) {
          throw error;
        }

        if (this.delayMs > 0) {
          await this.wait(this.delayMs * attempt);
        }
      }
    }

    // Unreachable: the loop always returns or throws. Present so TypeScript sees
    // a definite exit and to be defensive if maxAttempts were ever mis-set.
    throw lastError;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Default policy shared by `structuredCompletion` callers that don't supply
// their own: 3 attempts, 250ms linear backoff, transient-only retrying.
export const defaultRetryPolicy = new RetryPolicy();
