/**
 * V2 Message Context
 *
 * Provides message handling capabilities to components.
 * This enables components to react to incoming messages and queue outgoing messages.
 *
 * Architecture:
 * - The React tree stays mounted across ticks (persistent)
 * - Components can register message handlers that are called when messages arrive
 * - Components can queue messages for the next tick
 * - The runtime drains the queue when entering a tick
 */

import React, {
  createContext,
  useContext,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import type { ExecutionMessage } from "../engine/execution-types";
import type { COM } from "../com/object-model";
import type { TickState } from "../component/component";
import { useTickState } from "./context";

// Helper for createElement
const h = React.createElement;

// ============================================================
// Types
// ============================================================

/**
 * Message handler signature - matches v1 API.
 * @param com - The Context Object Model
 * @param message - The message that was received
 * @param state - The current tick state
 */
export type MessageHandler = (
  com: COM,
  message: ExecutionMessage,
  state: TickState,
) => void | Promise<void>;

// ============================================================
// Message Store (per-session)
// ============================================================

export interface MessageStore {
  /** Queued messages */
  queue: ExecutionMessage[];

  /** Message handlers - just the handler functions */
  handlers: Set<MessageHandler>;

  /** Last received message */
  lastMessage: ExecutionMessage | null;

  /** Subscribers for state changes */
  subscribers: Set<() => void>;

  /** Current COM reference (set by compiler) */
  com: COM | null;

  /** Current TickState reference (set by compiler) */
  tickState: TickState | null;
}

export function createMessageStore(): MessageStore {
  return {
    queue: [],
    handlers: new Set(),
    lastMessage: null,
    subscribers: new Set(),
    com: null,
    tickState: null,
  };
}

// ============================================================
// Context Types
// ============================================================

export interface MessageContextValue {
  /** Queue a message for the next tick */
  queueMessage: (message: ExecutionMessage) => void;

  /** Get all queued messages */
  getQueuedMessages: () => ExecutionMessage[];

  /** Clear the queue and return all messages */
  drainQueue: () => ExecutionMessage[];

  /** Register a message handler */
  addMessageHandler: (handler: MessageHandler) => () => void;

  /** Last received message */
  lastMessage: ExecutionMessage | null;
}

// ============================================================
// React Context
// ============================================================

const MessageContext = createContext<MessageContextValue | null>(null);

/**
 * Provider for message context.
 */
export function MessageProvider({
  store,
  children,
}: {
  store: MessageStore;
  children?: ReactNode; // Optional since React.createElement can pass it as third arg
}): React.ReactElement {
  // Stable reference to store operations
  const queueMessage = useCallback(
    (message: ExecutionMessage) => {
      store.queue.push(message);
      // Notify subscribers
      for (const sub of store.subscribers) {
        sub();
      }
    },
    [store],
  );

  const getQueuedMessages = useCallback(() => [...store.queue], [store]);

  const drainQueue = useCallback(() => {
    const messages = store.queue;
    store.queue = [];
    return messages;
  }, [store]);

  const addMessageHandler = useCallback(
    (handler: MessageHandler) => {
      store.handlers.add(handler);
      return () => {
        store.handlers.delete(handler);
      };
    },
    [store],
  );

  const value: MessageContextValue = {
    queueMessage,
    getQueuedMessages,
    drainQueue,
    addMessageHandler,
    lastMessage: store.lastMessage,
  };

  return h(MessageContext.Provider, { value }, children);
}

// ============================================================
// Hooks
// ============================================================

/**
 * Get the message context.
 */
export function useMessageContext(): MessageContextValue {
  const ctx = useContext(MessageContext);
  if (!ctx) {
    throw new Error("useMessageContext must be used within a MessageProvider");
  }
  return ctx;
}

/**
 * Register a handler for incoming messages.
 *
 * The handler receives (com, message, state) matching the v1 API.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   useOnMessage((com, message, state) => {
 *     console.log('Received:', message);
 *   });
 *   return <System>I respond to messages</System>;
 * }
 * ```
 */
export function useOnMessage(handler: MessageHandler): void {
  const ctx = useContext(MessageContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!ctx) return;

    // Create a stable wrapper that always calls the latest handler
    const wrappedHandler: MessageHandler = (com, message, state) => {
      return handlerRef.current(com, message, state);
    };

    const cleanup = ctx.addMessageHandler(wrappedHandler);

    return () => {
      cleanup();
    };
  }, [ctx]);
}

/**
 * Get the queue of pending messages for this tick.
 *
 * Returns messages queued for this tick from tickState.queuedMessages.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const queuedMessages = useQueuedMessages();
 *
 *   return (
 *     <div>
 *       {queuedMessages.map((msg, i) => (
 *         <span key={i}>{msg.type}</span>
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useQueuedMessages(): ExecutionMessage[] {
  try {
    const tickState = useTickState();
    return (tickState?.queuedMessages ?? []) as ExecutionMessage[];
  } catch {
    // Fallback to message context queue if outside TentickleProvider
    const ctx = useContext(MessageContext);
    return ctx?.getQueuedMessages() ?? [];
  }
}

/**
 * Get the last received message.
 */
export function useLastMessage(): ExecutionMessage | null {
  const ctx = useContext(MessageContext);
  return ctx?.lastMessage ?? null;
}
