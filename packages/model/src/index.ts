/**
 * `@agentick/model` — the model layer (ADR 52). Zero Effect, zero
 * substrate.
 *
 * Owns the currencies and machinery between provider SDKs and the
 * executor harness:
 *
 *   - `LanguageModelAdapter` — the provider-normalization contract.
 *     Providers (`@agentick/model-openai`, `-anthropic`, `-google`,
 *     `-ai-sdk`) implement it; `LanguageModelExecutor` (in
 *     `@agentick/model-executor`) consumes it.
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
  defineLanguageModelAdapter,
  isLanguageModelAdapter,
  type LanguageModelAdapter,
  type LanguageModelAdapterDefinition,
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
  buildProviderTools,
  buildMessages,
  buildParameters,
  canonicalRole,
  lowerSemanticRole,
  messagePartFromBlock,
  UnknownMessageRoleError,
} from "./canonical-projection.js";
export { generate, generateStream, type GenerateOptions } from "./generate.js";
export { createSourceInterner, type SourceInterner } from "./source-interner.js";
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
  type PricingTable,
} from "./pricing.js";
export {
  contextUtilization,
  effectiveModelInfo,
  estimateTokens,
  mergeRegistry,
  resolveModelInfo,
  SEED_MODELS,
  type ModelInfo,
  type ModelPricing,
  type ModelRegistry,
} from "./model-info.js";

// Only `buildMessageProvenance` — the walk a user cannot re-derive without duplicating
// `buildMessages` and keeping the two in lockstep forever.
//
// `originOf` (an index), `originsWhere` (a filter plus a dedupe) and `dropOrigins` (a
// removal) were exported and are not: each is a few lines over a data structure the caller
// now holds, and none needs anything only the framework has. `dropOrigins` was the
// incoherent one — it existed to feed a minimizing search that is deliberately userland,
// so keeping the helper while removing the search was having it both ways.
//
// What DOESN'T survive the cut is the knowledge, so it moved into `MessageProvenance`'s
// docs: the trap a hand-written `originsWhere` walks into is deduplicating by a
// `(entryId, blockIndex)` value key, which collides across id-less entries.
export { buildMessageProvenance, type MessageProvenance, type PartOrigin } from "./provenance.js";
// `./ddmin.js` is NOT exported, and the criterion is worth stating because it applies to
// everything else in this file: **does this require knowledge or access only the framework
// has?**
//
// `applyMediaSupport` needs the target's declaration and a place in the request pipeline
// nothing can bypass. `detectDroppedInputs` needs `prepareRequest`, an adapter internal.
// `buildMessageProvenance` needs the projection walk. Each is ours because nobody else can
// write it.
//
// `ddmin` takes an array and a predicate. No tree, no target, no adapter, no privileged
// access to anything — so it is userland, however correct and however useful. Shipping it
// on the framework's surface would be shipping a general algorithm as a framework feature
// and owing it compatibility forever. The file stays (it is tested, and its tests document
// the reasoning) so a first real consumer can promote it deliberately.
// TODO(ddmin-home): export from a utility surface, or drop, on the first real caller.
export { applyMediaSupport, type MediaSupportResult, type PartDeclined } from "./media-support.js";
export {
  detectDroppedInputs,
  type DroppedInputs,
  type DroppedPart,
  type ProjectingAdapter,
} from "./dropped-inputs.js";
