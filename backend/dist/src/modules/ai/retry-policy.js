import { EmptyResponseError, MalformedResponseError, ProviderError, } from "./ai-errors.js";
// The errors a re-request might plausibly fix: a model that returned prose
// instead of JSON, an empty reply, or a transient provider fault (rate limit,
// 5xx, timeout, network). Permanent faults (bad request, auth) are not retried.
export const isTransientError = (error) => error instanceof MalformedResponseError ||
    error instanceof EmptyResponseError ||
    (error instanceof ProviderError && error.retryable);
// A small, dependency-free retry helper for AI calls. It re-runs an operation
// up to `maxAttempts` times while the error looks transient, with linear
// backoff between attempts, and re-throws the last error once attempts are
// exhausted or the error is non-retryable. Intentionally simple — this is not a
// general resilience framework, just enough to smooth over the occasional
// malformed response or rate limit.
export class RetryPolicy {
    maxAttempts;
    delayMs;
    isRetryable;
    constructor(options = {}) {
        this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
        this.delayMs = Math.max(0, options.delayMs ?? 250);
        this.isRetryable = options.isRetryable ?? isTransientError;
    }
    // Run `operation`, retrying on retryable errors. Resolves with its result or
    // rejects with the error from the final attempt.
    async execute(operation) {
        let lastError;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            try {
                return await operation();
            }
            catch (error) {
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
    wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
// Default policy shared by `structuredCompletion` callers that don't supply
// their own: 3 attempts, 250ms linear backoff, transient-only retrying.
export const defaultRetryPolicy = new RetryPolicy();
//# sourceMappingURL=retry-policy.js.map