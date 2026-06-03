/**
 * `@agentick/executor-google` — Google (Gemini) provider adapter for Agentick v2.
 *
 * Implements `LanguageModelExecutor` from `@agentick/spec` against the
 * `@google/genai` SDK. Supports both the Gemini Developer API (apiKey)
 * and Vertex AI (project/location/auth) paths.
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 * @see docs/proposals/v2/V1-PARITY-TRACKER.md
 */

export {
  GoogleExecutor,
  type GoogleExecutorOptions,
  type CustomBlockDefinition,
  sanitizeSchemaForGemini,
} from "./google-executor.js";
export {
  google,
  type GoogleFactoryOptions,
} from "./google-factory.js";
