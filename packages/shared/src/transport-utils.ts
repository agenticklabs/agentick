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
 * Handles: plain string, { message: string }, { message: Message },
 * and { messages: Message[] } (the standard SendInput format).
 */
export function extractSendMessage(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";

  const obj = input as Record<string, unknown>;

  // { message: string | Message } — legacy/convenience format
  if ("message" in obj && obj.message) {
    const msg = obj.message;
    if (typeof msg === "string") return msg;
    return extractTextFromMessage(msg);
  }

  // { messages: Message[] } — standard SendInput format
  if ("messages" in obj && Array.isArray(obj.messages)) {
    const messages = obj.messages as Array<Record<string, unknown>>;
    // Find the last user message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        return extractTextFromContent(messages[i]!.content);
      }
    }
  }

  return "";
}

function extractTextFromMessage(msg: unknown): string {
  if (
    msg &&
    typeof msg === "object" &&
    "content" in msg &&
    Array.isArray((msg as Record<string, unknown>).content)
  ) {
    return extractTextFromContent((msg as Record<string, unknown>).content);
  }
  return "";
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<{ type: string; text?: string }>) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}
