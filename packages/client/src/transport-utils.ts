/**
 * Normalizes EventMessage wire format to flat event format.
 *
 * EventMessage: { type: "event", event: "content_delta", sessionId, data: { ... } }
 * Flat:         { type: "content_delta", sessionId, ... }
 *
 * Non-EventMessage data (e.g., connection, pong) passes through unchanged.
 */
export function unwrapEventMessage(data: Record<string, unknown>): Record<string, unknown> {
  if (data.type === "event" && typeof data.event === "string") {
    return {
      // Data fields spread first, then envelope fields overwrite to prevent collision
      ...(data.data && typeof data.data === "object" ? (data.data as object) : {}),
      type: data.event,
      ...(data.sessionId != null && { sessionId: data.sessionId }),
    };
  }
  return data;
}
