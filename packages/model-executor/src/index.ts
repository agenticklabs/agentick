/**
 * `@agentick/model-executor` — THE executor harness (ADR 52).
 *
 * Ships the ONE `LanguageModelExecutor` — `BaseHarness<"model">`
 * plus the entire Effect execution engine — consuming a
 * `LanguageModelAdapter` part from `@agentick/model`. Also ships
 * `FakeLanguageModelExecutor` (scripted, no wire) for tests, examples,
 * and the v2 substrate proof.
 *
 * The model layer (adapter contract, accumulator, transforms,
 * projection, generate helpers) lives in `@agentick/model` —
 * zero Effect, standalone-usable. Provider adapters
 * (`@agentick/model-openai`, …) implement that contract and never
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
// ADR 105 — the image-model + embedding-model families. The augment import is
// a side effect: it types `ctx.images` / `ctx.embeddings` on ToolHandlerCtx.
import "./augment.js";
export {
  ImageModelExecutor,
  EmbeddingModelExecutor,
  type ImageModelExecutorOptions,
  type EmbeddingModelExecutorOptions,
} from "./modality-executor.js";
