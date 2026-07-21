/**
 * `@agentick/model-executor-next` — THE executor harness (ADR 52).
 *
 * Ships the ONE `LanguageModelExecutor` — `BaseHarness<"model">`
 * plus the entire Effect execution engine — consuming a
 * `LanguageModelAdapter` part from `@agentick/model-next`. Also ships
 * `FakeLanguageModelExecutor` (scripted, no wire) for tests, examples,
 * and the v2 substrate proof.
 *
 * The model layer (adapter contract, accumulator, transforms,
 * projection, generate helpers) lives in `@agentick/model-next` —
 * zero Effect, standalone-usable. Provider adapters
 * (`@agentick/model-openai-next`, …) implement that contract and never
 * depend on this package.
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 */

export {
  FakeLanguageModelExecutor,
  type FakeLanguageModelExecutorOptions,
  type MockScriptedRun,
} from "./fake-language-model-executor.js";
export {
  LanguageModelExecutor,
  type LanguageModelExecutorOptions,
  mergeSignals,
} from "./language-model-executor.js";
export { ExecutorLifecycle, type ExecutorInFlightEntry } from "./executor-lifecycle.js";
