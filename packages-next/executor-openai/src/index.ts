/**
 * `@agentick/executor-openai-next` — OpenAI provider adapter for Agentick v2.
 *
 * Implements `LanguageModelExecutor` from `@agentick/spec-next` against the
 * OpenAI Chat Completions API. Companion to `@agentick/executor-next` (which
 * ships the scripted mock and the base harness conventions).
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

export {
  OpenAIExecutor,
  type OpenAIExecutorOptions,
  type CustomBlockDefinition,
} from "./openai-executor.js";
export { openai, type OpenAIFactoryOptions } from "./openai-factory.js";
// StreamTagParser moved to @agentick/executor-next during the v2
// base-hook refactor — re-export here so adopters importing from
// @agentick/executor-openai-next keep working without a deep import.
export { StreamTagParser } from "@agentick/executor-next";
