import { useMemo, useEffect, useSyncExternalStore, useCallback } from "react";
import {
  ChatSession,
  type ChatSessionOptions,
  type ChatSessionState,
  type ChatMode,
  type ChatMessage,
  type ToolConfirmationState,
  type SteeringMode,
} from "@agentick/client";
import type { ToolConfirmationResponse, Message, ClientExecutionHandle } from "@agentick/client";
import { useClient } from "./use-client";

export type { ChatMode, ChatMessage, ToolConfirmationState };
export type UseChatOptions<TMode extends string = ChatMode> = ChatSessionOptions<TMode>;

export interface UseChatResult<TMode extends string = ChatMode> {
  messages: readonly ChatMessage[];
  chatMode: TMode;
  toolConfirmation: ToolConfirmationState | null;
  lastSubmitted: string | null;
  queued: readonly Message[];
  isExecuting: boolean;
  mode: SteeringMode;

  submit: (text: string) => void;
  steer: (text: string) => void;
  queue: (text: string) => void;
  interrupt: (text: string) => Promise<ClientExecutionHandle>;
  flush: () => void;
  removeQueued: (index: number) => void;
  clearQueued: () => void;
  setMode: (mode: SteeringMode) => void;
  respondToConfirmation: (response: ToolConfirmationResponse) => void;
  clearMessages: () => void;
}

const INITIAL_STATE: ChatSessionState = {
  messages: [],
  chatMode: "idle",
  toolConfirmation: null,
  lastSubmitted: null,
  queued: [],
  isExecuting: false,
  mode: "steer",
};

/**
 * Full chat controller hook — messages, steering, and tool confirmations.
 *
 * Wraps `ChatSession` with `useSyncExternalStore` for concurrent-safe React state.
 *
 * Options like `transform`, `confirmationPolicy`, and `deriveMode` are captured
 * at mount time. Changing them requires a new `sessionId` to take effect.
 */
export function useChat<TMode extends string = ChatMode>(
  options: UseChatOptions<TMode> = {} as UseChatOptions<TMode>,
): UseChatResult<TMode> {
  const client = useClient();

  const session = useMemo(
    () => new ChatSession<TMode>(client, options),
    [client, options.sessionId],
  );

  useEffect(() => () => session.destroy(), [session]);

  const state = useSyncExternalStore(
    useCallback((cb) => session.onStateChange(cb), [session]),
    () => session.state,
    () => INITIAL_STATE as ChatSessionState<TMode>,
  );

  return {
    ...state,
    submit: useCallback((t: string) => session.submit(t), [session]),
    steer: useCallback((t: string) => session.steer(t), [session]),
    queue: useCallback((t: string) => session.queue(t), [session]),
    interrupt: useCallback((t: string) => session.interrupt(t), [session]),
    flush: useCallback(() => session.flush(), [session]),
    removeQueued: useCallback((i: number) => session.removeQueued(i), [session]),
    clearQueued: useCallback(() => session.clearQueued(), [session]),
    setMode: useCallback((m: SteeringMode) => session.setMode(m), [session]),
    respondToConfirmation: useCallback(
      (r: ToolConfirmationResponse) => session.respondToConfirmation(r),
      [session],
    ),
    clearMessages: useCallback(() => session.clearMessages(), [session]),
  };
}
