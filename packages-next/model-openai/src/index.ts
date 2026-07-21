/**
 * `@agentick/model-openai-next` — OpenAI `LanguageModelAdapter` for
 * Agentick v2 (ADR 52).
 *
 * Ships `openai(model?, options?)`, a factory producing the
 * provider-normalization part consumed by the ONE
 * `LanguageModelExecutor` in `@agentick/model-executor-next`. Zero Effect,
 * zero substrate — Promise/AsyncIterable-shaped against the OpenAI
 * Chat Completions API.
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 */

export { openai, type OpenAIAdapterOptions, type CustomBlockDefinition } from "./openai-adapter.js";
// StreamTagParser lives in @agentick/model-next — re-export here so
// adopters importing from this package keep working without a deep
// import.
export { StreamTagParser } from "@agentick/model-next";
