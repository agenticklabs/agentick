/**
 * Transport Utilities
 *
 * Shared helpers used by all client-side transports (WS, Unix socket, etc.).
 * Canonical home for wire-format normalization.
 */

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

/**
 * Extract a plain text message from SendInput for the wire protocol.
 * Handles string input, object input with message field, and content block arrays.
 */
export function extractSendMessage(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";

  const obj = input as Record<string, unknown>;
  if ("message" in obj && obj.message) {
    const msg = obj.message;
    if (typeof msg === "string") return msg;
    if (
      msg &&
      typeof msg === "object" &&
      "content" in msg &&
      Array.isArray((msg as Record<string, unknown>).content)
    ) {
      const content = (msg as Record<string, unknown>).content as Array<{
        type: string;
        text?: string;
      }>;
      const textBlock = content.find((b): b is { type: "text"; text: string } => b.type === "text");
      return textBlock?.text ?? "";
    }
  }
  return "";
}
