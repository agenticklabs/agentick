import { useMemo, useEffect, useSyncExternalStore, useCallback } from "react";
import {
  MessageLog,
  type MessageLogOptions,
  type MessageLogState,
  type ChatMessage,
} from "@agentick/client";
import { useClient } from "./use-client";

export type UseMessagesOptions = MessageLogOptions;

export interface UseMessagesResult {
  messages: readonly ChatMessage[];
  clear: () => void;
}

const INITIAL_STATE: MessageLogState = {
  messages: [],
};

/**
 * Message accumulation hook — wraps `MessageLog` with `useSyncExternalStore`.
 *
 * Use standalone for message-only UIs, or use `useChat` for the full
 * chat controller (messages + steering + confirmations).
 */
export function useMessages(options: UseMessagesOptions = {}): UseMessagesResult {
  const client = useClient();

  const log = useMemo(() => new MessageLog(client, options), [client, options.sessionId]);

  useEffect(() => () => log.destroy(), [log]);

  const state = useSyncExternalStore(
    useCallback((cb) => log.onStateChange(cb), [log]),
    () => log.state,
    () => INITIAL_STATE,
  );

  return {
    messages: state.messages,
    clear: useCallback(() => log.clear(), [log]),
  };
}
