/**
 * Token-budget compaction for timeline message entries.
 *
 * Pure functions. Used by `<Timeline maxTokens={…}>` to evict older
 * entries when the persisted history exceeds a configured budget.
 *
 * Token estimates use a `chars / 4` heuristic — intentionally approximate
 * (this is a budgeting hint, not a billing surface). The estimate inspects
 * text-shaped blocks (`text`, `code`, `reasoning`, `json`, `xml`, `csv`,
 * `html`, `tool_result`) and ignores opaque media. A floor of 4 tokens
 * accounts for role/wrapper overhead the wire format adds.
 *
 * @see packages/core/src/jsx/components/token-budget.ts (v1 origin)
 */

import type { ContentBlock, TimelineEntry } from "@agentick/spec";
import { danglingToolIds, isDangling, isIntact, toolSpanEnd } from "@agentick/spec";

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

const CHARS_PER_TOKEN = 4;
const ENTRY_OVERHEAD = 4;

function blockCharCount(block: ContentBlock): number {
  switch (block.type) {
    case "text":
    case "code":
    case "reasoning":
    case "xml":
    case "csv":
    case "html": {
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text.length : 0;
    }
    case "json": {
      const data = (block as { data?: unknown; text?: unknown }).data;
      if (data !== undefined) {
        try {
          return JSON.stringify(data).length;
        } catch {
          return 0;
        }
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text.length : 0;
    }
    case "tool_result": {
      const content = (block as { content?: unknown }).content;
      if (typeof content === "string") return content.length;
      if (Array.isArray(content)) {
        let n = 0;
        for (const child of content) {
          if (child && typeof child === "object" && "type" in child) {
            n += blockCharCount(child as ContentBlock);
          }
        }
        return n;
      }
      return 0;
    }
    case "tool_use": {
      const input = (block as { input?: unknown }).input;
      if (input !== undefined) {
        try {
          return JSON.stringify(input).length;
        } catch {
          return 0;
        }
      }
      return 0;
    }
    default:
      return 0;
  }
}

export function getEntryTokens(entry: MessageTimelineEntry): number {
  let chars = 0;
  for (const block of entry.message.content) chars += blockCharCount(block);
  return Math.ceil(chars / CHARS_PER_TOKEN) + ENTRY_OVERHEAD;
}

// ============================================================================
// Built-in strategies
// ============================================================================

function truncateStrategy(
  entries: readonly MessageTimelineEntry[],
  effectiveBudget: number,
): CompactionResult {
  const kept: MessageTimelineEntry[] = [];
  const evicted: MessageTimelineEntry[] = [];
  let budget = effectiveBudget;
  for (let i = entries.length - 1; i >= 0; i--) {
    const tokens = getEntryTokens(entries[i]!);
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
): CompactionResult {
  const preserved = new Set<number>();
  let preservedTokens = 0;
  for (let i = 0; i < entries.length; i++) {
    if (preserveRoles.includes(entries[i]!.message.role)) {
      preserved.add(i);
      preservedTokens += getEntryTokens(entries[i]!);
    }
  }

  const remaining = effectiveBudget - preservedTokens;
  let budget = remaining;
  const keptCandidates = new Set<number>();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (preserved.has(i)) continue;
    const tokens = getEntryTokens(entries[i]!);
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
  } = options;

  if (strategy === "none" || entries.length === 0) {
    let total = 0;
    for (const e of entries) total += getEntryTokens(e);
    return { kept: entries, evicted: [], currentTokens: total };
  }

  const effectiveBudget = maxTokens - headroom;
  let totalTokens = 0;
  for (const e of entries) totalTokens += getEntryTokens(e);
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
    result = truncateStrategy(entries, effectiveBudget);
  } else {
    result = slidingWindowStrategy(entries, effectiveBudget, preserveRoles);
  }

  const intact = evictDanglingHalves(entries, result);
  let keptTokens = 0;
  for (const e of intact.kept) keptTokens += getEntryTokens(e);
  return { kept: intact.kept, evicted: intact.evicted, currentTokens: keptTokens };
}
