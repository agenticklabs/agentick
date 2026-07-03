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
// The provider-normalization part (ADR 52) — Promise-shaped, zero
// Effect, standalone-usable. Providers implement this; the ONE
// LanguageModelExecutor consumes it.
export {
  isLanguageModelAdapter,
  type LanguageModelAdapter,
  type StreamAccumulatorView,
} from "./language-model-adapter.js";
// THE reference executor (ADR 52) — one final class consuming a
// LanguageModelAdapter part. The old subclass tier
// (BaseLanguageModelExecutor) and the define* callback factories are
// gone: providers implement LanguageModelAdapter instead.
export {
  LanguageModelExecutor,
  type LanguageModelExecutorOptions,
  defaultProject,
  mergeSignals,
} from "./language-model-executor.js";
// Canonical projection helpers — provider adapters that share the
// canonical fold (Anthropic/OpenAI/Google/AI SDK) reach for these
// instead of re-rolling. Adopters writing custom adapters extend
// `BaseLanguageModelExecutor.projectImpl` and compose with the parts
// they need.
export {
  buildTools,
  buildMessages,
  buildParameters,
  collectSectionText,
  sectionText,
  messagePartFromBlock,
  imageUrlFromSource,
} from "./canonical-projection.js";
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
