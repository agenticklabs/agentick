/**
 * Usage → cost accounting (#186). One data table and one fold — the
 * spine that budgets, quotas, and devtools cost displays ride on.
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
 * provider → modelId PREFIX → pricing. Longest-prefix match, so
 * `"gpt-4o"` covers `"gpt-4o-2024-11-20"` while `"gpt-4o-mini"` wins
 * for minis.
 */
export type PricingTable = Readonly<Record<string, Readonly<Record<string, ModelPricing>>>>;

/**
 * APPROXIMATE seed rates (USD/MTok) as a convenience default —
 * providers change prices; verify against current provider pricing and
 * override via the `table` parameter for anything cost-sensitive.
 */
export const SEED_PRICING: PricingTable = {
  openai: {
    "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.075 },
    "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10, cachedInputPerMTok: 1.25 },
  },
  anthropic: {
    "claude-haiku": {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cachedInputPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    },
    "claude-sonnet": {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cachedInputPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
    "claude-3-5-sonnet": {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cachedInputPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
    "claude-opus": {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cachedInputPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
    },
  },
  google: {
    "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
    "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10 },
  },
};

/** Layer adopter rates over a base table (per-provider shallow merge). */
export function mergePricing(base: PricingTable, overrides: PricingTable): PricingTable {
  const out: Record<string, Record<string, ModelPricing>> = {};
  const providers = new Set<string>([...Object.keys(base), ...Object.keys(overrides)]);
  for (const provider of providers) {
    out[provider] = { ...(base[provider] ?? {}), ...(overrides[provider] ?? {}) };
  }
  return out;
}

/** Longest-prefix pricing lookup for a target. */
export function resolvePricing(
  target: Pick<ExecutionTarget, "provider" | "modelId">,
  table: PricingTable = SEED_PRICING,
): ModelPricing | undefined {
  if (!target.provider || !target.modelId) return undefined;
  const models = table[target.provider];
  if (!models) return undefined;
  let best: { prefix: string; pricing: ModelPricing } | undefined;
  for (const [prefix, pricing] of Object.entries(models)) {
    if (target.modelId.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, pricing };
    }
  }
  return best?.pricing;
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
