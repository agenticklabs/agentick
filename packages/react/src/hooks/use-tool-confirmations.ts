import { useMemo, useEffect, useSyncExternalStore, useCallback } from "react";
import {
  ToolConfirmations,
  type ToolConfirmationsOptions,
  type ToolConfirmationsState,
  type ToolConfirmationState,
} from "@agentick/client";
import type { ToolConfirmationResponse } from "@agentick/client";
import { useClient } from "./use-client.js";

export type UseToolConfirmationsOptions = ToolConfirmationsOptions;

export interface UseToolConfirmationsResult {
  pending: ToolConfirmationState | null;
  respond: (response: ToolConfirmationResponse) => void;
}

const INITIAL_STATE: ToolConfirmationsState = {
  pending: null,
};

/**
 * Tool confirmation hook — wraps `ToolConfirmations` with `useSyncExternalStore`.
 *
 * Use standalone for custom confirmation UIs, or use `useChat` for the full
 * chat controller (messages + steering + confirmations).
 */
export function useToolConfirmations(
  options: UseToolConfirmationsOptions = {},
): UseToolConfirmationsResult {
  const client = useClient();

  const tc = useMemo(() => new ToolConfirmations(client, options), [client, options.sessionId]);

  useEffect(() => () => tc.destroy(), [tc]);

  const state = useSyncExternalStore(
    useCallback((cb) => tc.onStateChange(cb), [tc]),
    () => tc.state,
    () => INITIAL_STATE,
  );

  return {
    pending: state.pending,
    respond: useCallback((r: ToolConfirmationResponse) => tc.respond(r), [tc]),
  };
}
