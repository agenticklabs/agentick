/**
 * `@agentick/model-google-next` — Google (Gemini)
 * `LanguageModelAdapter` for Agentick v2 (ADR 52).
 *
 * Ships `google(model?, options?)`, a factory producing the
 * provider-normalization part consumed by the ONE
 * `LanguageModelExecutor` in `@agentick/executor-next`. Supports both
 * the Gemini Developer API (apiKey) and Vertex AI
 * (project/location/auth) paths.
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 * @see docs/proposals/v2/V1-PARITY-TRACKER.md
 */

export {
  google,
  type GoogleAdapterOptions,
  type CustomBlockDefinition,
  sanitizeSchemaForGemini,
} from "./google-adapter.js";
