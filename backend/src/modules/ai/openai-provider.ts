import { APIError } from "openai";
import { getOpenAIClient } from "./openai-client.js";
import type { AIProvider, CompletionRequest } from "./ai-provider.interface.js";
import { EmptyResponseError, ProviderError } from "./ai-errors.js";

// Concrete AIProvider backed by OpenAI's Chat Completions API. It wraps the
// SAME memoized client the existing services use (getOpenAIClient), so API-key
// handling and the shared instance stay in exactly one place — this is a new
// facade over the current client, not a second one.
//
// Its only jobs are: build the two-message request the services already send,
// return the raw text, and translate OpenAI's error surface into the AI Core's
// typed errors so nothing above it depends on the OpenAI SDK.
export class OpenAIProvider implements AIProvider {
  async complete(request: CompletionRequest): Promise<string> {
    const openai = getOpenAIClient();

    let response;
    try {
      response = await openai.chat.completions.create({
        model: request.model.model,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt },
        ],
        temperature: request.model.temperature,
        max_tokens: request.model.maxTokens,
      });
    } catch (error) {
      // Wrap every transport/provider fault as a ProviderError, flagging the
      // transient ones so the RetryPolicy can decide whether to retry.
      throw new ProviderError(this.describeError(error), this.isRetryable(error), {
        cause: error,
      });
    }

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      throw new EmptyResponseError();
    }

    return content;
  }

  // A fault is worth retrying when it's a network/timeout error (APIError with
  // no HTTP status) or a transient HTTP status: 408 (timeout), 429 (rate limit),
  // or any 5xx. Everything else — 400/401/403/404/422 — is a permanent client
  // error that another identical request won't fix.
  private isRetryable(error: unknown): boolean {
    if (!(error instanceof APIError)) {
      // Non-API errors (unexpected/programming faults) are not retried.
      return false;
    }
    const status = error.status;
    if (status === undefined) return true; // connection / timeout
    return status === 408 || status === 429 || status >= 500;
  }

  private describeError(error: unknown): string {
    if (error instanceof APIError) {
      const status = error.status ?? "network";
      return `OpenAI request failed (${status}): ${error.message}`;
    }
    return error instanceof Error ? error.message : "Unknown provider error";
  }
}

// Shared default provider. `structuredCompletion` uses this unless a caller
// injects its own (e.g. a fake in tests).
export const openAIProvider = new OpenAIProvider();
