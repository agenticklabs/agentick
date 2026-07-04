/**
 * `@agentick/model-next` — the model layer (ADR 52). Zero Effect, zero
 * substrate.
 *
 * Owns the currencies and machinery between provider SDKs and the
 * executor harness:
 *
 *   - `LanguageModelAdapter` — the provider-normalization contract.
 *     Providers (`@agentick/model-openai-next`, `-anthropic`, `-google`,
 *     `-ai-sdk`) implement it; `LanguageModelExecutor` (in
 *     `@agentick/executor-next`) consumes it.
 *   - `StreamAccumulator` + `StreamAccumulatorView` — the canonical
 *     delta fold.
 *   - `DeltaTransform` pipeline + tag routing (`thinkTagTransform`,
 *     `customBlockTransform`, `StreamTagParser`).
 *   - Canonical projection (`defaultProject` + the composable parts).
 *   - `generate()` / `generateStream()` — standalone single-shot
 *     helpers driving an adapter directly, no harness required.
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 */

export {
  defaultFinalizeStream,
  isLanguageModelAdapter,
  type LanguageModelAdapter,
  type StreamAccumulatorView,
} from "./language-model-adapter.js";
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
export {
  defaultProject,
  buildTools,
  buildMessages,
  buildParameters,
  collectSectionText,
  sectionText,
  messagePartFromBlock,
  imageUrlFromSource,
} from "./canonical-projection.js";
export { generate, generateStream, type GenerateOptions } from "./generate.js";
export {
  withRetry,
  withFallback,
  tapModel,
  isTransientProviderError,
  type RetryOptions,
  type ModelTap,
} from "./combinators.js";
export {
  generateObject,
  GenerateObjectError,
  type GenerateObjectOptions,
  type GenerateObjectResult,
} from "./generate-object.js";
export {
  estimateCost,
  mergePricing,
  mergeUsageStats,
  resolvePricing,
  SEED_PRICING,
  type CostEstimate,
  type ModelPricing,
  type PricingTable,
} from "./pricing.js";
