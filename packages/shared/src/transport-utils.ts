/**
 * Transport Utilities
 *
 * Shared helpers used by all client-side transports (WS, Unix socket, etc.).
 * Canonical home for wire-format normalization.
 */

import type { TransportEventData } from "./transport.js";

/**
 * Normalizes EventMessage wire format to TransportEventData.
 *
 * EventMessage: { type: "event", event: "content_delta", sessionId, data: { ... } }
 * Result:       { type: "content_delta", sessionId, data: { ... } }
 *
 * Non-EventMessage data (e.g., connection, pong) passes through unchanged
 * as a raw record — callers should handle protocol messages before casting
 * the result to TransportEventData.
 */
export function unwrapEventMessage(
  raw: Record<string, unknown>,
): TransportEventData | Record<string, unknown> {
  if (raw.type === "event" && typeof raw.event === "string") {
    const result: TransportEventData = {
      type: raw.event,
      data: raw.data,
    };
    if (raw.sessionId != null) result.sessionId = raw.sessionId as string;
    return result;
  }
  return raw;
}
