/**
 * The JSON-clean half of a model's reference data — what a client can be told
 * about a model.
 *
 * `@agentick/model` owns the CATALOG (`SEED_MODELS`, the resolvers, the
 * precedence fold). This module owns only the shape that crosses the wire, and
 * `ModelInfo` extends it rather than restating it — so a field added here
 * reaches both without a second definition to keep in step.
 *
 * The split exists because `ModelInfo` carries a `tokenEstimator` FUNCTION, and
 * a function cannot be serialized. Everything else about a model is plain data
 * and a client has real uses for it: the denominator of a context-window
 * gauge, a cost readout, gating a UI affordance on `supportsVision` instead of
 * hardcoding which models take attachments.
 *
 * Resolution stays server-side. An adopter's `models` registry is merged over
 * the seed in the app, so a client resolving from the seed alone would compute
 * a different answer than the server actually used — two sources of truth for
 * one number. The client asks; it does not derive.
 */

import type { TargetCapabilities } from "./execution-target.js";

/** USD per MILLION tokens (industry convention). */
export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  /** Prompt-cache READ rate. Default: `inputPerMTok` (no discount). */
  readonly cachedInputPerMTok?: number;
  /** Prompt-cache WRITE rate. Default: `inputPerMTok` (no surcharge). */
  readonly cacheWritePerMTok?: number;
}

/**
 * Serializable per-model reference data. Every field is optional — the catalog
 * is best-effort, and a partial row (priced but unsized, or the reverse) is
 * legitimate. Absent means UNKNOWN, never zero.
 */
export interface ModelFacts {
  readonly pricing?: ModelPricing;
  /** Total context window in tokens. */
  readonly contextWindow?: number;
  /** Max output tokens (when narrower than the window). */
  readonly maxOutputTokens?: number;
  readonly capabilities?: TargetCapabilities;
}
