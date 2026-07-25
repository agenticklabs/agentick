/**
 * `@agentick/model-ai-sdk` — Vercel AI SDK bridge for Agentick v2.
 *
 * Ships `aisdk(model, options?)`, wrapping any `ai` package
 * `LanguageModel` as a `LanguageModelAdapter` (ADR 52) consumed by the
 * ONE `LanguageModelExecutor`. Lets users keep their existing AI SDK
 * provider setup (`@ai-sdk/openai`, `@ai-sdk/anthropic`,
 * `@ai-sdk/google`, ...) while gaining JSX agents, sessions, tool
 * harnesses, observability, and the rest of the v2 framework.
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 */

export { aisdk, type AISDKAdapterOptions } from "./ai-sdk-adapter.js";
