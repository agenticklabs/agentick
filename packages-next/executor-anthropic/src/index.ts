/**
 * `@agentick/executor-anthropic-next` — Anthropic provider adapter for Agentick v2.
 *
 * Implements `LanguageModelExecutor` from `@agentick/spec-next` against the
 * Anthropic Messages API (`@anthropic-ai/sdk`).
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 * @see docs/proposals/v2/anthropic-adapter-plan.md
 */

export {
  AnthropicExecutor,
  type AnthropicExecutorOptions,
  type CustomBlockDefinition,
} from "./anthropic-executor.js";
export { anthropic, type AnthropicFactoryOptions } from "./anthropic-factory.js";
