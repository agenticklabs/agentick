/**
 * `@agentick/executor-openai-next` — OpenAI `LanguageModelAdapter` for
 * Agentick v2 (ADR 52).
 *
 * Ships `openai(model?, options?)`, a factory producing the
 * provider-normalization part consumed by the ONE
 * `LanguageModelExecutor` in `@agentick/executor-next`. Zero Effect,
 * zero substrate — Promise/AsyncIterable-shaped against the OpenAI
 * Chat Completions API.
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 */

export { openai, type OpenAIAdapterOptions, type CustomBlockDefinition } from "./openai-adapter.js";
// StreamTagParser moved to @agentick/executor-next during the v2
// base-hook refactor — re-export here so adopters importing from
// @agentick/executor-openai-next keep working without a deep import.
export { StreamTagParser } from "@agentick/executor-next";
