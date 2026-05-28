/**
 * `@agentick/executor-openai` — OpenAI provider adapter for Agentick v2.
 *
 * Implements `LanguageModelExecutor` from `@agentick/spec` against the
 * OpenAI Chat Completions API. Companion to `@agentick/executor` (which
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
export {
  StreamTagParser,
  type StreamTagParserConfig,
  type StreamTagHandler,
  type StreamTagEvent,
} from "./stream-tag-parser.js";
