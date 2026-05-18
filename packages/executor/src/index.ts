/**
 * `@agentick/executor` — reference executor harness.
 *
 * Implements `ExecutorProtocol` / `LanguageModelExecutor` from
 * `@agentick/spec`. Ships `MockLanguageModelExecutor` (scripted, no
 * wire) for tests, examples, and the v2 substrate proof. Real
 * provider adapters (OpenAI, Anthropic, Google, AI SDK) live in
 * separate packages — Phase 4c.
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

export {
  MockLanguageModelExecutor,
  type MockLanguageModelExecutorOptions,
  type MockScriptedRun,
} from "./mock-language-model-executor.js";
