/**
 * ModelInfo registry (#204) — ONE per-model reference table folding
 * pricing, context window, output cap, capabilities, and a token
 * estimator. Keyed `"<provider>/<modelId-prefix>"` — one flat key space,
 * the ecosystem's convention (OpenRouter, LiteLLM): the pricing
 * spine (`SEED_PRICING`, `resolvePricing`, `estimateCost`) is now a thin
 * projection over `SEED_MODELS` in `./pricing.ts`, so there is a single
 * source of numbers.
 *
 * Precedence for `effectiveModelInfo` (RATIFIED, extended to every
 * field): adopter registry > target self-description (`pricing`,
 * `capabilities`) > seed. The adapter is the authority on its own model
 * (#186); adopters override anything via the runtime `models` registry.
 *
 * Seed numbers are APPROXIMATE convenience defaults migrated from v1's
 * `packages/shared/src/model-catalog.ts` — providers change prices and
 * limits; override via the `registry` parameter for anything
 * cost/limit-sensitive.
 *
 * // TODO(trail-model-discovery): provider `/v1/models` discovery folded
 * // into a runtime registry layer (v1 `registerModel` analog).
 * // TODO(trail-seed-breadth): seed only the priced + headline models;
 * // widen toward v1's ~85-model catalog as consumers need them.
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 * @see packages/shared/src/model-catalog.ts (v1 prior art)
 */

import type { ExecutionTarget, LanguageModelInput, TargetCapabilities } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

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
 * Per-model reference data. Every field is optional — the registry is a
 * best-effort catalog, and a partial row (pricing only, or window only)
 * is legitimate.
 */
export interface ModelInfo {
  /** USD/MTok rates. Projected to `SEED_PRICING` by `./pricing.ts`. */
  readonly pricing?: ModelPricing;
  /** Total context window in tokens. */
  readonly contextWindow?: number;
  /** Max output tokens (when narrower than the window). */
  readonly maxOutputTokens?: number;
  /** Advertised capabilities (vision / tools / reasoning / streaming / json-schema). */
  readonly capabilities?: TargetCapabilities;
  /**
   * Token counter for the model. Defaults to a char/4 heuristic
   * (`estimateTokens`); adapters/adopters inject a real tokenizer
   * (tiktoken, etc.) here rather than dragging the dep into this layer
   * (#175).
   */
  readonly tokenEstimator?: (input: LanguageModelInput | string) => number;
}

/**
 * `"<provider>/<modelId-prefix>"` → info. Longest-prefix match on the whole
 * key, so `"openai/gpt-4o"` covers `gpt-4o-2024-11-20` while
 * `"openai/gpt-4o-mini"` wins for minis, and the provider segment keeps one
 * vendor's prefixes from ever reaching another's.
 *
 * The provider segment is the SERVING provider — who bills you — not the wire
 * dialect and not the adapter. Bedrock and Vertex re-serve other authors'
 * models at their own rates, so each is its own row; and one adapter
 * (`model-ai-sdk`) serves several providers, so keying by adapter would
 * collapse rate cards that have to stay apart.
 */
export type ModelRegistry = Readonly<Record<string, ModelInfo>>;

/** Capabilities shared by the seeded vision+tools chat models. */
const VISION_TOOLS: TargetCapabilities = {
  supportsTools: true,
  supportsVision: true,
  supportsStreaming: true,
};

/**
 * APPROXIMATE seed catalog (USD/MTok + window/limit numbers migrated
 * from v1's `MODEL_CATALOG`). The single source table — `SEED_PRICING`
 * is its pricing projection. Verify against current provider pricing
 * and override via the `registry` parameter for anything sensitive.
 */
export const SEED_MODELS: ModelRegistry = {
  "openai/gpt-4o-mini": {
    pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.075 },
    contextWindow: 128000,
    maxOutputTokens: 16384,
    capabilities: VISION_TOOLS,
  },
  "openai/gpt-4o": {
    pricing: { inputPerMTok: 2.5, outputPerMTok: 10, cachedInputPerMTok: 1.25 },
    contextWindow: 128000,
    maxOutputTokens: 16384,
    capabilities: VISION_TOOLS,
  },
  "anthropic/claude-haiku": {
    pricing: {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cachedInputPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    },
    contextWindow: 200000,
    maxOutputTokens: 8192,
    capabilities: VISION_TOOLS,
  },
  "anthropic/claude-sonnet": {
    pricing: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cachedInputPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
    contextWindow: 200000,
    maxOutputTokens: 16384,
    capabilities: VISION_TOOLS,
  },
  "anthropic/claude-3-5-sonnet": {
    pricing: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cachedInputPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
    contextWindow: 200000,
    maxOutputTokens: 8192,
    capabilities: VISION_TOOLS,
  },
  "anthropic/claude-opus": {
    pricing: {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cachedInputPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
    },
    contextWindow: 200000,
    maxOutputTokens: 32000,
    capabilities: VISION_TOOLS,
  },
  // v1 catalog has no explicit gemini-2.5-flash row; window/limit are
  // the published Gemini 2.5 Flash numbers (approximate, overridable).
  "google/gemini-2.5-flash": {
    pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    capabilities: VISION_TOOLS,
  },
  "google/gemini-2.5-pro": {
    pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    capabilities: VISION_TOOLS,
  },
  // Google's published GLOBAL rates. The non-global endpoints are 10% dearer
  // ($1.65 / $9.90 for 3.5 Flash); an adopter pinned to a region overrides via
  // the `registry` parameter rather than this table guessing which they use.
  // No cache-WRITE surcharge — Google's caching is implicit and charges only
  // the discounted read, so `cacheWritePerMTok` is deliberately absent.
  "google/gemini-3.5-flash": {
    pricing: { inputPerMTok: 1.5, outputPerMTok: 9, cachedInputPerMTok: 0.15 },
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    capabilities: VISION_TOOLS,
  },
  "google/gemini-3.5-flash-lite": {
    pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5, cachedInputPerMTok: 0.03 },
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    capabilities: VISION_TOOLS,
  },
  // Cheaper per output token than 3.5 Flash AND it emits fewer of them —
  // Google reports a 17% reduction in output token usage, which compounds with
  // the 17% lower rate to roughly a third off generation. Reasoning bills as
  // output, so that lands hardest on a thinking agent.
  "google/gemini-3.6-flash": {
    pricing: { inputPerMTok: 1.5, outputPerMTok: 7.5, cachedInputPerMTok: 0.15 },
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    capabilities: VISION_TOOLS,
  },
  // TODO(pricing-tiers): Gemini 3.1 Pro is priced in TWO tiers by input size
  // ($2/$12 under 200K, $4/$18 over), and `ModelPricing` has one rate per
  // direction. It is omitted rather than entered at the low tier, which would
  // under-report every long-context call. `gemini-2.5-pro` above already
  // carries that inaccuracy. Fixing it means a size-dependent rate.
};

/**
 * Longest-prefix model lookup for a target. The one resolver — pricing
 * resolution (`resolvePricing`) lifts its pricing-only table into this
 * shape and reuses it.
 */
export function resolveModelInfo(
  target: Pick<ExecutionTarget, "provider" | "modelId">,
  registry: ModelRegistry = SEED_MODELS,
): ModelInfo | undefined {
  if (!target.provider || !target.modelId) return undefined;
  const key = `${target.provider}/${target.modelId}`;
  let best: { prefix: string; info: ModelInfo } | undefined;
  for (const [prefix, info] of Object.entries(registry)) {
    if (key.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, info };
    }
  }
  return best?.info;
}

/** Layer adopter rows over a base registry. One flat key space, so one spread. */
export function mergeRegistry(base: ModelRegistry, overrides: ModelRegistry): ModelRegistry {
  return { ...base, ...overrides };
}

/**
 * Fold the authoritative view of a model. Precedence per field: adopter
 * `registry` > target self-description (`target.pricing`,
 * `target.capabilities` — which carries `contextWindow` /
 * `maxOutputTokens`) > `SEED_MODELS`. Returns `undefined` only when no
 * layer describes the model at all — never fabricates.
 */
export function effectiveModelInfo(
  target: Pick<ExecutionTarget, "provider" | "modelId" | "pricing" | "capabilities">,
  registry?: ModelRegistry,
): ModelInfo | undefined {
  const seed = resolveModelInfo(target, SEED_MODELS);
  const adopter = registry ? resolveModelInfo(target, registry) : undefined;
  const selfCaps = target.capabilities;
  const selfPricing = target.pricing;

  if (!seed && !adopter && !selfCaps && !selfPricing) return undefined;

  const capabilities =
    seed?.capabilities || selfCaps || adopter?.capabilities
      ? { ...seed?.capabilities, ...selfCaps, ...adopter?.capabilities }
      : undefined;

  return omitUndefined({
    pricing: adopter?.pricing ?? selfPricing ?? seed?.pricing,
    contextWindow: adopter?.contextWindow ?? selfCaps?.contextWindow ?? seed?.contextWindow,
    maxOutputTokens: adopter?.maxOutputTokens ?? selfCaps?.maxOutputTokens ?? seed?.maxOutputTokens,
    capabilities,
    tokenEstimator: adopter?.tokenEstimator ?? seed?.tokenEstimator,
  });
}

/**
 * Context utilization as a ratio in `[0, 1]` (v2 uses a ratio, not a
 * percent). `undefined` when the model has no known window — callers
 * distinguish "unknown" from "empty".
 */
export function contextUtilization(usedTokens: number, info?: ModelInfo): number | undefined {
  const window = info?.contextWindow;
  if (!window) return undefined;
  return Math.min(1, Math.max(0, usedTokens / window));
}

/**
 * Estimate token count for an input. Uses `info.tokenEstimator` when
 * present (adapter/adopter-injected tokenizer); otherwise a char/4
 * heuristic over the concatenated text (#175).
 */
export function estimateTokens(input: LanguageModelInput | string, info?: ModelInfo): number {
  if (info?.tokenEstimator) return info.tokenEstimator(input);
  const text = typeof input === "string" ? input : concatInputText(input);
  return Math.ceil(text.length / 4);
}

/** Concatenate the text carried by a `LanguageModelInput` for char/4 estimation. */
function concatInputText(input: LanguageModelInput): string {
  let text = "";
  for (const message of input.messages) {
    for (const part of message.content) {
      const maybeText = (part as { readonly text?: unknown }).text;
      if (typeof maybeText === "string") text += maybeText;
    }
  }
  return text;
}
