import { useState, useEffect, useCallback } from "react";
import type { StreamEvent, SessionStreamEvent } from "@agentick/client";
import { useClient } from "./use-client";
import type { UseEventsOptions, UseEventsResult } from "../types";

// ============================================================================
// useEvents
// ============================================================================

/**
 * Subscribe to stream events.
 *
 * Returns the latest event (not accumulated). Use useStreamingText
 * for accumulated text from content_delta events.
 *
 * @example
 * ```tsx
 * import { useEvents } from '@agentick/react';
 *
 * function EventLog() {
 *   const { event } = useEvents();
 *
 *   useEffect(() => {
 *     if (event) {
 *       console.log('Event:', event.type, event);
 *     }
 *   }, [event]);
 *
 *   return <div>Latest: {event?.type}</div>;
 * }
 * ```
 *
 * @example With filter
 * ```tsx
 * function ToolCalls() {
 *   const { event } = useEvents({ filter: ['tool_call', 'tool_result'] });
 *
 *   if (!event) return null;
 *
 *   return <div>Tool: {event.type === 'tool_call' ? event.name : 'result'}</div>;
 * }
 * ```
 *
 * @example Session-specific events
 * ```tsx
 * function SessionEvents({ sessionId }: { sessionId: string }) {
 *   const { event } = useEvents({ sessionId });
 *   // Only receives events for this session
 *   return <div>{event?.type}</div>;
 * }
 * ```
 */
export function useEvents(options: UseEventsOptions = {}): UseEventsResult {
  const { filter, sessionId, enabled = true } = options;

  const client = useClient();
  const [event, setEvent] = useState<StreamEvent | SessionStreamEvent | undefined>();

  useEffect(() => {
    if (!enabled) return;

    // Use session-specific subscription if sessionId provided
    if (sessionId) {
      const accessor = client.session(sessionId);
      const unsubscribe = accessor.onEvent((incoming) => {
        if (filter && !filter.includes(incoming.type)) {
          return;
        }
        setEvent(incoming);
      });
      return unsubscribe;
    }

    // Global subscription
    const unsubscribe = client.onEvent((incoming) => {
      if (filter && !filter.includes(incoming.type)) {
        return;
      }
      setEvent(incoming);
    });

    return unsubscribe;
  }, [client, sessionId, enabled, filter]);

  const clear = useCallback(() => {
    setEvent(undefined);
  }, []);

  return { event, clear };
}
