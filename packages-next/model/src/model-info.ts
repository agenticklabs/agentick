/**
 * ModelInfo registry (#204) — ONE per-model reference table folding
 * pricing, context window, output cap, capabilities, and a token
 * estimator. It widens the pricing table's `provider → modelId-prefix →
 * data` shape rather than standing up a parallel registry: the pricing
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

import type { ExecutionTarget, LanguageModelInput, TargetCapabilities } from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

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
 * provider → modelId PREFIX → info. Longest-prefix match, so
 * `"gpt-4o"` covers `"gpt-4o-2024-11-20"` while `"gpt-4o-mini"` wins for
 * minis. Structurally the pricing table's shape, widened past pricing.
 */
export type ModelRegistry = Readonly<Record<string, Readonly<Record<string, ModelInfo>>>>;

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
  openai: {
    "gpt-4o-mini": {
      pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.075 },
      contextWindow: 128000,
      maxOutputTokens: 16384,
      capabilities: VISION_TOOLS,
    },
    "gpt-4o": {
      pricing: { inputPerMTok: 2.5, outputPerMTok: 10, cachedInputPerMTok: 1.25 },
      contextWindow: 128000,
      maxOutputTokens: 16384,
      capabilities: VISION_TOOLS,
    },
  },
  anthropic: {
    "claude-haiku": {
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
    "claude-sonnet": {
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
    "claude-3-5-sonnet": {
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
    "claude-opus": {
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
  },
  google: {
    // v1 catalog has no explicit gemini-2.5-flash row; window/limit are
    // the published Gemini 2.5 Flash numbers (approximate, overridable).
    "gemini-2.5-flash": {
      pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      capabilities: VISION_TOOLS,
    },
    "gemini-2.5-pro": {
      pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
      contextWindow: 1000000,
      maxOutputTokens: 65536,
      capabilities: VISION_TOOLS,
    },
  },
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
  const models = registry[target.provider];
  if (!models) return undefined;
  const modelId = target.modelId;
  let best: { prefix: string; info: ModelInfo } | undefined;
  for (const [prefix, info] of Object.entries(models)) {
    if (modelId.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, info };
    }
  }
  return best?.info;
}

/** Layer adopter rows over a base registry (per-provider shallow merge). */
export function mergeRegistry(base: ModelRegistry, overrides: ModelRegistry): ModelRegistry {
  const out: Record<string, Record<string, ModelInfo>> = {};
  const providers = new Set<string>([...Object.keys(base), ...Object.keys(overrides)]);
  for (const provider of providers) {
    out[provider] = { ...(base[provider] ?? {}), ...(overrides[provider] ?? {}) };
  }
  return out;
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
