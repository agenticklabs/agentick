/**
 * Usage → cost. Rate cards, money, per-tick stamping shapes, and the
 * per-model rollup.
 *
 * The framework ships NO prices. Rates are adopter-supplied at model
 * construction (they ride {@link ExecutionTarget.rates}) or produced by
 * an app-level `CostResolver`. An unpriced tick rolls up as UNPRICED,
 * never as zero — see {@link CostRollup}.
 *
 * Everything here is pure and total: no clock, no I/O, no ambient
 * config. Cost arithmetic lives in spec rather than in a harness
 * because it is a function of two spec types, and every layer that
 * needs it (loop-executor, session, app, adapters) already depends on
 * spec.
 *
 * @see docs/proposals/v2/usage-cost.md
 */

import type { UsageStats } from "./execution-result.js";
import type { ExecutionTarget } from "./execution-target.js";

// ============================================================================
// Money
// ============================================================================

/** ISO-4217 currency code (`"USD"`, `"EUR"`, …). */
export type Currency = string;

/** One unit of currency, in micro-units. `1 USD === 1_000_000` micros. */
export const MICROS_PER_UNIT = 1_000_000;

/**
 * Money as an INTEGER count of micro-units — never a float.
 *
 * A cost total is a fold over hundreds of ticks, so float representation
 * error accumulates in exactly the direction nobody audits. Six decimal
 * places of USD is three more than any provider prices to, and integer
 * addition is exact and order-independent.
 */
export interface Cost {
  readonly amountMicros: number;
  readonly currency: Currency;
  /**
   * The {@link RateCard.id} that produced this amount. Stamped at act
   * time and never recomputed: a price published tomorrow must not
   * reprice yesterday's records.
   */
  readonly rateRef: string;
}

// ============================================================================
// Rate cards
// ============================================================================

/**
 * The priceable token kinds.
 *
 * `cacheRead` / `cacheWrite` are subsets of input; `reasoning` is a
 * subset of output (see {@link UsageStats}). Rates therefore apply to
 * disjoint REMAINDERS, not to the raw counters — {@link priceUsage}
 * does that split.
 *
 * // TODO(trail-cache-ttl-tiers): `cacheWrite` is ONE kind, but cache
 * // writes are tiered by TTL (Anthropic: 1.25x input at 5-minute TTL,
 * // 2x at 1-hour) and the provider reports the split. `UsageStats`
 * // collapses both into `cacheCreationTokens`, so no card can price
 * // them apart and long-TTL workloads under-bill. Closing it means
 * // splitting the counter at every adapter AND in `UsageStats` — this
 * // union is closed, so it is a spec change, not a config one.
 */
export type TokenKind = "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning";

export interface RateCard {
  /**
   * Stable identity, stamped on every {@link Cost} this card produces.
   * DATE it — a price change is a new card, not an edit to an existing
   * one (`"anthropic:claude-sonnet-5@2026-07-01"`). A card whose id is
   * stable across a price change defeats the point of stamping.
   */
  readonly id: string;
  readonly currency: Currency;
  /**
   * Micro-units of {@link currency} per MILLION tokens. Per-million
   * because per-token rates in micros are sub-integer ($3/MTok =
   * 0.003 µ/token); per MTok they are clean integers ($3/MTok =
   * `3_000_000`).
   *
   * A `reasoning` rate is opt-in: when absent, reasoning tokens are
   * priced at the `output` rate, which is what providers actually do.
   * Same for `cacheRead` / `cacheWrite` falling back to `input`.
   */
  readonly perMTok: Partial<Record<TokenKind, number>>;
  /** Flat per-call fee in micro-units (gateway surcharge, request minimum). */
  readonly perCallMicros?: number;
}

// ============================================================================
// Arithmetic
// ============================================================================

/**
 * Price one tick's usage against a rate card.
 *
 * Containment (`cacheRead`/`cacheWrite` ⊆ input, `reasoning` ⊆ output)
 * means rates apply to disjoint remainders — charging the `input` rate
 * against the whole of `inputTokens` while ALSO charging `cacheRead`
 * against `cachedInputTokens` bills cached tokens twice.
 *
 * Rounding is deferred to exactly one division at the end. Rounding per
 * kind and summing introduces up to five half-micro errors per tick and
 * makes the total depend on kind ordering.
 */
export function priceUsage(usage: UsageStats, card: RateCard): Cost {
  const rate = (kind: TokenKind, fallback?: TokenKind): number =>
    card.perMTok[kind] ?? (fallback !== undefined ? (card.perMTok[fallback] ?? 0) : 0);

  const cacheRead = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationTokens ?? 0;
  const freshInput = Math.max(usage.inputTokens - cacheRead - cacheWrite, 0);

  // A `reasoning` rate is what splits output; without one, the output
  // rate covers reasoning tokens and no split happens.
  const hasReasoningRate = card.perMTok.reasoning !== undefined;
  const reasoning = hasReasoningRate ? (usage.reasoningTokens ?? 0) : 0;
  const freshOutput = Math.max(usage.outputTokens - reasoning, 0);

  const subMicroMTok =
    freshInput * rate("input") +
    freshOutput * rate("output") +
    cacheRead * rate("cacheRead", "input") +
    cacheWrite * rate("cacheWrite", "input") +
    reasoning * rate("reasoning", "output");

  return {
    amountMicros: Math.round(subMicroMTok / MICROS_PER_UNIT) + (card.perCallMicros ?? 0),
    currency: card.currency,
    rateRef: card.id,
  };
}

// ============================================================================
// The resolver seam
// ============================================================================

export interface CostResolverInput {
  /** The model this tick actually ran against, after the `<Model>` cascade. */
  readonly target: ExecutionTarget;
  readonly usage: UsageStats;
  readonly sessionId: string;
  readonly executionId: string;
  readonly tickId: string;
}

/**
 * App-level pricing seam. WINS over {@link ExecutionTarget.rates}
 * whenever it returns a value; `undefined` falls through to the
 * declared rates.
 *
 * Both return arms are real. A {@link RateCard} says "here are the
 * rates, you do the arithmetic" — per-tenant contracts, volume tiers. A
 * {@link Cost} says "I did the arithmetic" — a marketplace markup or a
 * credit system, where the number billed is not a function of tokens at
 * all. Discriminate structurally: a `Cost` has `amountMicros`.
 *
 * A seam rather than a config enum because pricing policy is unbounded;
 * any enum we shipped would be a guess at which three policies matter.
 */
export type CostResolver = (input: CostResolverInput) => RateCard | Cost | undefined;

/** Structural discriminator for a {@link CostResolver} return value. */
export function isCost(value: RateCard | Cost): value is Cost {
  return "amountMicros" in value;
}

/**
 * Resolve + price one tick. Returns `undefined` when neither the
 * resolver nor the target supplies rates — the tick is UNPRICED, which
 * is a fact to record, not a zero to fabricate.
 */
export function resolveTickCost(
  input: CostResolverInput,
  resolver?: CostResolver,
): Cost | undefined {
  const resolved = resolver?.(input);
  if (resolved !== undefined) {
    return isCost(resolved) ? resolved : priceUsage(input.usage, resolved);
  }
  const declared = input.target.rates;
  return declared !== undefined ? priceUsage(input.usage, declared) : undefined;
}

// ============================================================================
// Rollups
// ============================================================================

/**
 * A cost total is either COMPLETE, or it says how much of itself is
 * missing. An unpriced tick never rolls up as zero.
 *
 * Zero is a claim — "this cost nothing". An unpriced tick cost
 * something; we just cannot say what. Folding it in as zero produces a
 * total that is confidently, silently low, in the direction nobody
 * double-checks.
 *
 * Discriminated rather than a flat shape carrying an `unpricedTicks`
 * consumers may ignore, for the reason {@link
 * import("./execution-result.js").StopCause} is
 * discriminated: the two arms demand DIFFERENT WORDS on screen
 * (`"$1.23"` vs `"at least $1.23"`), and a flat shape lets every
 * consumer render the wrong one by omission.
 */
export type CostRollup =
  | {
      readonly kind: "complete";
      readonly amountMicros: number;
      readonly currency: Currency;
      /** Ticks folded in — all of them priced. */
      readonly ticks: number;
      /** Distinct {@link RateCard.id}s behind this total. */
      readonly rateRefs: readonly string[];
    }
  | {
      readonly kind: "partial";
      /** A LOWER BOUND — the true cost is this plus the unpriced ticks. */
      readonly amountMicros: number;
      readonly currency: Currency;
      readonly pricedTicks: number;
      /**
       * Ticks that produced no cost IN THIS TOTAL. Includes ticks with
       * no rate card, and ticks priced in a different currency (they
       * stay fully priced in their own {@link UsageRollup.byModel}
       * bucket — summing across currencies is the same class of lie as
       * summing unpriced ticks as zero).
       */
      readonly unpricedTicks: number;
      readonly rateRefs: readonly string[];
    };

/**
 * Model identity key for {@link UsageRollup.byModel} —
 * `` `${provider}/${modelId}` ``, or `"unknown"` when the target names
 * neither.
 */
export type ModelKey = string;

/** Build the {@link ModelKey} for a target. */
export function modelKey(target?: Pick<ExecutionTarget, "provider" | "modelId">): ModelKey {
  if (target?.provider === undefined && target?.modelId === undefined) return "unknown";
  return `${target.provider ?? "unknown"}/${target.modelId ?? "unknown"}`;
}

export interface ModelUsage {
  readonly provider?: string;
  readonly modelId?: string;
  readonly usage: UsageStats;
  readonly ticks: number;
  readonly cost?: CostRollup;
}

/**
 * Usage aggregated at any level (execution, turn, session).
 *
 * The flat `usage` stays — "how many tokens did this burn" is a real
 * question with a real flat answer, and context-window consumers read
 * it. What changes is that it is no longer the ONLY answer: cost is not
 * a function of a bag flattened across models, so `byModel` is
 * preserved at every level.
 */
export interface UsageRollup {
  /** Flat totals across every model. Safe to sum; meaningless to price. */
  readonly usage: UsageStats;
  readonly byModel: Readonly<Record<ModelKey, ModelUsage>>;
  /** Absent when no usage was recorded at all. */
  readonly cost?: CostRollup;
}

// ============================================================================
// Folds
// ============================================================================

/**
 * Fold one tick's cost into a running rollup.
 *
 * `undefined` cost = an unpriced tick, which degrades the total to
 * `partial` rather than adding zero. A cost in a currency other than
 * the one already established does the same.
 */
export function foldCost(acc: CostRollup | undefined, cost: Cost | undefined): CostRollup {
  const base: CostRollup =
    acc ??
    ({
      kind: "complete",
      amountMicros: 0,
      currency: cost?.currency ?? "",
      ticks: 0,
      rateRefs: [],
    } satisfies CostRollup);

  const priced = base.kind === "complete" ? base.ticks : base.pricedTicks;
  const unpriced = base.kind === "complete" ? 0 : base.unpricedTicks;
  const currency = base.currency === "" ? (cost?.currency ?? "") : base.currency;
  const usable = cost !== undefined && cost.currency === currency;

  const rateRefs =
    usable && !base.rateRefs.includes(cost.rateRef)
      ? [...base.rateRefs, cost.rateRef]
      : base.rateRefs;
  const amountMicros = base.amountMicros + (usable ? cost.amountMicros : 0);

  if (usable) {
    return unpriced === 0
      ? { kind: "complete", amountMicros, currency, ticks: priced + 1, rateRefs }
      : {
          kind: "partial",
          amountMicros,
          currency,
          pricedTicks: priced + 1,
          unpricedTicks: unpriced,
          rateRefs,
        };
  }
  return {
    kind: "partial",
    amountMicros,
    currency,
    pricedTicks: priced,
    unpricedTicks: unpriced + 1,
    rateRefs,
  };
}

/**
 * Pure {@link UsageStats} merge — the canonical fold for aggregation.
 *
 * The three always-present counters add unconditionally; the optional
 * kinds stay `undefined` until some sample reports one, so a run against
 * a provider that never reports cache writes does not fabricate zeros
 * (absent ≠ zero — see the module docblock in `execution-result.ts`).
 */
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

/**
 * Fold one tick into a per-model breakdown. This is the fold that makes
 * cost computable: a bag flattened across models cannot be priced,
 * because the rate is a property of the model that produced the tokens.
 */
export function foldModelUsage(
  byModel: Readonly<Record<ModelKey, ModelUsage>>,
  target: Pick<ExecutionTarget, "provider" | "modelId"> | undefined,
  usage: UsageStats,
  cost: Cost | undefined,
): Readonly<Record<ModelKey, ModelUsage>> {
  const key = modelKey(target);
  const prior = byModel[key];
  const entry: ModelUsage = {
    ...(target?.provider !== undefined ? { provider: target.provider } : {}),
    ...(target?.modelId !== undefined ? { modelId: target.modelId } : {}),
    usage: prior ? mergeUsageStats(prior.usage, usage) : usage,
    ticks: (prior?.ticks ?? 0) + 1,
    cost: foldCost(prior?.cost, cost),
  };
  return { ...byModel, [key]: entry };
}

/** Fold one tick into a whole {@link UsageRollup} — flat totals + breakdown + cost. */
export function foldUsageRollup(
  acc: UsageRollup | undefined,
  target: Pick<ExecutionTarget, "provider" | "modelId"> | undefined,
  usage: UsageStats,
  cost: Cost | undefined,
): UsageRollup {
  return {
    usage: acc ? mergeUsageStats(acc.usage, usage) : usage,
    byModel: foldModelUsage(acc?.byModel ?? {}, target, usage, cost),
    cost: foldCost(acc?.cost, cost),
  };
}

// ============================================================================
// Cross-graph attribution — QUERY time, never write time
// ============================================================================

/**
 * The minimum join surface a record needs to take part in a tree rollup.
 *
 * Structurally satisfied by `SessionRecord` as it already exists — no new
 * storage, no new write, no new verb. That is the point: the keys to
 * answer "what did this agent tree cost" are already durable, so the
 * answer is a QUERY, and the framework's obligation is to ship the fold,
 * not to ship another writer.
 */
export interface CostAttributionRecord {
  readonly id: string;
  /** Ancestor chain, root-first. Absent/empty for a root. */
  readonly spawnPath?: readonly string[];
  readonly usage: UsageStats;
  readonly byModel?: Readonly<Record<ModelKey, ModelUsage>>;
  readonly cost?: CostRollup;
}

/**
 * Is `record` inside `rootId`'s spawn tree — the root itself, or any
 * descendant at any depth?
 *
 * Depth-agnostic on purpose. `parentSessionId` answers "direct children";
 * an agent tree is not one level deep, and a rollup that stops at one is
 * silently missing the grandchildren's money.
 */
export function inSpawnTree(
  record: Pick<CostAttributionRecord, "id" | "spawnPath">,
  rootId: string,
): boolean {
  return record.id === rootId || (record.spawnPath?.includes(rootId) ?? false);
}

/**
 * Fold a set of records into ONE rollup for an agent tree.
 *
 * ## Why this is a query and not a write
 *
 * A spawned session's cost is never propagated root-ward at write time.
 * Three reasons, each sufficient on its own:
 *
 * 1. **Write amplification.** A deep tree would re-write every ancestor
 *    record on every tick of every descendant. The cost of accounting
 *    would scale with depth × tick count, for a number nobody has asked
 *    for yet.
 * 2. **Structural double-count.** If a parent's record contained its
 *    children's spend, then summing records — the most natural thing any
 *    consumer does, and exactly what a billing export or a per-principal
 *    total is — counts every descendant once per ancestor above it. The
 *    error is silent, grows with depth, and always overstates.
 * 3. **Attribution is policy, not fact.** Who pays for a detached task,
 *    or for a sub-agent shared between two parents, is the adopter's
 *    call. Write-time rollup freezes ONE answer into the record and
 *    destroys the others. A query lets the caller choose the scope; a
 *    write chooses it for them, permanently.
 *
 * ## The honesty rule extends to the tree
 *
 * A tree total is `partial` if ANY descendant contributes unpriced work
 * — including a record that reported usage and carries no cost at all,
 * which {@link mergeCostRollups} alone would skip over rather than
 * degrade. The whole point is that a tree total may not claim to be
 * complete while one branch of it is unknown.
 *
 * NOTE the one thing this cannot detect: a descendant whose record was
 * never handed in. Missing rows are indistinguishable from a tree that
 * does not have them, so the caller owns the completeness of `records`
 * — pass what a `list` returned, not a hand-picked subset.
 */
export function rollupTree(
  records: Iterable<CostAttributionRecord>,
  rootId: string,
): UsageRollup | undefined {
  let usage: UsageStats | undefined;
  let byModel: Readonly<Record<ModelKey, ModelUsage>> = {};
  let cost: CostRollup | undefined;
  let matched = false;

  for (const record of records) {
    if (!inSpawnTree(record, rootId)) continue;
    matched = true;

    usage = usage === undefined ? record.usage : mergeUsageStats(usage, record.usage);

    for (const [key, entry] of Object.entries(record.byModel ?? {})) {
      const prior = byModel[key];
      byModel = {
        ...byModel,
        [key]: prior
          ? {
              ...prior,
              usage: mergeUsageStats(prior.usage, entry.usage),
              ticks: prior.ticks + entry.ticks,
              cost: mergeCostRollups(prior.cost, entry.cost),
            }
          : entry,
      };
    }

    if (record.cost !== undefined) {
      cost = mergeCostRollups(cost, record.cost);
    } else if (record.usage.totalTokens > 0) {
      // Usage with no cost rollup at all: this session burned tokens and
      // was never priced. `mergeCostRollups(cost, undefined)` returns
      // `cost` unchanged, which would let the tree claim `complete` while
      // a whole branch is unaccounted for. Degrade explicitly.
      cost = foldCost(cost, undefined);
    }
  }

  if (!matched) return undefined;
  return {
    usage: usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    byModel,
    ...(cost !== undefined ? { cost } : {}),
  };
}

/**
 * Fold two rollups (execution → session). `complete + complete` in one
 * currency stays complete; anything touching a `partial` or a foreign
 * currency degrades, with the foreign side's ticks counted unpriced.
 */
export function mergeCostRollups(
  a: CostRollup | undefined,
  b: CostRollup | undefined,
): CostRollup | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;

  const aPriced = a.kind === "complete" ? a.ticks : a.pricedTicks;
  const aUnpriced = a.kind === "complete" ? 0 : a.unpricedTicks;
  const bPriced = b.kind === "complete" ? b.ticks : b.pricedTicks;
  const bUnpriced = b.kind === "complete" ? 0 : b.unpricedTicks;

  if (a.currency !== b.currency) {
    // b's priced ticks are unpriced IN THIS total — they remain priced
    // in their own byModel bucket.
    return {
      kind: "partial",
      amountMicros: a.amountMicros,
      currency: a.currency,
      pricedTicks: aPriced,
      unpricedTicks: aUnpriced + bPriced + bUnpriced,
      rateRefs: a.rateRefs,
    };
  }

  const rateRefs = [...a.rateRefs];
  for (const ref of b.rateRefs) if (!rateRefs.includes(ref)) rateRefs.push(ref);
  const amountMicros = a.amountMicros + b.amountMicros;
  const unpricedTicks = aUnpriced + bUnpriced;

  return unpricedTicks === 0
    ? { kind: "complete", amountMicros, currency: a.currency, ticks: aPriced + bPriced, rateRefs }
    : {
        kind: "partial",
        amountMicros,
        currency: a.currency,
        pricedTicks: aPriced + bPriced,
        unpricedTicks,
        rateRefs,
      };
}
