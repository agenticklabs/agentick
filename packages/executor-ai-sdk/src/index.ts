/**
 * `@agentick/executor-ai-sdk` — Vercel AI SDK bridge for Agentick v2.
 *
 * Wraps any `ai` package `LanguageModel` as a
 * `LanguageModelExecutor`. Lets users keep their existing AI SDK
 * provider setup (`@ai-sdk/openai`, `@ai-sdk/anthropic`,
 * `@ai-sdk/google`, ...) while gaining JSX agents, sessions, tool
 * harnesses, observability, and the rest of the v2 framework.
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

export {
  AISDKExecutor,
  type AISDKExecutorOptions,
} from "./ai-sdk-executor.js";
export { aisdk, type AISDKFactoryOptions } from "./aisdk-factory.js";
