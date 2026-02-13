import { useState, useEffect } from "react";
import type { ConnectionState } from "@agentick/client";
import { useClient } from "./use-client";
import type { UseConnectionOptions, UseConnectionResult } from "../types";

// ============================================================================
// useConnectionState (alias for useConnection)
// ============================================================================

/**
 * Subscribe to connection state changes.
 *
 * @example
 * ```tsx
 * import { useConnectionState } from '@agentick/react';
 *
 * function ConnectionIndicator() {
 *   const state = useConnectionState();
 *
 *   return (
 *     <div className={`indicator ${state}`}>
 *       {state === 'connected' ? 'Online' : 'Offline'}
 *     </div>
 *   );
 * }
 * ```
 */
export function useConnectionState(): ConnectionState {
  const client = useClient();
  const [state, setState] = useState<ConnectionState>(client.state);

  useEffect(() => {
    // Sync initial state
    setState(client.state);

    // Subscribe to changes
    const unsubscribe = client.onConnectionChange(setState);
    return unsubscribe;
  }, [client]);

  return state;
}

// ============================================================================
// useConnection
// ============================================================================

/**
 * Read the SSE connection state.
 */
export function useConnection(_options: UseConnectionOptions = {}): UseConnectionResult {
  const client = useClient();
  const [state, setState] = useState<ConnectionState>(client.state);

  useEffect(() => {
    setState(client.state);
    return client.onConnectionChange(setState);
  }, [client]);

  return {
    state,
    isConnected: state === "connected",
    isConnecting: state === "connecting",
  };
}
