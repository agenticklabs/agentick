import { useMemo, useEffect, useSyncExternalStore, useCallback } from "react";
import {
  MessageSteering,
  type MessageSteeringOptions,
  type SteeringMode,
  type FlushMode,
  type MessageSteeringState,
} from "@agentick/client";
import type { ClientExecutionHandle, Message } from "@agentick/client";
import { useClient } from "./use-client";

export type { SteeringMode, FlushMode, MessageSteeringState };
export type UseMessageSteeringOptions = MessageSteeringOptions;

export interface UseMessageSteeringResult {
  /** Mode-aware send. If idle, sends immediately. If executing: "steer" mode sends concurrently, "queue" mode queues for later. */
  submit: (text: string) => void;
  /** Always sends immediately regardless of mode or execution state. */
  steer: (text: string) => void;
  /** Always queues regardless of mode or execution state. */
  queue: (text: string) => void;
  /** Abort the current execution and immediately send a new message. */
  interrupt: (text: string) => Promise<ClientExecutionHandle>;
  /** Messages waiting to be sent. */
  queued: readonly Message[];
  /** Flush queued messages. In "sequential" flushMode, sends one; in "batched", sends all. */
  flush: () => void;
  /** Remove a queued message by index. */
  removeQueued: (index: number) => void;
  /** Clear all queued messages without sending. */
  clearQueued: () => void;
  /** Current steering mode ("steer" | "queue"). Default: "steer". */
  mode: SteeringMode;
  /** Change the steering mode at runtime. */
  setMode: (mode: SteeringMode) => void;
  /** Whether an execution is currently in-flight. */
  isExecuting: boolean;
}

/**
 * Manage message submission with queuing, interruption, and steering.
 *
 * Wraps the client's `MessageSteering` controller as a React hook with
 * concurrent-safe state via `useSyncExternalStore`.
 *
 * Two steering modes control what `submit` does during an active execution:
 * - **"steer"** (default) — sends concurrently alongside the running execution.
 * - **"queue"** — buffers messages until the execution completes, then
 *   auto-flushes (one-at-a-time in "sequential" flushMode, all-at-once in "batched").
 *
 * `steer()`, `queue()`, and `interrupt()` bypass the mode and always do
 * exactly what their name says.
 *
 * @example Queue mode with sequential flush
 * ```tsx
 * import { useMessageSteering } from '@agentick/react';
 *
 * function Chat({ sessionId }: { sessionId: string }) {
 *   const { submit, queued, isExecuting } = useMessageSteering({
 *     sessionId,
 *     mode: 'queue',
 *     flushMode: 'sequential',
 *   });
 *
 *   return (
 *     <div>
 *       <button onClick={() => submit('Hello!')}>Send</button>
 *       {isExecuting && <span>Thinking...</span>}
 *       {queued.length > 0 && <span>{queued.length} queued</span>}
 *     </div>
 *   );
 * }
 * ```
 *
 * @example Using interrupt to cancel and redirect
 * ```tsx
 * function Chat({ sessionId }: { sessionId: string }) {
 *   const { submit, interrupt, isExecuting } = useMessageSteering({
 *     sessionId,
 *   });
 *
 *   const handleSend = (text: string) => {
 *     if (isExecuting) {
 *       interrupt(text); // Aborts current execution, sends new message
 *     } else {
 *       submit(text);
 *     }
 *   };
 *
 *   return <ChatInput onSubmit={handleSend} />;
 * }
 * ```
 */

const INITIAL_STATE: MessageSteeringState = {
  queued: [],
  isExecuting: false,
  mode: "steer",
};

export function useMessageSteering(
  options: UseMessageSteeringOptions = {},
): UseMessageSteeringResult {
  const client = useClient();

  const steering = useMemo(() => new MessageSteering(client, options), [client, options.sessionId]);

  useEffect(() => () => steering.destroy(), [steering]);

  const state = useSyncExternalStore(
    useCallback((cb) => steering.onStateChange(cb), [steering]),
    () => steering.state,
    () => INITIAL_STATE,
  );

  return {
    submit: useCallback((text: string) => steering.submit(text), [steering]),
    steer: useCallback((text: string) => steering.steer(text), [steering]),
    queue: useCallback((text: string) => steering.queue(text), [steering]),
    interrupt: useCallback((text: string) => steering.interrupt(text), [steering]),
    flush: useCallback(() => steering.flush(), [steering]),
    removeQueued: useCallback((i: number) => steering.removeQueued(i), [steering]),
    clearQueued: useCallback(() => steering.clearQueued(), [steering]),
    setMode: useCallback((m: SteeringMode) => steering.setMode(m), [steering]),
    queued: state.queued,
    isExecuting: state.isExecuting,
    mode: state.mode,
  };
}
