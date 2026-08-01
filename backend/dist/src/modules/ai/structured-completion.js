import { DEFAULT_MODEL_CONFIG } from "./model-config.js";
import { jsonResponseParser } from "./json-response-parser.js";
import { defaultRetryPolicy } from "./retry-policy.js";
import { openAIProvider } from "./openai-provider.js";
// The one entry point every AI service should call. It performs the full
// request/parse cycle that each service currently duplicates:
//
//   1. Send the system + user prompts to the provider with the given model.
//   2. Receive the raw text reply.
//   3. Strip markdown code fences.
//   4. Parse it as JSON.
//   5. Return it typed as T.
//
// Transient failures (malformed JSON, empty reply, rate limits, 5xx) are
// retried by the RetryPolicy. Unrecoverable failures surface as typed AIErrors
// (EmptyResponseError / MalformedResponseError / ProviderError) — callers catch
// AIError (or a subclass) instead of matching on error message strings.
//
// The T parameter is an assertion about the JSON shape, not a runtime schema
// check: callers that need field validation still normalize the returned
// object (exactly as the current services do in their `normalizeResult`).
export async function structuredCompletion(params) {
    const { systemPrompt, userPrompt, model = DEFAULT_MODEL_CONFIG, provider = openAIProvider, parser = jsonResponseParser, retryPolicy = defaultRetryPolicy, } = params;
    return retryPolicy.execute(async () => {
        const raw = await provider.complete({ systemPrompt, userPrompt, model });
        return parser.parse(raw);
    });
}
//# sourceMappingURL=structured-completion.js.map