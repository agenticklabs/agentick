/**
 * Token-budget compaction for timeline message entries.
 *
 * Pure functions. Used by `<Timeline maxTokens={…}>` to evict older
 * entries when the persisted history exceeds a configured budget.
 *
 * Token estimates come from `estimateBlocks` in `@agentick/model` — one
 * arithmetic, shared with the request estimator (ADR 97), so media is priced
 * at the active model's real per-modality rates instead of the zero a
 * text-only walk gave it. Approximate by design; this is a budgeting hint, not
 * a billing surface. A floor of 4 tokens per entry accounts for the
 * role/wrapper overhead the wire format adds.
 *
 * @see packages/core/src/jsx/components/token-budget.ts (v1 origin)
 */

import type { TimelineEntry } from "@agentick/spec";
import { danglingToolIds, isDangling, isIntact, toolSpanEnd } from "@agentick/spec";
import { estimateBlocks, type EstimateOptions } from "@agentick/model";

// ============================================================================
// Types
// ============================================================================

/**
 * Token-budget compaction operates on message-kind entries only. Other
 * timeline kinds (state-change records, subscription receipts) get
 * filtered out before reaching this layer.
 */
type MessageTimelineEntry = Extract<TimelineEntry, { kind: "message" }>;

/**
 * Compaction strategy for handling token-budget overflow.
 *
 *   - `"none"`            no compaction, entries pass through unchanged
 *   - `"truncate"`        keep the newest entries that fit within budget
 *   - `"sliding-window"`  preserve {@link CompactOptions.preserveRoles},
 *                         then fill remaining budget with newest entries
 *   - function            full control over compaction logic
 */
export type CompactionStrategy = "none" | "truncate" | "sliding-window" | CompactionFunction;

export type CompactionFunction = (
  entries: readonly MessageTimelineEntry[],
  budget: { maxTokens: number; currentTokens: number },
  guidance?: string,
) => CompactionResult;

export interface CompactionResult {
  readonly kept: readonly MessageTimelineEntry[];
  readonly evicted: readonly MessageTimelineEntry[];
}

/**
 * Budget telemetry exposed to render-prop consumers.
 */
export interface TokenBudgetInfo {
  /** Configured `maxTokens`. */
  readonly maxTokens: number;
  /** `maxTokens - headroom`. */
  readonly effectiveBudget: number;
  /** Total tokens of `kept` entries after compaction. */
  readonly currentTokens: number;
  /** Number of entries evicted. */
  readonly evictedCount: number;
  /** True iff `evictedCount > 0`. */
  readonly isCompacted: boolean;
}

export interface CompactOptions {
  readonly maxTokens: number;
  /**
   * Per-modality rates for sizing media. Absent, media prices at the shared
   * floor — a caller with the active model in hand passes `{ info }` so an
   * image costs what THIS provider charges for it.
   */
  readonly estimate?: EstimateOptions;
  readonly strategy?: CompactionStrategy;
  readonly headroom?: number;
  readonly preserveRoles?: readonly string[];
  readonly guidance?: string;
}

export interface CompactResult {
  readonly kept: readonly MessageTimelineEntry[];
  readonly evicted: readonly MessageTimelineEntry[];
  readonly currentTokens: number;
}

// ============================================================================
// Token estimation
// ============================================================================

const ENTRY_OVERHEAD = 4;

/**
 * Tokens an entry costs, plus the role/wrapper overhead the wire format adds.
 *
 * The arithmetic is `estimateBlocks` in `@agentick/model` (ADR 97). This used
 * to be a hand-rolled per-block switch with a `default: return 0` arm, which is
 * how an image, a PDF and a recording each came to cost nothing — the entries
 * most likely to be worth evicting were the ones the budget could not see.
 *
 * `options` is how a caller supplies the active model's real per-modality
 * rates; without it the shared floor applies, which is still a number rather
 * than a silent zero.
 */
export function getEntryTokens(entry: MessageTimelineEntry, options?: EstimateOptions): number {
  return estimateBlocks(entry.message.content, options) + ENTRY_OVERHEAD;
}

// ============================================================================
// Built-in strategies
// ============================================================================

function truncateStrategy(
  entries: readonly MessageTimelineEntry[],
  effectiveBudget: number,
  estimate: EstimateOptions | undefined,
): CompactionResult {
  const kept: MessageTimelineEntry[] = [];
  const evicted: MessageTimelineEntry[] = [];
  let budget = effectiveBudget;
  for (let i = entries.length - 1; i >= 0; i--) {
    const tokens = getEntryTokens(entries[i]!, estimate);
    if (budget >= tokens) {
      kept.unshift(entries[i]!);
      budget -= tokens;
    } else {
      evicted.unshift(entries[i]!);
    }
  }
  return { kept, evicted };
}

function slidingWindowStrategy(
  entries: readonly MessageTimelineEntry[],
  effectiveBudget: number,
  preserveRoles: readonly string[],
  estimate: EstimateOptions | undefined,
): CompactionResult {
  const preserved = new Set<number>();
  let preservedTokens = 0;
  for (let i = 0; i < entries.length; i++) {
    if (preserveRoles.includes(entries[i]!.message.role)) {
      preserved.add(i);
      preservedTokens += getEntryTokens(entries[i]!, estimate);
    }
  }

  const remaining = effectiveBudget - preservedTokens;
  let budget = remaining;
  const keptCandidates = new Set<number>();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (preserved.has(i)) continue;
    const tokens = getEntryTokens(entries[i]!, estimate);
    if (budget >= tokens) {
      keptCandidates.add(i);
      budget -= tokens;
    }
  }

  const kept: MessageTimelineEntry[] = [];
  const evicted: MessageTimelineEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (preserved.has(i) || keptCandidates.has(i)) kept.push(entries[i]!);
    else evicted.push(entries[i]!);
  }
  return { kept, evicted };
}

/**
 * Evict the entries left holding one end of a broken span — a `tool_result`
 * whose `tool_use` the strategy dropped, or the reverse.
 *
 * Eviction cannot do what the fold does and simply choose a different cut:
 * `maxTokens` is a ceiling and every entry either fits or does not. So the
 * partner goes too, which is also the only repair that returns its tokens to the
 * budget rather than charging them to a message no longer being sent.
 *
 * Neither built-in strategy produces a contiguous window — both scan newest-first
 * and keep whatever individually fits, so a fat assistant turn carrying a
 * `tool_use` is evicted while the small `tool` message after it fits and is kept.
 * A custom `CompactionFunction` can break a span any way it likes. So the rule
 * lives at the entry point, the only place that sees every strategy's answer.
 */
function evictDanglingHalves(
  entries: readonly MessageTimelineEntry[],
  result: CompactionResult,
): CompactionResult {
  const dangling = danglingToolIds(result.kept.map((e) => e.message.content));
  if (isIntact(dangling)) return result;

  const isDangler = (entry: MessageTimelineEntry): boolean =>
    entry.message.content.some((block) => {
      const span = toolSpanEnd(block);
      return span !== undefined && isDangling(span, dangling);
    });

  // `evicted` reaches adopters through `onEvict`, so it stays chronological
  // rather than growing a tail of late additions.
  const position = new Map(entries.map((entry, i) => [entry, i]));
  const at = (entry: MessageTimelineEntry): number =>
    position.get(entry) ?? Number.MAX_SAFE_INTEGER;

  return {
    kept: result.kept.filter((entry) => !isDangler(entry)),
    evicted: [...result.evicted, ...result.kept.filter(isDangler)].sort((a, b) => at(a) - at(b)),
  };
}

// ============================================================================
// Entry point
// ============================================================================

export function compactEntries(
  entries: readonly MessageTimelineEntry[],
  options: CompactOptions,
): CompactResult {
  const {
    maxTokens,
    strategy = "sliding-window",
    headroom = 0,
    preserveRoles = ["system"],
    guidance,
    estimate,
  } = options;

  if (strategy === "none" || entries.length === 0) {
    let total = 0;
    for (const e of entries) total += getEntryTokens(e, estimate);
    return { kept: entries, evicted: [], currentTokens: total };
  }

  const effectiveBudget = maxTokens - headroom;
  let totalTokens = 0;
  for (const e of entries) totalTokens += getEntryTokens(e, estimate);
  if (totalTokens <= effectiveBudget) {
    return { kept: entries, evicted: [], currentTokens: totalTokens };
  }

  let result: CompactionResult;
  if (typeof strategy === "function") {
    result = strategy(
      entries,
      { maxTokens: effectiveBudget, currentTokens: totalTokens },
      guidance,
    );
  } else if (strategy === "truncate") {
    result = truncateStrategy(entries, effectiveBudget, estimate);
  } else {
    result = slidingWindowStrategy(entries, effectiveBudget, preserveRoles, estimate);
  }

  const intact = evictDanglingHalves(entries, result);
  let keptTokens = 0;
  for (const e of intact.kept) keptTokens += getEntryTokens(e, estimate);
  return { kept: intact.kept, evicted: intact.evicted, currentTokens: keptTokens };
}
