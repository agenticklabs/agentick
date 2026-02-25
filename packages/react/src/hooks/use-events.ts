import { useState, useEffect, useRef } from "react";
import type { StreamEvent, SessionStreamEvent } from "@agentick/client";
import { useClient } from "./use-client.js";
import type { UseEventsOptions, UseEventsResult } from "../types.js";

type EventType = StreamEvent | SessionStreamEvent;

const EMPTY: EventType[] = [];

/**
 * Subscribe to stream events.
 *
 * Returns a batched array of events. Events that fire synchronously
 * (e.g. parallel tool results) are accumulated in a ref and flushed
 * via a single microtask — one render per synchronous burst, zero
 * events lost.
 *
 * @example
 * ```tsx
 * function ToolTracker() {
 *   const { events } = useEvents({ filter: ['tool_result'] });
 *
 *   useEffect(() => {
 *     for (const event of events) {
 *       console.log('Tool result:', event);
 *     }
 *   }, [events]);
 * }
 * ```
 */
export function useEvents(options: UseEventsOptions = {}): UseEventsResult {
  const { filter, sessionId, enabled = true } = options;

  const client = useClient();
  const pendingRef = useRef<EventType[]>([]);
  const flushScheduledRef = useRef(false);
  const [events, setEvents] = useState<EventType[]>(EMPTY);

  // Filter lives in a ref so the handler always reads the latest value
  // without forcing effect re-subscription on every render.
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    if (!enabled) return;

    // Clear stale events from a previous subscription cycle.
    pendingRef.current.length = 0;
    flushScheduledRef.current = false;

    const handler = (incoming: EventType) => {
      const f = filterRef.current;
      if (f && !f.includes(incoming.type)) return;
      pendingRef.current.push(incoming);

      if (!flushScheduledRef.current) {
        flushScheduledRef.current = true;
        queueMicrotask(() => {
          flushScheduledRef.current = false;
          if (pendingRef.current.length > 0) {
            setEvents(pendingRef.current.splice(0));
          }
        });
      }
    };

    if (sessionId) {
      return client.session(sessionId).onEvent(handler);
    }
    return client.onEvent(handler);
  }, [client, sessionId, enabled]);

  return { events };
}
