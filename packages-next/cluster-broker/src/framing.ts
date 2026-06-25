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
 */
export function createLengthPrefixedDecoder(
  options: LengthPrefixedDecoderOptions = {},
): LengthPrefixedDecoder {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  let buffer: Uint8Array = new Uint8Array(0);
  let poisoned = false;
  let lastError: LengthPrefixedDecodeError | undefined;

  return {
    get poisoned() {
      return poisoned;
    },
    feed(chunk) {
      if (poisoned) {
        // Once poisoned, refuse further input. Caller must close.
        return { frames: [], error: lastError };
      }
      // Append chunk to buffer. Allocate a fresh Uint8Array sized to
      // the combined length; copying is fine at these volumes (a few
      // KB per frame typically).
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer, 0);
      merged.set(chunk, buffer.length);
      buffer = merged;

      const frames: Uint8Array[] = [];

      while (buffer.length >= 4) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const declared = view.getUint32(0, true);
        if (declared > maxFrameBytes) {
          poisoned = true;
          lastError = { _tag: "frame-too-large", declaredBytes: declared, maxBytes: maxFrameBytes };
          return { frames, error: lastError };
        }
        if (buffer.length < 4 + declared) break; // wait for more bytes
        // Slice so the frame buffer is independent of the rolling
        // accumulator — keeping a reference to a slice of `buffer`
        // would keep the entire buffer alive and prevent GC.
        frames.push(buffer.slice(4, 4 + declared));
        buffer = buffer.subarray(4 + declared);
      }

      // Snapshot any unconsumed trailing bytes so the accumulator
      // doesn't pin the larger backing buffer.
      if (buffer.byteOffset > 0) buffer = buffer.slice();

      return { frames };
    },
  };
}
