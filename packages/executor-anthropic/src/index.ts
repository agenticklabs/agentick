/**
 * `@agentick/executor-anthropic` — Anthropic provider adapter for Agentick v2.
 *
 * Implements `LanguageModelExecutor` from `@agentick/spec` against the
 * Anthropic Messages API (`@anthropic-ai/sdk`). Companion to
 * `@agentick/executor` (which ships the scripted mock and the base
 * harness conventions) and to `@agentick/executor-openai` /
 * `@agentick/executor-ai-sdk`.
 *
 * **Status:** scaffolded — implementation forthcoming. See
 * `docs/proposals/v2/anthropic-adapter-plan.md`.
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

export type { AnthropicExecutorOptions } from "./anthropic-executor.js";
export type { AnthropicFactoryOptions } from "./anthropic-factory.js";
