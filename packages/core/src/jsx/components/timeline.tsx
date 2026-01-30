/**
 * Timeline Component
 *
 * Renders conversation history with optional pending messages.
 * Uses React context to provide timeline access to descendants.
 *
 * @module tentickle/components
 */

import React, { createContext, useContext, useMemo, type ReactNode } from "react";
import type { JSX } from "react";
import type { COMTimelineEntry } from "../../com/types";
import type { ExecutionMessage } from "../../engine/execution-types";
import { useTickState } from "../../hooks/context";
import { Logger } from "../../core/logger";

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
 * @param pending - Messages queued for the next tick (optional)
 */
export type TimelineRenderFn = (
  history: COMTimelineEntry[],
  pending?: ExecutionMessage[],
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
 * Props for the Timeline component.
 */
export interface TimelineProps extends ConversationHistoryOptions {
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
 * React trying to render Tentickle components that return Tentickle elements.
 */
function DefaultMessage({
  entry,
}: {
  entry: COMTimelineEntry;
  key?: string | number;
}): JSX.Element {
  if (!entry.message) return h(React.Fragment, null);

  const { role, content } = entry.message;

  // Extract text content
  const textContent = content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  if (!textContent) return h(React.Fragment, null);

  // Render the "entry" intrinsic element directly
  // This avoids going through User/Assistant which return Tentickle elements
  if (role === "user" || role === "assistant" || role === "tool") {
    return h("entry", {
      kind: "message",
      message: {
        role,
        content: [{ type: "text", text: textContent }],
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
 */
function DefaultPendingMessage({
  message,
}: {
  message: ExecutionMessage;
  key?: string | number;
}): JSX.Element {
  // The content is the actual Message object
  const msg = message.content as { role: string; content: unknown[] } | undefined;
  if (!msg) return h(React.Fragment, null);

  const { role, content } = msg;
  if (!Array.isArray(content)) return h(React.Fragment, null);

  // Extract text content
  const textContent = content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
    )
    .map((block) => block.text)
    .join("\n");

  if (!textContent) return h(React.Fragment, null);

  // Render the "entry" intrinsic element
  return h("entry", {
    kind: "message",
    message: {
      role,
      content: [{ type: "text", text: textContent }],
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
 * <Timeline>
 *   {(entries) => entries.map(entry => <Message key={entry.id} entry={entry} />)}
 * </Timeline>
 * ```
 *
 * @example With filtering
 * ```tsx
 * <Timeline roles={['user', 'assistant']} limit={10}>
 *   {(entries) => entries.map(entry => ...)}
 * </Timeline>
 * ```
 */
export function Timeline(props: TimelineProps): JSX.Element {
  // Get tickState from context (contains previous timeline and queued messages)
  let tickState: ReturnType<typeof useTickState> | null = null;
  try {
    tickState = useTickState();
  } catch {
    // Outside of TentickleProvider - return empty
  }

  // Get and filter timeline entries from tickState.previous (conversation history)
  const entries = useMemo(() => {
    if (!tickState?.previous?.timeline) {
      log.debug(
        { tick: tickState?.tick, hasPrevious: !!tickState?.previous },
        "Timeline: No previous timeline available",
      );
      return [];
    }
    const rawEntries = tickState.previous.timeline as COMTimelineEntry[];
    log.debug(
      {
        tick: tickState.tick,
        rawCount: rawEntries.length,
        roles: rawEntries.map((e) => e.message?.role),
      },
      "Timeline: Processing previous timeline",
    );
    return applyFilters(rawEntries, props);
  }, [tickState?.previous?.timeline, props.filter, props.limit, props.roles]);

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
      const result = props.children(entries, pending);
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
    // Outside of TentickleProvider
  }

  // Use provided entries or get from tickState.previous.timeline
  const rawEntries = props.entries ?? ((tickState?.previous?.timeline ?? []) as COMTimelineEntry[]);
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
    // Outside of TentickleProvider
    return [];
  }

  // Return timeline entries from tickState.previous
  return (tickState?.previous?.timeline ?? []) as COMTimelineEntry[];
}
