/**
 * Timeline Component
 *
 * Renders conversation history with optional pending messages.
 * Supports token budget compaction via maxTokens/strategy props.
 * Uses React context to provide timeline access to descendants.
 *
 * @module agentick/components
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { JSX } from "react";
import type { COMTimelineEntry } from "../../com/types.js";
import type { ExecutionMessage } from "../../engine/execution-types.js";
import { useTickState } from "../../hooks/context.js";
import { compactEntries, type CompactionStrategy, type TokenBudgetInfo } from "./token-budget.js";
import { Logger } from "@agentick/kernel";
import { Entry } from "./primitives.js";
import type { ContentBlock, MessageRoles } from "../../content/index.js";

const log = Logger.for("Timeline");

// Helper for createElement
const h = React.createElement;

// ============================================================================
// Types
// ============================================================================

/**
 * Render function signature for Timeline component.
 *
 * @param history - Executed timeline entries (previous + current)
 * @param pending - Messages queued for the next tick
 * @param budget - Token budget info (present when maxTokens is set)
 */
export type TimelineRenderFn = (
  history: COMTimelineEntry[],
  pending: ExecutionMessage[],
  budget: TokenBudgetInfo | null,
) => JSX.Element | (JSX.Element | null)[] | null;

/**
 * Context value for Timeline provider.
 */
export interface TimelineContextValue {
  /** All timeline entries (history) */
  entries: COMTimelineEntry[];

  /** Pending messages queued for next tick */
  pending: ExecutionMessage[];

  /** Number of messages in timeline */
  messageCount: number;

  /** Filter entries by role */
  byRole: (role: "user" | "assistant" | "tool" | "system") => COMTimelineEntry[];

  /** Token budget info (present when maxTokens is set) */
  budget: TokenBudgetInfo | null;
}

/**
 * Conversation history options.
 */
export interface ConversationHistoryOptions {
  /** Filter function for entries */
  filter?: (entry: COMTimelineEntry) => boolean;

  /** Maximum number of entries to return */
  limit?: number;

  /** Only include these roles */
  roles?: ("user" | "assistant" | "tool" | "system" | "event")[];
}

/**
 * Token budget options for Timeline.
 */
export interface TimelineBudgetOptions {
  /** Maximum tokens for timeline entries. Enables compaction. */
  maxTokens?: number;

  /** Compaction strategy (default: "sliding-window") */
  strategy?: CompactionStrategy;

  /** Callback when entries are evicted */
  onEvict?: (entries: COMTimelineEntry[]) => void;

  /** Guidance string passed to custom compaction functions */
  guidance?: string;

  /** Roles that are never evicted (default: ["system"]) */
  preserveRoles?: Array<"user" | "assistant" | "system" | "tool">;

  /** Reserve tokens for safety margin (default: 0) */
  headroom?: number;
}

/**
 * Props for the Timeline component.
 */
export interface TimelineProps extends ConversationHistoryOptions, TimelineBudgetOptions {
  /**
   * Render prop for custom rendering.
   * If not provided, renders default message components.
   */
  children?: TimelineRenderFn | JSX.Element;
}

// ============================================================================
// React Context
// ============================================================================

const TimelineContext = createContext<TimelineContextValue | null>(null);

// ============================================================================
// Default Message Renderer
// ============================================================================

/**
 * Default renderer for a single timeline entry.
 *
 * Renders directly to the "entry" intrinsic element to avoid
 * React trying to render Agentick components that return Agentick elements.
 *
 * Passes through ALL content blocks (text, tool_use, tool_result, image, etc.)
 * so the model sees its own tool calls and results on subsequent ticks.
 */
function DefaultMessage({
  entry,
}: {
  entry: COMTimelineEntry;
  key?: string | number;
}): JSX.Element {
  if (!entry.message) return h(React.Fragment, null);

  const { role, content } = entry.message;

  if (!content || content.length === 0) return h(React.Fragment, null);

  if (role === "user" || role === "assistant" || role === "tool") {
    return h(Entry, {
      kind: "message",
      message: {
        role,
        content,
        id: entry.message.id,
      },
    });
  }

  // System and others - skip in default rendering
  return h(React.Fragment, null);
}

/**
 * Default renderer for a pending (queued) message.
 *
 * ExecutionMessage.content contains the actual Message object.
 * Passes through ALL content blocks (text, image, document, etc.)
 * so the model sees attachments on the first tick.
 */
function DefaultPendingMessage({
  message,
}: {
  message: ExecutionMessage;
  key?: string | number;
}): JSX.Element {
  const msg = message.content as { role: string; content: unknown[]; id?: string } | undefined;
  if (!msg) return h(React.Fragment, null);

  const { role, content } = msg;
  if (!Array.isArray(content) || content.length === 0) return h(React.Fragment, null);

  return h(Entry, {
    kind: "message",
    message: {
      role: role as MessageRoles,
      content: content as ContentBlock[],
      id: msg.id,
    },
  });
}

// ============================================================================
// Helper: Apply filtering to entries
// ============================================================================

function applyFilters(
  entries: COMTimelineEntry[],
  options: ConversationHistoryOptions,
): COMTimelineEntry[] {
  let filtered = entries;

  // Apply role filter
  if (options.roles && options.roles.length > 0) {
    const allowedRoles = options.roles as string[];
    filtered = filtered.filter((entry) => allowedRoles.includes(entry.message.role as string));
  }

  // Apply custom filter
  if (options.filter) {
    filtered = filtered.filter(options.filter);
  }

  // Apply limit (take from end to get most recent)
  if (options.limit && options.limit > 0 && filtered.length > options.limit) {
    filtered = filtered.slice(-options.limit);
  }

  return filtered;
}

// ============================================================================
// Timeline Component
// ============================================================================

/**
 * Renders conversation history from the COM timeline.
 *
 * @example Basic usage
 * ```tsx
 * <Timeline />
 * ```
 *
 * @example With filtering
 * ```tsx
 * <Timeline roles={['user', 'assistant']} limit={10} />
 * ```
 *
 * @example With token budget
 * ```tsx
 * <Timeline maxTokens={4000} strategy="truncate" />
 * ```
 *
 * @example With render prop
 * ```tsx
 * <Timeline maxTokens={8000} headroom={500}>
 *   {(entries) => entries.map(entry => <Message key={entry.id} entry={entry} />)}
 * </Timeline>
 * ```
 */
export function Timeline(props: TimelineProps): JSX.Element {
  // Get tickState from context (contains previous timeline and queued messages)
  let tickState: ReturnType<typeof useTickState> | null = null;
  try {
    tickState = useTickState();
  } catch {
    // Outside of AgentickProvider - return empty
  }

  // Get raw timeline entries from session's timeline (source of truth), apply filters
  const filteredEntries = useMemo(() => {
    const rawEntries = tickState?.timeline ?? [];
    if (rawEntries.length === 0) {
      log.debug({ tick: tickState?.tick }, "Timeline: No timeline entries available");
      return [];
    }
    log.debug(
      {
        tick: tickState?.tick,
        rawCount: rawEntries.length,
        roles: rawEntries.map((e) => e.message?.role),
      },
      "Timeline: Processing timeline",
    );
    return applyFilters(rawEntries, props);
  }, [tickState?.timeline, props.filter, props.limit, props.roles]);

  // Apply token budget compaction (when maxTokens is set)
  const { entries, evicted, budgetInfo } = useMemo(() => {
    if (props.maxTokens == null) {
      return { entries: filteredEntries, evicted: [] as COMTimelineEntry[], budgetInfo: null };
    }

    const result = compactEntries(filteredEntries, {
      maxTokens: props.maxTokens,
      strategy: props.strategy,
      headroom: props.headroom,
      preserveRoles: props.preserveRoles as string[] | undefined,
      guidance: props.guidance,
    });

    const info: TokenBudgetInfo = {
      maxTokens: props.maxTokens,
      effectiveBudget: props.maxTokens - (props.headroom ?? 0),
      currentTokens: result.currentTokens,
      evictedCount: result.evicted.length,
      isCompacted: result.evicted.length > 0,
    };

    return { entries: result.kept, evicted: result.evicted, budgetInfo: info };
  }, [
    filteredEntries,
    props.maxTokens,
    props.headroom,
    props.strategy,
    props.preserveRoles,
    props.guidance,
  ]);

  // Fire onEvict callback as an effect — not a side effect in memo
  const onEvictRef = useRef(props.onEvict);
  onEvictRef.current = props.onEvict;
  useEffect(() => {
    if (evicted.length > 0 && onEvictRef.current) {
      onEvictRef.current(evicted);
    }
  }, [evicted]);

  // Pending messages (queued for this tick)
  const pending = useMemo(() => {
    return (tickState?.queuedMessages ?? []) as ExecutionMessage[];
  }, [tickState?.queuedMessages]);

  log.debug(
    { entriesCount: entries.length, pendingCount: pending.length },
    "Timeline: Rendering with entries and pending",
  );

  // Render based on children type
  if (props.children !== undefined) {
    if (typeof props.children === "function") {
      // Render prop pattern
      const result = props.children(entries, pending, budgetInfo);
      return h(React.Fragment, null, result);
    }
    // Regular children
    return h(React.Fragment, null, props.children);
  }

  // Default rendering: render history AND pending messages
  return h(
    React.Fragment,
    null,
    // Render history entries
    ...entries.map((entry, index) =>
      h(DefaultMessage, { key: `history-${entry.id ?? index}`, entry }),
    ),
    // Render pending (queued) messages
    ...pending.map((message, index) =>
      h(DefaultPendingMessage, { key: `pending-${message.id ?? index}`, message }),
    ),
  );
}

// ============================================================================
// Timeline.Provider
// ============================================================================

interface TimelineProviderProps extends ConversationHistoryOptions {
  children: ReactNode;
  /** Override entries (useful for testing) */
  entries?: COMTimelineEntry[];
  /** Override pending messages */
  pending?: ExecutionMessage[];
}

/**
 * Provider that exposes timeline context to descendants.
 *
 * @example
 * ```tsx
 * <Timeline.Provider>
 *   <MyComponent />
 * </Timeline.Provider>
 * ```
 *
 * Children can then use:
 * ```tsx
 * const { entries, byRole } = useTimelineContext();
 * ```
 */
Timeline.Provider = function TimelineProvider(props: TimelineProviderProps): JSX.Element {
  // Get tickState from context if not overridden
  let tickState: ReturnType<typeof useTickState> | null = null;
  try {
    tickState = useTickState();
  } catch {
    // Outside of AgentickProvider
  }

  // Use provided entries or get from tickState.timeline (source of truth)
  const rawEntries = props.entries ?? tickState?.timeline ?? [];
  const pending = props.pending ?? ((tickState?.queuedMessages ?? []) as ExecutionMessage[]);

  // Apply filters
  const entries = useMemo(() => {
    return applyFilters(rawEntries, props);
  }, [rawEntries, props.filter, props.limit, props.roles]);

  // Create context value
  const contextValue = useMemo((): TimelineContextValue => {
    return {
      entries,
      pending,
      messageCount: entries.length,
      byRole: (role) => entries.filter((e) => e.message.role === role),
      budget: null,
    };
  }, [entries, pending]);

  return h(TimelineContext.Provider, { value: contextValue }, props.children);
};

// ============================================================================
// Timeline.Messages
// ============================================================================

interface TimelineMessagesProps {
  /** Custom renderer for each entry */
  renderEntry?: (entry: COMTimelineEntry, index: number) => JSX.Element | null;
}

/**
 * Renders messages from Timeline.Provider context.
 *
 * @example
 * ```tsx
 * <Timeline.Provider>
 *   <Timeline.Messages />
 * </Timeline.Provider>
 * ```
 *
 * @example With custom renderer
 * ```tsx
 * <Timeline.Provider>
 *   <Timeline.Messages
 *     renderEntry={(entry) => <CustomMessage entry={entry} />}
 *   />
 * </Timeline.Provider>
 * ```
 */
Timeline.Messages = function TimelineMessages(props: TimelineMessagesProps): JSX.Element {
  const context = useContext(TimelineContext);

  if (!context) {
    return h(React.Fragment, null);
  }

  const { entries, pending } = context;

  if (props.renderEntry) {
    return h(
      React.Fragment,
      null,
      entries.map((entry, index) => props.renderEntry!(entry, index)),
    );
  }

  // Default rendering: history + pending
  return h(
    React.Fragment,
    null,
    ...entries.map((entry, index) =>
      h(DefaultMessage, { key: `history-${entry.id ?? index}`, entry }),
    ),
    ...pending.map((message, index) =>
      h(DefaultPendingMessage, { key: `pending-${message.id ?? index}`, message }),
    ),
  );
};

// ============================================================================
// useTimelineContext
// ============================================================================

/**
 * Access timeline context from within Timeline.Provider.
 *
 * @example
 * ```tsx
 * function MessageCount() {
 *   const { messageCount, byRole } = useTimelineContext();
 *   const userMessages = byRole('user');
 *   return <div>User messages: {userMessages.length} / {messageCount}</div>;
 * }
 * ```
 */
export function useTimelineContext(): TimelineContextValue {
  const context = useContext(TimelineContext);
  if (!context) {
    throw new Error("useTimelineContext must be used within a Timeline.Provider");
  }
  return context;
}

/**
 * Access timeline context, returning null if not within provider.
 * Useful for optional timeline access.
 */
export function useTimelineContextOptional(): TimelineContextValue | null {
  return useContext(TimelineContext);
}

// ============================================================================
// useConversationHistory
// ============================================================================

/**
 * Get the full conversation history from the COM.
 *
 * This hook returns all timeline entries directly from the COM,
 * without needing to be within a Timeline.Provider.
 *
 * @example
 * ```tsx
 * function HistoryViewer() {
 *   const history = useConversationHistory();
 *   return (
 *     <div>
 *       {history.map(entry => (
 *         <div key={entry.id}>{entry.message.role}: ...</div>
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useConversationHistory(): COMTimelineEntry[] {
  // Get tickState from context
  let tickState: ReturnType<typeof useTickState> | null = null;
  try {
    tickState = useTickState();
  } catch {
    // Outside of AgentickProvider
    return [];
  }

  // Return timeline entries from session's timeline (source of truth)
  return tickState?.timeline ?? [];
}
