/**
 * `<Timeline>` — render persisted conversation history.
 *
 * Reads the session's timeline via `useTimeline()` (which subscribes to
 * the `TimelineBridge`'s version stamp). Each entry is emitted as
 * `<message role={entry.role}><content blocks={entry.content} /></message>`
 * — the `<content>` passthrough contributor folds the persisted spec-shape
 * blocks into the enclosing message's content array without requiring
 * authors to re-author each block as a JSX intrinsic.
 *
 * Optional token-budget compaction (`maxTokens`, `strategy`, `headroom`,
 * `preserveRoles`, `guidance`) drops entries that don't fit. The
 * render-prop form receives the kept entries and a `TokenBudgetInfo`
 * summary; the default form emits one message per kept entry.
 *
 * Notes vs. v1:
 *   - No `Timeline.Provider` / `Timeline.Messages` (premature abstraction)
 *   - No pending/queued message rendering — v2 has no equivalent surface
 *     on `TimelineBridge` yet. When that lands, extend in place.
 *   - No `useConversationHistory` — call `useTimeline()` directly.
 *
 * @see packages/core/src/jsx/components/timeline.tsx (v1 origin)
 */

import React, { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { JSX } from "react";
import type { ContentBlock, TimelineEntrySummary } from "@agentick/spec";
import { useTimeline } from "../hooks/use-timeline.js";
import { compactEntries, type CompactionStrategy, type TokenBudgetInfo } from "./token-budget.js";

const h = React.createElement;

// ============================================================================
// Types
// ============================================================================

export interface ConversationHistoryOptions {
  /** Custom predicate applied after role filtering. */
  readonly filter?: (entry: TimelineEntrySummary) => boolean;
  /** Cap the number of entries returned (newest preserved). */
  readonly limit?: number;
  /** Restrict to these roles. */
  readonly roles?: readonly string[];
}

export interface TimelineBudgetOptions {
  /** Maximum tokens for kept entries. Enables compaction when set. */
  readonly maxTokens?: number;
  /** Compaction algorithm. Default: `"sliding-window"`. */
  readonly strategy?: CompactionStrategy;
  /** Fired after render when entries are dropped. */
  readonly onEvict?: (entries: readonly TimelineEntrySummary[]) => void;
  /** Forwarded to custom compaction functions. */
  readonly guidance?: string;
  /** Roles never evicted by `sliding-window`. Default: `["system"]`. */
  readonly preserveRoles?: readonly string[];
  /** Reserve tokens for safety margin. Default: 0. */
  readonly headroom?: number;
}

export type TimelineRenderFn = (
  entries: readonly TimelineEntrySummary[],
  budget: TokenBudgetInfo | null,
) => ReactNode;

export interface TimelineProps extends ConversationHistoryOptions, TimelineBudgetOptions {
  /**
   * Either a render-prop function (receives kept entries + budget info)
   * or static JSX rendered after the default message stream.
   */
  readonly children?: TimelineRenderFn | ReactNode;
}

// ============================================================================
// Filtering
// ============================================================================

function applyFilters(
  entries: readonly TimelineEntrySummary[],
  options: ConversationHistoryOptions,
): readonly TimelineEntrySummary[] {
  let out: readonly TimelineEntrySummary[] = entries;
  if (options.roles && options.roles.length > 0) {
    const allowed = options.roles;
    out = out.filter((e) => allowed.includes(e.role));
  }
  if (options.filter) {
    out = out.filter(options.filter);
  }
  if (options.limit && options.limit > 0 && out.length > options.limit) {
    out = out.slice(-options.limit);
  }
  return out;
}

// ============================================================================
// Component
// ============================================================================

/**
 * @example default rendering
 * ```tsx
 * <Timeline />
 * ```
 *
 * @example role + limit
 * ```tsx
 * <Timeline roles={["user", "assistant"]} limit={20} />
 * ```
 *
 * @example token budget
 * ```tsx
 * <Timeline maxTokens={4000} strategy="truncate" headroom={250} />
 * ```
 *
 * @example render prop
 * ```tsx
 * <Timeline maxTokens={8000}>
 *   {(entries, budget) =>
 *     entries.map((e) => (
 *       <message key={e.id} role={e.role}>
 *         <content blocks={e.content} />
 *       </message>
 *     ))
 *   }
 * </Timeline>
 * ```
 */
export function Timeline(props: TimelineProps): JSX.Element {
  const snapshot = useTimeline();

  const filtered = useMemo(
    () => applyFilters(snapshot.entries, props),
    [snapshot.entries, props.filter, props.limit, props.roles],
  );

  const { kept, evicted, budget } = useMemo(() => {
    if (props.maxTokens == null) {
      return {
        kept: filtered,
        evicted: [] as readonly TimelineEntrySummary[],
        budget: null as TokenBudgetInfo | null,
      };
    }
    const result = compactEntries(filtered, {
      maxTokens: props.maxTokens,
      ...(props.strategy !== undefined ? { strategy: props.strategy } : {}),
      ...(props.headroom !== undefined ? { headroom: props.headroom } : {}),
      ...(props.preserveRoles !== undefined ? { preserveRoles: props.preserveRoles } : {}),
      ...(props.guidance !== undefined ? { guidance: props.guidance } : {}),
    });
    const info: TokenBudgetInfo = {
      maxTokens: props.maxTokens,
      effectiveBudget: props.maxTokens - (props.headroom ?? 0),
      currentTokens: result.currentTokens,
      evictedCount: result.evicted.length,
      isCompacted: result.evicted.length > 0,
    };
    return { kept: result.kept, evicted: result.evicted, budget: info };
  }, [
    filtered,
    props.maxTokens,
    props.headroom,
    props.strategy,
    props.preserveRoles,
    props.guidance,
  ]);

  // Fire onEvict as an effect — render must stay pure.
  const onEvictRef = useRef(props.onEvict);
  onEvictRef.current = props.onEvict;
  useEffect(() => {
    if (evicted.length > 0 && onEvictRef.current) {
      onEvictRef.current(evicted);
    }
  }, [evicted]);

  if (typeof props.children === "function") {
    return h(React.Fragment, null, (props.children as TimelineRenderFn)(kept, budget));
  }

  return h(
    React.Fragment,
    null,
    ...kept.map((entry, i) => renderEntry(entry, i)),
    props.children !== undefined ? props.children : null,
  );
}

function renderEntry(entry: TimelineEntrySummary, index: number): React.ReactElement {
  const key = entry.id ?? `entry-${index}`;
  const blocks = entry.content as readonly ContentBlock[];
  return internalIntrinsic(
    "message",
    { key, role: entry.role, id: entry.id },
    internalIntrinsic("content", { blocks }),
  );
}

/**
 * Centralized type-cast for emitting v2 host intrinsics React's
 * IntrinsicElements doesn't (yet) declare. Mirrors `format-scope.tsx`.
 */
function internalIntrinsic(
  type: string,
  props: Readonly<Record<string, unknown>>,
  ...children: React.ReactNode[]
): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return React.createElement(type as any, props, ...children);
}
