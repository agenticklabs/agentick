/**
 * Usage → cost accounting (#186). The pricing spine — a thin PROJECTION
 * over the ModelInfo registry (`./model-info.ts`), so there is ONE
 * source of numbers. `SEED_PRICING` is `SEED_MODELS` mapped to its
 * `pricing` rows; `resolvePricing` lifts a pricing-only table back into
 * the registry shape and reuses the single longest-prefix resolver.
 *
 * ```ts
 * const cost = estimateCost(result.usage, adapter.target);
 * cost?.totalUSD; // undefined when the model isn't in the table
 * ```
 *
 * Relies on the NORMATIVE UsageStats rule (#186): `cachedInputTokens` /
 * `cacheCreationTokens` are SUBSETS of `inputTokens`.
 *
 * // TODO(trail-budget-guard): maxCost analog of maxTicks — a send-level
 * // bound folding estimateCost over execution results.
 * // TODO(trail-principal-quotas): per-principal aggregation keyed by the
 * // ADR 48 scope key (BYOK/cluster story).
 * // TODO(trail-devtools-cost): surface CostEstimate on executor events.
 */

import type { ExecutionTarget, UsageStats } from "@agentick/spec-next";

import {
  resolveModelInfo,
  SEED_MODELS,
  type ModelInfo,
  type ModelPricing,
  type ModelRegistry,
} from "./model-info.js";

/** USD per MILLION tokens (industry convention). Canonical shape in `./model-info.ts`. */
export type { ModelPricing } from "./model-info.js";

/**
 * provider → modelId PREFIX → pricing. Longest-prefix match, so
 * `"gpt-4o"` covers `"gpt-4o-2024-11-20"` while `"gpt-4o-mini"` wins
 * for minis. A pricing-only projection of {@link ModelRegistry}.
 */
export type PricingTable = Readonly<Record<string, Readonly<Record<string, ModelPricing>>>>;

/** Project a registry down to its priced rows (drops rows without pricing). */
function projectPricing(registry: ModelRegistry): PricingTable {
  const out: Record<string, Record<string, ModelPricing>> = {};
  for (const [provider, models] of Object.entries(registry)) {
    const priced: Record<string, ModelPricing> = {};
    for (const [prefix, info] of Object.entries(models)) {
      if (info.pricing) priced[prefix] = info.pricing;
    }
    if (Object.keys(priced).length > 0) out[provider] = priced;
  }
  return out;
}

/**
 * APPROXIMATE seed rates (USD/MTok). The pricing projection of
 * {@link SEED_MODELS} — override via the `table` parameter for anything
 * cost-sensitive.
 */
export const SEED_PRICING: PricingTable = projectPricing(SEED_MODELS);

/** Layer adopter rates over a base table (per-provider shallow merge). */
export function mergePricing(base: PricingTable, overrides: PricingTable): PricingTable {
  const out: Record<string, Record<string, ModelPricing>> = {};
  const providers = new Set<string>([...Object.keys(base), ...Object.keys(overrides)]);
  for (const provider of providers) {
    out[provider] = { ...(base[provider] ?? {}), ...(overrides[provider] ?? {}) };
  }
  return out;
}

/**
 * Longest-prefix pricing lookup for a target. Lifts the pricing-only
 * `table` into the registry shape and delegates to the single resolver
 * (`resolveModelInfo`), then projects the match back to its pricing.
 */
export function resolvePricing(
  target: Pick<ExecutionTarget, "provider" | "modelId">,
  table: PricingTable = SEED_PRICING,
): ModelPricing | undefined {
  const registry: Record<string, Record<string, ModelInfo>> = {};
  for (const [provider, models] of Object.entries(table)) {
    registry[provider] = {};
    for (const [prefix, pricing] of Object.entries(models)) {
      registry[provider][prefix] = { pricing };
    }
  }
  return resolveModelInfo(target, registry)?.pricing;
}

export interface CostEstimate {
  readonly inputUSD: number;
  readonly outputUSD: number;
  readonly cachedInputUSD: number;
  readonly cacheWriteUSD: number;
  readonly totalUSD: number;
  /** The pricing row used — inspect to audit an estimate. */
  readonly pricing: ModelPricing;
}

/**
 * Estimate the cost of a usage sample against a target. Returns
 * `undefined` for models not in the table — never fabricates zeros.
 */
export function estimateCost(
  usage: UsageStats,
  target: Pick<ExecutionTarget, "provider" | "modelId" | "pricing">,
  table?: PricingTable,
): CostEstimate | undefined {
  // Resolution: an explicitly supplied table wins (adopter override);
  // else the target's self-described pricing (the adapter is the
  // authority on its own model, ratified 2026-07-04); else the seed.
  const pricing = table
    ? resolvePricing(target, table)
    : (target.pricing ?? resolvePricing(target, SEED_PRICING));
  if (!pricing) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheCreationTokens ?? 0;
  const fresh = Math.max(usage.inputTokens - cached - written, 0);
  const per = 1 / 1_000_000;
  const inputUSD = fresh * pricing.inputPerMTok * per;
  const cachedInputUSD = cached * (pricing.cachedInputPerMTok ?? pricing.inputPerMTok) * per;
  const cacheWriteUSD = written * (pricing.cacheWritePerMTok ?? pricing.inputPerMTok) * per;
  const outputUSD = usage.outputTokens * pricing.outputPerMTok * per;
  return {
    inputUSD,
    outputUSD,
    cachedInputUSD,
    cacheWriteUSD,
    totalUSD: inputUSD + outputUSD + cachedInputUSD + cacheWriteUSD,
    pricing,
  };
}

/** Pure UsageStats merge — the canonical fold for aggregation. */
export function mergeUsageStats(a: UsageStats, b: UsageStats): UsageStats {
  const opt = (x?: number, y?: number): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const reasoningTokens = opt(a.reasoningTokens, b.reasoningTokens);
  const cachedInputTokens = opt(a.cachedInputTokens, b.cachedInputTokens);
  const cacheCreationTokens = opt(a.cacheCreationTokens, b.cacheCreationTokens);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  };
}
