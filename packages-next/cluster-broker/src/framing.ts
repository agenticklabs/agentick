/**
 * Length-prefix binary framing — recovers message boundaries from a
 * byte stream.
 *
 * Wire format per frame:
 *
 *     ┌──────────────┬─────────────────────────────────┐
 *     │ 4 bytes LE   │  N bytes (codec-encoded payload)│
 *     │ uint32 len   │                                 │
 *     └──────────────┴─────────────────────────────────┘
 *
 * Used by byte-stream wire impls (TCP, Unix socket). Message-oriented
 * wire impls (WebSocket) ignore this helper and use native message
 * boundaries directly.
 *
 * The decoder is a small state machine — it accumulates bytes,
 * extracts complete frames as boundaries are crossed, and holds
 * partial trailing bytes until more arrive. This handles arbitrary
 * TCP chunking: the kernel can deliver a 1 KB message as `[100B,
 * 924B]`, `[1024B]`, or `[1B, 1B, ..., 1B]`.
 */

// ============================================================================
// Encode
// ============================================================================

/**
 * Prepend a 4-byte little-endian length prefix to a payload. Returns
 * a new buffer; does not mutate the input.
 *
 * Throws if `payload.length > UINT32_MAX`. In practice the codec
 * compresses far before this matters — the cap exists so a corrupted
 * prefix can't crash the decoder with an OOM allocation.
 */
export function encodeLengthPrefixed(payload: Uint8Array): Uint8Array {
  if (payload.length > 0xff_ff_ff_ff) {
    throw new RangeError(
      `cluster-broker: payload too large for length-prefix framing (${payload.length} > 2^32-1)`,
    );
  }
  const out = new Uint8Array(4 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, true);
  out.set(payload, 4);
  return out;
}

// ============================================================================
// Decode (streaming)
// ============================================================================

/**
 * Maximum payload size the decoder will accept before tearing down
 * the connection. Adopters with legitimately huge messages can raise
 * this via {@link LengthPrefixedDecoderOptions}; the default protects
 * against memory exhaustion from a corrupted length prefix.
 *
 * 16 MiB — comfortably past anything a sane cluster message will hit;
 * MessagePack-encoded MessageEnvelopes are typically a few KB.
 */
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface LengthPrefixedDecoderOptions {
  /** Override the max single-frame payload size. */
  readonly maxFrameBytes?: number;
}

/**
 * Reason a streaming decode terminated. Distinguishes recoverable
 * boundary conditions from real protocol violations.
 */
export type LengthPrefixedDecodeError = {
  readonly _tag: "frame-too-large";
  readonly declaredBytes: number;
  readonly maxBytes: number;
};

export interface LengthPrefixedDecoder {
  /**
   * Feed inbound bytes. Returns extracted complete frames in order;
   * partial trailing bytes are retained for the next call.
   *
   * If a frame's declared length exceeds `maxFrameBytes`, returns
   * `{error}` and the decoder is poisoned — every subsequent call
   * returns the same error. Callers MUST close the connection on
   * any error return.
   */
  feed(chunk: Uint8Array): {
    readonly frames: readonly Uint8Array[];
    readonly error?: LengthPrefixedDecodeError;
  };

  /**
   * True after the decoder has rejected a frame; further feeds are
   * no-ops with the same error. Connection must be closed.
   */
  readonly poisoned: boolean;
}

/**
 * Build a stateful length-prefix decoder. Each `Connection` byte
 * source should hold exactly one decoder; bytes accumulate across
 * `feed()` calls until full frames can be extracted.
 *
 * **Implementation**: chunk-list with read cursor. Inbound chunks
 * are queued without copying; reads walk the chunk list and copy
 * only when extracting a complete frame. This avoids the
 * O(n²) "merge + recopy on every feed" pattern that thrashes GC
 * under high-chunk-count load (typical TCP delivery scenario:
 * many small chunks of a single large frame).
 */
export function createLengthPrefixedDecoder(
  options: LengthPrefixedDecoderOptions = {},
): LengthPrefixedDecoder {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  // List of pending chunks. Reads consume from the head; partial
  // consumption of the head chunk shifts it via offset increment so
  // we don't realloc the chunk itself.
  const chunks: Uint8Array[] = [];
  let headOffset = 0; // byte offset into chunks[0] (the active read position)
  let totalBytes = 0; // total unconsumed bytes across all queued chunks
  let poisoned = false;
  let lastError: LengthPrefixedDecodeError | undefined;

  /** Peek N bytes starting at the current read position. */
  function peek(n: number, out: Uint8Array): boolean {
    if (totalBytes < n) return false;
    let chunkIdx = 0;
    let chunkOffset = headOffset;
    let outOffset = 0;
    let remaining = n;
    while (remaining > 0) {
      const chunk = chunks[chunkIdx]!;
      const available = chunk.length - chunkOffset;
      const take = Math.min(available, remaining);
      out.set(chunk.subarray(chunkOffset, chunkOffset + take), outOffset);
      outOffset += take;
      remaining -= take;
      chunkOffset += take;
      if (chunkOffset >= chunk.length) {
        chunkIdx += 1;
        chunkOffset = 0;
      }
    }
    return true;
  }

  /** Advance the read cursor by N bytes, dropping fully-consumed chunks. */
  function advance(n: number): void {
    let remaining = n;
    while (remaining > 0 && chunks.length > 0) {
      const chunk = chunks[0]!;
      const available = chunk.length - headOffset;
      if (available > remaining) {
        headOffset += remaining;
        remaining = 0;
      } else {
        chunks.shift();
        headOffset = 0;
        remaining -= available;
      }
    }
    totalBytes -= n;
  }

  /** Extract a fresh-allocated copy of N bytes starting at the cursor. */
  function extract(n: number): Uint8Array {
    const out = new Uint8Array(n);
    peek(n, out);
    advance(n);
    return out;
  }

  /** Read uint32 LE at the cursor without advancing. */
  function peekUint32LE(): number {
    const head = new Uint8Array(4);
    peek(4, head);
    return head[0]! | (head[1]! << 8) | (head[2]! << 16) | ((head[3]! << 24) >>> 0);
  }

  return {
    get poisoned() {
      return poisoned;
    },
    feed(chunk) {
      if (poisoned) {
        // Once poisoned, refuse further input. Caller must close.
        return { frames: [], error: lastError };
      }
      if (chunk.length > 0) {
        chunks.push(chunk);
        totalBytes += chunk.length;
      }

      const frames: Uint8Array[] = [];

      while (totalBytes >= 4) {
        const declared = peekUint32LE();
        if (declared > maxFrameBytes) {
          poisoned = true;
          lastError = { _tag: "frame-too-large", declaredBytes: declared, maxBytes: maxFrameBytes };
          return { frames, error: lastError };
        }
        if (totalBytes < 4 + declared) break; // wait for more bytes
        advance(4); // consume length prefix
        frames.push(extract(declared));
      }

      return { frames };
    },
  };
}
