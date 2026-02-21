import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { SessionAccessor } from "@agentick/client";
import { useClient } from "./use-client.js";
import type { UseSessionOptions, UseSessionResult } from "../types.js";

// ============================================================================
// useSession
// ============================================================================

/**
 * Work with a specific session.
 *
 * @example Basic usage with session ID
 * ```tsx
 * import { useSession } from '@agentick/react';
 *
 * function Chat({ sessionId }: { sessionId: string }) {
 *   const { send, isSubscribed, subscribe } = useSession({ sessionId });
 *   const [input, setInput] = useState('');
 *
 *   // Subscribe on mount
 *   useEffect(() => {
 *     subscribe();
 *   }, [subscribe]);
 *
 *   const handleSend = async () => {
 *     await send(input);
 *     setInput('');
 *   };
 *
 *   return (
 *     <div>
 *       <input value={input} onChange={(e) => setInput(e.target.value)} />
 *       <button onClick={handleSend}>Send</button>
 *     </div>
 *   );
 * }
 * ```
 *
 * @example Ephemeral session (no sessionId)
 * ```tsx
 * function QuickChat() {
 *   const { send } = useSession();
 *
 *   // Each send creates/uses an ephemeral session
 *   const handleSend = () => send('Hello!');
 *
 *   return <button onClick={handleSend}>Ask</button>;
 * }
 * ```
 *
 * @example Auto-subscribe
 * ```tsx
 * function Chat({ sessionId }: { sessionId: string }) {
 *   const { send, isSubscribed } = useSession({
 *     sessionId,
 *     autoSubscribe: true,
 *   });
 *
 *   if (!isSubscribed) return <div>Subscribing...</div>;
 *
 *   return <ChatInterface />;
 * }
 * ```
 */
export function useSession(options: UseSessionOptions = {}): UseSessionResult {
  const { sessionId, autoSubscribe = false } = options;

  const client = useClient();
  const mountedRef = useRef(true);

  // Get or create session accessor
  const accessor = useMemo<SessionAccessor | undefined>(() => {
    if (!sessionId) return undefined;
    return client.session(sessionId);
  }, [client, sessionId]);

  const [isSubscribed, setIsSubscribed] = useState(false);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Subscribe function
  const subscribe = useCallback(() => {
    if (!accessor) return;
    accessor.subscribe();
    if (mountedRef.current) {
      setIsSubscribed(true);
    }
  }, [accessor]);

  // Unsubscribe function
  const unsubscribe = useCallback(() => {
    if (!accessor) return;
    accessor.unsubscribe();
    if (mountedRef.current) {
      setIsSubscribed(false);
    }
  }, [accessor]);

  // Auto-subscribe
  useEffect(() => {
    if (autoSubscribe && accessor && !isSubscribed) {
      subscribe();
    }
  }, [autoSubscribe, accessor, isSubscribed, subscribe]);

  // Send function
  const send = useCallback(
    (input: Parameters<UseSessionResult["send"]>[0]) => {
      if (accessor) {
        const normalizedInput =
          typeof input === "string"
            ? {
                messages: [
                  {
                    role: "user" as const,
                    content: [{ type: "text" as const, text: input }],
                  },
                ],
              }
            : input;
        return accessor.send(normalizedInput as any);
      }
      return client.send(input as any);
    },
    [client, accessor],
  );

  // Abort function
  const abort = useCallback(
    async (reason?: string) => {
      if (accessor) {
        await accessor.abort(reason);
      } else if (sessionId) {
        await client.abort(sessionId, reason);
      }
    },
    [client, accessor, sessionId],
  );

  // Close function
  const close = useCallback(async () => {
    if (accessor) {
      await accessor.close();
    } else if (sessionId) {
      await client.closeSession(sessionId);
    }
  }, [client, accessor, sessionId]);

  return {
    sessionId,
    isSubscribed,
    subscribe,
    unsubscribe,
    send,
    abort,
    close,
    accessor,
  };
}
