import { useMemo, useEffect, useSyncExternalStore, useCallback } from "react";
import {
  ChatSession,
  type ChatSessionOptions,
  type ChatSessionState,
  type ChatMode,
  type ChatMessage,
  type ToolConfirmationState,
  type SteeringMode,
  type Attachment,
  type AttachmentInput,
} from "@agentick/client";
import type { ToolConfirmationResponse, Message, ClientExecutionHandle } from "@agentick/client";
import { useClient } from "./use-client";

export type { ChatMode, ChatMessage, ToolConfirmationState, Attachment, AttachmentInput };
export type UseChatOptions<TMode extends string = ChatMode> = ChatSessionOptions<TMode>;

export interface UseChatResult<TMode extends string = ChatMode> {
  messages: readonly ChatMessage[];
  chatMode: TMode;
  toolConfirmation: ToolConfirmationState | null;
  lastSubmitted: string | null;
  queued: readonly Message[];
  isExecuting: boolean;
  mode: SteeringMode;
  /** Error from the most recent execution failure (null on success or abort) */
  error: { message: string; name: string } | null;
  attachments: readonly Attachment[];

  submit: (text: string) => void;
  steer: (text: string) => void;
  queue: (text: string) => void;
  interrupt: (text: string) => Promise<ClientExecutionHandle>;
  abort: (reason?: string) => void;
  flush: () => void;
  removeQueued: (index: number) => void;
  clearQueued: () => void;
  setMode: (mode: SteeringMode) => void;
  respondToConfirmation: (response: ToolConfirmationResponse) => void;
  clearMessages: () => void;
  addAttachment: (input: AttachmentInput) => Attachment;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
}

const INITIAL_STATE: ChatSessionState = {
  messages: [],
  chatMode: "idle",
  toolConfirmation: null,
  lastSubmitted: null,
  queued: [],
  isExecuting: false,
  mode: "steer",
  error: null,
  attachments: [],
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
    abort: useCallback((r?: string) => session.abort(r), [session]),
    flush: useCallback(() => session.flush(), [session]),
    removeQueued: useCallback((i: number) => session.removeQueued(i), [session]),
    clearQueued: useCallback(() => session.clearQueued(), [session]),
    setMode: useCallback((m: SteeringMode) => session.setMode(m), [session]),
    respondToConfirmation: useCallback(
      (r: ToolConfirmationResponse) => session.respondToConfirmation(r),
      [session],
    ),
    clearMessages: useCallback(() => session.clearMessages(), [session]),
    addAttachment: useCallback(
      (input: AttachmentInput) => session.attachments.add(input),
      [session],
    ),
    removeAttachment: useCallback((id: string) => session.attachments.remove(id), [session]),
    clearAttachments: useCallback(() => session.attachments.clear(), [session]),
  };
}
