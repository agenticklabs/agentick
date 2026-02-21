/**
 * Token Budget — Compaction utilities for timeline entries.
 *
 * Pure functions and types for managing token budgets. No components,
 * no contexts, no hooks. Used internally by Timeline when budget
 * props (maxTokens, strategy, etc.) are provided.
 *
 * Uses `.tokens` field from token estimation when available,
 * falls back to char/4 heuristic.
 */

import type { COMTimelineEntry } from "../../com/types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Compaction strategy for handling token budget overflow.
 *
 * - `"none"`: No compaction, entries pass through unchanged
 * - `"truncate"`: Keep newest entries that fit within budget
 * - `"sliding-window"`: Preserve specific roles, then fill remaining budget with newest entries
 * - Custom function: Full control over compaction logic
 */
export type CompactionStrategy = "none" | "truncate" | "sliding-window" | CompactionFunction;

/**
 * Custom compaction function signature.
 */
export type CompactionFunction = (
  entries: COMTimelineEntry[],
  budget: { maxTokens: number; currentTokens: number },
  guidance?: string,
) => CompactionResult;

/**
 * Result from a compaction operation.
 */
export interface CompactionResult {
  kept: COMTimelineEntry[];
  evicted: COMTimelineEntry[];
}

/**
 * Token budget info exposed via TimelineContextValue.
 */
export interface TokenBudgetInfo {
  /** Configured max tokens */
  maxTokens: number;
  /** Effective budget after headroom */
  effectiveBudget: number;
  /** Current token count of kept entries */
  currentTokens: number;
  /** Number of entries evicted */
  evictedCount: number;
  /** Whether compaction was applied */
  isCompacted: boolean;
}

// ============================================================================
// Token Helpers
// ============================================================================

/** Get token count for an entry. Uses .tokens field if available, falls back to char/4. */
export function getEntryTokens(entry: COMTimelineEntry): number {
  if (entry.tokens != null) return entry.tokens;

  // Fallback: char/4 estimate
  let charCount = 0;
  for (const block of entry.message.content) {
    if (block.type === "text" && "text" in block) {
      charCount += (block as any).text.length;
    } else if (block.type === "code" && "text" in block) {
      charCount += (block as any).text.length;
    } else if (block.type === "tool_result" && "content" in block) {
      const nested = (block as any).content;
      if (typeof nested === "string") {
        charCount += nested.length;
      } else if (Array.isArray(nested)) {
        for (const c of nested) {
          if (c.type === "text" && c.text) charCount += c.text.length;
        }
      }
    }
  }
  return Math.ceil(charCount / 4) + 4;
}

// ============================================================================
// Built-in Strategies
// ============================================================================

function truncateStrategy(entries: COMTimelineEntry[], effectiveBudget: number): CompactionResult {
  const kept: COMTimelineEntry[] = [];
  const evicted: COMTimelineEntry[] = [];
  let budget = effectiveBudget;

  // Iterate newest→oldest, keep what fits
  for (let i = entries.length - 1; i >= 0; i--) {
    const tokens = getEntryTokens(entries[i]);
    if (budget >= tokens) {
      kept.unshift(entries[i]);
      budget -= tokens;
    } else {
      evicted.unshift(entries[i]);
    }
  }

  return { kept, evicted };
}

function slidingWindowStrategy(
  entries: COMTimelineEntry[],
  effectiveBudget: number,
  preserveRoles: string[],
): CompactionResult {
  // Pass 1: Reserve tokens for preserved-role entries
  let preservedTokens = 0;
  const preserved = new Set<number>();
  for (let i = 0; i < entries.length; i++) {
    if (preserveRoles.includes(entries[i].message.role as string)) {
      preserved.add(i);
      preservedTokens += getEntryTokens(entries[i]);
    }
  }

  const remainingBudget = effectiveBudget - preservedTokens;

  // Pass 2: From candidates (not preserved), keep newest that fit
  const candidateIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (!preserved.has(i)) candidateIndices.push(i);
  }

  let budget = remainingBudget;
  const keptCandidates = new Set<number>();

  // Newest first
  for (let i = candidateIndices.length - 1; i >= 0; i--) {
    const idx = candidateIndices[i];
    const tokens = getEntryTokens(entries[idx]);
    if (budget >= tokens) {
      keptCandidates.add(idx);
      budget -= tokens;
    }
  }

  // Merge in original order
  const kept: COMTimelineEntry[] = [];
  const evicted: COMTimelineEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (preserved.has(i) || keptCandidates.has(i)) {
      kept.push(entries[i]);
    } else {
      evicted.push(entries[i]);
    }
  }

  return { kept, evicted };
}

// ============================================================================
// Compaction entry point
// ============================================================================

export interface CompactOptions {
  maxTokens: number;
  strategy?: CompactionStrategy;
  headroom?: number;
  preserveRoles?: string[];
  guidance?: string;
}

export interface CompactResult {
  kept: COMTimelineEntry[];
  evicted: COMTimelineEntry[];
  currentTokens: number;
}

/**
 * Apply token budget compaction to a set of entries.
 *
 * Pure function — no side effects, no React, no hooks.
 */
export function compactEntries(
  entries: COMTimelineEntry[],
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
    const total = entries.reduce((sum, e) => sum + getEntryTokens(e), 0);
    return { kept: entries, evicted: [], currentTokens: total };
  }

  const effectiveBudget = maxTokens - headroom;

  // Check if already within budget
  const totalTokens = entries.reduce((sum, e) => sum + getEntryTokens(e), 0);
  if (totalTokens <= effectiveBudget) {
    return { kept: entries, evicted: [], currentTokens: totalTokens };
  }

  // Apply strategy
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
    // sliding-window (default)
    result = slidingWindowStrategy(entries, effectiveBudget, preserveRoles);
  }

  const keptTokens = result.kept.reduce((sum, e) => sum + getEntryTokens(e), 0);
  return { kept: result.kept, evicted: result.evicted, currentTokens: keptTokens };
}
