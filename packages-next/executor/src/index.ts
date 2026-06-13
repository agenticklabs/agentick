/**
 * `@agentick/executor-next` — reference executor harness.
 *
 * Implements `ExecutorProtocol` / `LanguageModelExecutor` from
 * `@agentick/spec-next`. Ships `FakeLanguageModelExecutor` (scripted, no
 * wire) for tests, examples, and the v2 substrate proof. Real
 * provider adapters (OpenAI, Anthropic, Google, AI SDK) live in
 * separate packages — Phase 4c.
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

export {
  FakeLanguageModelExecutor,
  type FakeLanguageModelExecutorOptions,
  type MockScriptedRun,
} from "./fake-language-model-executor.js";
export { defineExecutor, type DefineExecutorInput } from "./define-executor.js";
export {
  defineLanguageModelExecutor,
  type DefineLanguageModelExecutorInput,
} from "./define-language-model-executor.js";

// Abstract base for first-party provider executors. Concrete impls
// (OpenAI, Anthropic, Google, AI SDK) subclass and implement the
// provider-specific hooks. Adopters writing one-off integrations
// should use `defineExecutor` (callback-style) instead.
export {
  BaseLanguageModelExecutor,
  defaultProject,
  mergeSignals,
} from "./base-language-model-executor.js";
export { StreamAccumulator, type AccumToolCall } from "./stream-accumulator.js";
export { type DeltaTransform, composeTransforms, identityTransform } from "./delta-transform.js";
export {
  thinkTagTransform,
  customBlockTransform,
  type CustomBlockDefinition,
} from "./tag-transforms.js";
export {
  StreamTagParser,
  type StreamTagHandler,
  type StreamTagParserConfig,
  type StreamTagEvent,
} from "./stream-tag-parser.js";
export { ExecutorLifecycle, type ExecutorInFlightEntry } from "./executor-lifecycle.js";
