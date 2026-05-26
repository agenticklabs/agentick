/**
 * `<Timeline>` — render persisted conversation history.
 *
 * Reads the session's timeline via `useTimeline()` (which subscribes to
 * the TimelineHarness's projection version stamp). Each `message`-kind
 * entry is emitted as `<Message {...entry.message} />`; other entry
 * kinds (future state-change records, subscription receipts) are
 * filtered out — they're not part of the model-visible conversation.
 *
 * Optional token-budget compaction (`maxTokens`, `strategy`, `headroom`,
 * `preserveRoles`, `guidance`) drops entries that don't fit. The
 * render-prop form receives the kept entries and a `TokenBudgetInfo`
 * summary; the default form emits one message per kept entry.
 *
 * Notes vs. v1:
 *   - No `Timeline.Provider` / `Timeline.Messages` (premature abstraction)
 *   - No pending/queued message rendering — v2 has no equivalent surface
 *     on the TimelineHarness yet. When that lands, extend in place.
 *   - No `useConversationHistory` — call `useTimeline()` directly.
 *
 * @see packages/core/src/jsx/components/timeline.tsx (v1 origin)
 */

import React, { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { JSX } from "react";
import type { TimelineEntry } from "@agentick/spec";
import { useTimeline } from "./use-timeline.js";
import { Message } from "@agentick/reconciler-react";
import { compactEntries, type CompactionStrategy, type TokenBudgetInfo } from "./token-budget.js";

const h = React.createElement;

// ============================================================================
// Types
// ============================================================================

/**
 * Type narrowing helper — the only entry kind in the timeline today.
 * Future kinds (state-change records, subscription receipts) will get
 * their own contributors; `<Timeline>` only renders messages.
 */
type MessageTimelineEntry = Extract<TimelineEntry, { kind: "message" }>;

export interface ConversationHistoryOptions {
  /** Custom predicate applied after role filtering. */
  readonly filter?: (entry: MessageTimelineEntry) => boolean;
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
  readonly onEvict?: (entries: readonly MessageTimelineEntry[]) => void;
  /** Forwarded to custom compaction functions. */
  readonly guidance?: string;
  /** Roles never evicted by `sliding-window`. Default: `["system"]`. */
  readonly preserveRoles?: readonly string[];
  /** Reserve tokens for safety margin. Default: 0. */
  readonly headroom?: number;
}

export type TimelineRenderFn = (
  entries: readonly MessageTimelineEntry[],
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
  entries: readonly MessageTimelineEntry[],
  options: ConversationHistoryOptions,
): readonly MessageTimelineEntry[] {
  let out: readonly MessageTimelineEntry[] = entries;
  if (options.roles && options.roles.length > 0) {
    const allowed = options.roles;
    out = out.filter((e) => allowed.includes(e.message.role));
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
 *       <message key={e.message.id} role={e.message.role}>
 *         <content blocks={e.message.content} />
 *       </message>
 *     ))
 *   }
 * </Timeline>
 * ```
 */
export function Timeline(props: TimelineProps): JSX.Element {
  const snapshot = useTimeline();

  // Restrict to message entries — Timeline doesn't render non-message
  // kinds. Drop entries flagged `visibility: "log"` (journaled but not
  // for any render). `"observer"` is kept here — UI shows it; the
  // formatter filters it out for model context separately.
  const messageEntries = useMemo<readonly MessageTimelineEntry[]>(
    () =>
      snapshot.entries.filter(
        (e): e is MessageTimelineEntry => e.kind === "message" && e.visibility !== "log",
      ),
    [snapshot.entries],
  );

  const filtered = useMemo(
    () => applyFilters(messageEntries, props),
    [messageEntries, props.filter, props.limit, props.roles],
  );

  const { kept, evicted, budget } = useMemo(() => {
    if (props.maxTokens == null) {
      return {
        kept: filtered,
        evicted: [] as readonly MessageTimelineEntry[],
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
    ...kept.map((entry, i) =>
      h(Message, { key: entry.message.id ?? `entry-${i}`, ...entry.message }),
    ),
    props.children !== undefined ? props.children : null,
  );
}
