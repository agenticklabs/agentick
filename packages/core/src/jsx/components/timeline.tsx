/**
 * Timeline Component
 *
 * Renders conversation history with optional pending messages.
 *
 * @module tentickle/components
 */

import type { JSX } from "../jsx-runtime";
import type { COMTimelineEntry } from "../../com/types";
import type { ExecutionMessage } from "../../engine/execution-types";
import { User, Assistant } from "./messages";
import {
  useConversationHistory,
  useQueuedMessages,
  type ConversationHistoryOptions,
} from "../../state/hooks";
import { createContext, useContext } from "../../state/context";

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

// ============================================================================
// Timeline Context
// ============================================================================

/**
 * Context for sharing timeline data with descendant components.
 * Used by Timeline.Provider and consumed via useTimeline().
 */
const TimelineContext = createContext<TimelineContextValue | null>(null, "TimelineContext");

/**
 * Props for the Timeline component.
 */
export interface TimelineProps extends ConversationHistoryOptions {
  /**
   * Render prop for custom rendering.
   *
   * Receives two arguments:
   * - history: COMTimelineEntry[] - Executed timeline entries
   * - pending?: ExecutionMessage[] - Queued messages for next tick
   *
   * If not provided, uses default message rendering.
   *
   * @example
   * ```tsx
   * <Timeline>
   *   {(history, pending) => (
   *     <>
   *       {history.map(entry => <Message {...entry.message} />)}
   *       {pending?.length > 0 && (
   *         <System>Pending: {pending.length}</System>
   *       )}
   *     </>
   *   )}
   * </Timeline>
   * ```
   */
  children?: TimelineRenderFn;
}

// ============================================================================
// Default Message Renderer
// ============================================================================

/**
 * Default renderer for a single timeline entry.
 */
function DefaultMessage({
  entry,
}: {
  entry: COMTimelineEntry;
  key?: string | number;
}): JSX.Element {
  if (!entry.message) return <></>;

  const { role, content } = entry.message;

  // Extract text content
  const textContent = content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  if (!textContent) return <></>;

  switch (role) {
    case "user":
      return <User>{textContent}</User>;
    case "assistant":
      return <Assistant>{textContent}</Assistant>;
    default:
      // Tool messages, system, and others - skip in default rendering
      return <></>;
  }
}

// ============================================================================
// Timeline Component
// ============================================================================

/**
 * Renders conversation history from previous ticks with optional pending messages.
 *
 * By default, renders all messages using `<User>` and `<Assistant>` components.
 * Use the render prop for custom rendering, which receives both history and pending.
 *
 * @example Default usage (renders all messages)
 * ```tsx
 * const ChatAgent = ({ message }: Props) => (
 *   <>
 *     <Model model={claude} />
 *     <System>You are helpful.</System>
 *     <Timeline />
 *     <User>{message}</User>
 *   </>
 * );
 * ```
 *
 * @example With filtering
 * ```tsx
 * <Timeline
 *   roles={['user', 'assistant']}
 *   limit={10}
 * />
 * ```
 *
 * @example With render prop (history and pending)
 * ```tsx
 * <Timeline>
 *   {(history, pending) => (
 *     <>
 *       <TokenBudget maxTokens={10000}>
 *         {history.map((entry, i) => (
 *           <Message key={i} {...entry.message} />
 *         ))}
 *       </TokenBudget>
 *       {pending?.length > 0 && (
 *         <System>Pending: {pending.length}</System>
 *       )}
 *     </>
 *   )}
 * </Timeline>
 * ```
 */
export function Timeline(props: TimelineProps): JSX.Element {
  const history = useConversationHistory({
    filter: props.filter,
    limit: props.limit,
    roles: props.roles,
  });

  const pending = useQueuedMessages();

  // Render prop pattern - pass both history and pending
  if (typeof props.children === "function") {
    const result = props.children(history, pending);
    // Wrap the result in a fragment to ensure consistent return type
    return <>{result}</>;
  }

  // If children are provided but not a function, render them directly
  // This allows Timeline to work as a wrapper/Fragment
  if (props.children !== undefined) {
    return <>{props.children}</>;
  }

  // Default: render all messages from history
  // Note: useConversationHistory() already includes pending messages, so we
  // render them as part of history, not separately
  return (
    <>
      {history.map((entry, i) => (
        <DefaultMessage key={`timeline-${i}`} entry={entry} />
      ))}
    </>
  );
}

// ============================================================================
// Timeline.Provider
// ============================================================================

type TimelineProviderChild = JSX.Element | TimelineRenderFn;

interface TimelineProviderProps extends ConversationHistoryOptions {
  children: TimelineProviderChild | TimelineProviderChild[];
}

/**
 * Provider that exposes timeline context to descendants.
 *
 * Supports mixed children: regular components + render functions.
 * Use `useTimeline()` hook in child components to access context.
 *
 * @example Basic usage with components
 * ```tsx
 * <Timeline.Provider>
 *   <ConversationStats />
 *   <Timeline.Messages />
 * </Timeline.Provider>
 * ```
 *
 * @example Mixed: components + render function
 * ```tsx
 * <Timeline.Provider>
 *   <ConversationStats />
 *   {(history, pending) => history.map(entry => (
 *     <Message {...entry.message} />
 *   ))}
 * </Timeline.Provider>
 * ```
 *
 * @example With filtering options
 * ```tsx
 * <Timeline.Provider roles={['user', 'assistant']} limit={20}>
 *   {(history, pending) => history.map(entry => ...)}
 * </Timeline.Provider>
 * ```
 */
Timeline.Provider = function TimelineProvider(props: TimelineProviderProps): JSX.Element {
  const entries = useConversationHistory({
    filter: props.filter,
    limit: props.limit,
    roles: props.roles,
  });

  const pending = useQueuedMessages();

  const contextValue: TimelineContextValue = {
    entries,
    pending,
    messageCount: entries.filter((e) => e.message).length,
    byRole: (role) => entries.filter((e) => e.message?.role === role),
  };

  // Process children: render functions get called with entries and pending
  const childArray = Array.isArray(props.children) ? props.children : [props.children];
  const rendered = childArray.map((child) => {
    if (typeof child === "function") {
      return child(entries, pending);
    }
    return child;
  });

  return <TimelineContext.Provider value={contextValue}>{rendered}</TimelineContext.Provider>;
};

// ============================================================================
// Timeline.Messages
// ============================================================================

/**
 * Renders messages from Timeline.Provider context.
 *
 * Must be used inside `<Timeline.Provider>`.
 */
Timeline.Messages = function TimelineMessages(): JSX.Element {
  const context = useContext(TimelineContext);

  if (!context) {
    // Fallback: render from state directly (not inside Provider)
    const entries = useConversationHistory();
    return (
      <>
        {entries.map((entry, i) => (
          <DefaultMessage key={`timeline-${i}`} entry={entry} />
        ))}
      </>
    );
  }

  return (
    <>
      {context.entries.map((entry: COMTimelineEntry, i: number) => (
        <DefaultMessage key={`timeline-${i}`} entry={entry} />
      ))}
    </>
  );
};

// ============================================================================
// useTimeline (for use inside Timeline.Provider)
// ============================================================================

/**
 * Access timeline context from within Timeline.Provider.
 *
 * @returns Timeline context value including history, pending, and utility functions
 *
 * @example
 * ```tsx
 * const ConversationStats = () => {
 *   const { messageCount, pending, byRole } = useTimeline();
 *
 *   const userCount = byRole('user').length;
 *   const assistantCount = byRole('assistant').length;
 *
 *   return (
 *     <System>
 *       Conversation has {messageCount} messages
 *       ({userCount} from user, {assistantCount} from assistant).
 *       {pending.length > 0 && ` ${pending.length} pending.`}
 *     </System>
 *   );
 * };
 * ```
 */
export function useTimelineContext(): TimelineContextValue {
  const context = useContext(TimelineContext);

  if (!context) {
    // Fallback: create context from hooks (not inside Provider)
    const entries = useConversationHistory();
    const pending = useQueuedMessages();

    return {
      entries,
      pending,
      messageCount: entries.filter((e) => e.message).length,
      byRole: (role) => entries.filter((e) => e.message?.role === role),
    };
  }

  return context;
}
