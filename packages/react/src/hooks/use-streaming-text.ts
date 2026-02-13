import { useSyncExternalStore, useCallback } from "react";
import type { StreamingTextState } from "@agentick/client";
import { useClient } from "./use-client";
import type { UseStreamingTextOptions, UseStreamingTextResult } from "../types";

// ============================================================================
// useStreamingText
// ============================================================================

/**
 * Subscribe to streaming text from the client.
 *
 * Uses the client's built-in streaming text accumulation which handles
 * tick_start, content_delta, tick_end, and execution_end events.
 *
 * @example
 * ```tsx
 * import { useStreamingText } from '@agentick/react';
 *
 * function StreamingResponse() {
 *   const { text, isStreaming } = useStreamingText();
 *
 *   return (
 *     <div>
 *       <p>{text}</p>
 *       {isStreaming && <span className="cursor">|</span>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useStreamingText(options: UseStreamingTextOptions = {}): UseStreamingTextResult {
  const { enabled = true } = options;
  const client = useClient();

  // Use useSyncExternalStore for concurrent-safe subscription
  const state = useSyncExternalStore<StreamingTextState>(
    useCallback(
      (onStoreChange) => {
        if (!enabled) return () => {};
        return client.onStreamingText(onStoreChange);
      },
      [client, enabled],
    ),
    () => (enabled ? client.streamingText : { text: "", isStreaming: false }),
    () => ({ text: "", isStreaming: false }),
  );

  const clear = useCallback(() => {
    client.clearStreamingText();
  }, [client]);

  return { text: state.text, isStreaming: state.isStreaming, clear };
}
