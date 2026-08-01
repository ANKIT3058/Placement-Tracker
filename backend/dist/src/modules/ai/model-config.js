// Describes which model to call and with what sampling parameters. Kept
// provider-agnostic: it names a model and a few common knobs rather than any
// OpenAI-specific option, so the same config can drive a future provider.
// The configuration the existing AI services use today: gpt-4o-mini at
// temperature 0. Exposed as the default so migrating callers get identical
// behaviour without repeating these literals, and new callers get a sane
// deterministic baseline.
export const DEFAULT_MODEL_CONFIG = {
    model: "gpt-4o-mini",
    temperature: 0,
};
//# sourceMappingURL=model-config.js.map