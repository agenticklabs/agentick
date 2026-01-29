/**
 * ID generation utilities for streaming events
 *
 * Format: <prefix>_<hex>
 * - Messages: msg_a1b2c3d4e5f6g7h8
 * - Content blocks: blk_a1b2c3d4e5f6g7h8
 * - Tool calls: tool_a1b2c3d4e5f6g7h8
 * - Tool results: result_a1b2c3d4e5f6g7h8
 */

/**
 * Generate a cryptographically secure random ID with prefix.
 * Uses Web Crypto API (works in both Node.js 15+ and browsers).
 */
function generateRandomId(prefix: string): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const randomHex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${randomHex}`;
}

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return generateRandomId("msg");
}

/**
 * Generate a unique content block ID
 */
export function generateContentId(): string {
  return generateRandomId("blk");
}

/**
 * Generate a unique tool call ID
 */
export function generateToolCallId(): string {
  return generateRandomId("tool");
}

/**
 * Generate a unique tool result ID
 */
export function generateToolResultId(): string {
  return generateRandomId("result");
}
