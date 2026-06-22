/**
 * # Agentick Shared Types
 *
 * Platform-independent type definitions shared across all Agentick packages.
 * These types define the core data structures for messages, content blocks,
 * tools, and streaming.
 *
 * ## Content Blocks
 *
 * Content blocks are discriminated unions representing all content types:
 *
 * - **Text** - Plain text content
 * - **Image/Audio/Video** - Media content with base64 or URL sources
 * - **ToolUse/ToolResult** - Tool call requests and responses
 * - **Code** - Executable code blocks
 *
 * ## Messages
 *
 * Messages represent conversation entries with roles:
 *
 * - `user` - Human input
 * - `assistant` - Model responses
 * - `system` - System prompts
 * - `tool_result` - Tool execution results
 *
 * ## Usage
 *
 * ```typescript
 * import type { Message, ContentBlock, ToolDefinition } from '@agentick/shared';
 *
 * const message: Message = {
 *   role: 'user',
 *   content: [{ type: 'text', text: 'Hello!' }]
 * };
 * ```
 *
 * @see {@link ContentBlock} - All content block types
 * @see {@link Message} - Conversation message structure
 * @see {@link ToolDefinition} - Tool schema definition
 *
 * @module @agentick/shared
 */

import { v7, type Version7Options } from "uuid";

export * from "./block-types.js";
export * from "./blocks.js";
export * from "./messages.js";
export * from "./streaming.js";
export * from "./tools.js";
export * from "./models.js";
export * from "./input.js";
export * from "./timeline.js";
export * from "./errors.js";
export * from "./identity.js";
export * from "./devtools.js";
export * from "./protocol.js";
export * from "./model-catalog.js";
export * from "./transport.js";
export * from "./context.js";
export * from "./secrets.js";
export * from "./split-message.js";
export * from "./embeddings.js";
export * from "./transport-utils.js";
export * from "./rpc-transport.js";
export * from "./utils/predicates.js";

export function uuidv7(opts?: Version7Options, offset?: number): string {
  try {
    return v7(opts, void 0, offset);
  } catch (error) {
    return uuidv7Fallback(opts, offset);
  }
}

export const uuidv7Fallback = (() => {
  // Monotonic UUIDv7 (fall back): cross-platform, close to reference
  // Support opts?: {random, msecs, seq, rng} and offset as best as possible.

  // State to support monotonicity within this module
  let _lastTS: number | undefined = undefined;
  let _lastSeq: number = 0;

  return function (opts?: Version7Options, offset?: number): string {
    // Use best available random source
    function getRandomBytes(n: number, opts?: Version7Options): Uint8Array {
      if (opts?.random && opts.random.length >= n) return opts.random.slice(0, n);
      if (opts?.rng) return opts.rng().slice(0, n);

      if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        const arr = new Uint8Array(n);
        crypto.getRandomValues(arr);
        return arr;
      }
      // Node.js fallback
      // @ts-ignore
      if (typeof require !== "undefined") {
        try {
          // @ts-ignore
          return require("crypto").randomBytes(n);
        } catch {}
      }
      // Browser fallback
      const arr = new Uint8Array(n);
      for (let i = 0; i < n; ++i) arr[i] = Math.floor(Math.random() * 256);
      return arr;
    }

    // Compute effective timestamp (ms since Unix epoch)
    let ts: number = 0;
    if (typeof opts === "object" && opts !== null) {
      if (typeof opts.msecs === "number") ts = opts.msecs;
    }
    if (!ts) ts = Date.now();
    if (typeof offset === "number") ts += offset;

    // Clamp to unsigned 48-bit
    ts = ts >>> 0; // force positive int
    const max48bit = 0xffff_ffff_ffff;
    if (ts > max48bit) ts = ts % max48bit;

    // Enforce monotonic sequence
    if (_lastTS === ts) {
      _lastSeq++;
      // If custom opts.seq is given, prefer it (overwrites _lastSeq)
      if (typeof opts?.seq === "number") _lastSeq = opts.seq;
      if (_lastSeq > 0xfff) _lastSeq = 0; // 12 bits max, wrap around
    } else {
      _lastTS = ts;
      _lastSeq = typeof opts?.seq === "number" ? opts.seq : 0;
    }

    // Get 10 bytes random
    const rnd = getRandomBytes(10, opts);

    // Encode 48-bit timestamp (ms) and 12-bit sequence
    const b0 = (ts / 0x10000000000) & 0xff;
    const b1 = (ts / 0x100000000) & 0xff;
    const b2 = (ts >>> 24) & 0xff;
    const b3 = (ts >>> 16) & 0xff;
    const b4 = (ts >>> 8) & 0xff;
    const b5 = ts & 0xff;
    // 12-bit sequence: high 4 bits, then low 8
    const seqHigh = (_lastSeq >>> 8) & 0x0f;
    const seqLow = _lastSeq & 0xff;

    // Compose v7 bytes: [ts(6)][ver/seqHi][seqLo/rndHi][var/rndLo][rnd...]
    const bytes = [
      b0,
      b1,
      b2,
      b3,
      b4,
      b5,
      0x70 | seqHigh, // version 7 (0b0111) in high nibble, then hi seq
      seqLow, // low 8 sequence
      0x80 | (rnd[0] & 0x3f), // variant RFC4122 (10xxxxxx)
      ...rnd.slice(1, 10),
    ];

    // To hex string in UUID form (8-4-4-4-12)
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  };
})();
