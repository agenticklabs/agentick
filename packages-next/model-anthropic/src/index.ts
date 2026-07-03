/**
 * `@agentick/model-anthropic-next` — Anthropic `LanguageModelAdapter`
 * for Agentick v2 (ADR 52).
 *
 * Ships `anthropic(model?, options?)`, a factory producing the
 * provider-normalization part consumed by the ONE
 * `LanguageModelExecutor` in `@agentick/executor-next`, against the
 * Anthropic Messages API (`@anthropic-ai/sdk`).
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 * @see docs/proposals/v2/anthropic-adapter-plan.md
 */

export {
  anthropic,
  type AnthropicAdapterOptions,
  type CustomBlockDefinition,
} from "./anthropic-adapter.js";
