/**
 * Newline-delimited JSON (NDJSON) codec for Unix-socket transport.
 *
 * Each frame is `JSON.stringify(frame) + '\n'`. Receivers split on `\n`
 * and JSON-parse + validate each line via `validateJsonRpcInput`.
 *
 * Framing is "read until `\n`", which means an unbounded decoder grows for as
 * long as a peer withholds one. {@link NdjsonDecoder} caps the bytes it will
 * hold for a single line and refuses past that — see
 * {@link DEFAULT_MAX_LINE_BYTES}.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import {
  ErrorCode,
  validateJsonRpcInput,
  type JsonRpcBatch,
  type JsonRpcError,
  type JsonRpcFrame,
} from "@agentick/spec";

export function encodeNdjson(frame: JsonRpcFrame | JsonRpcBatch): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Bytes one line may occupy before the decoder refuses it, when the caller
 * configures no cap. 16 MiB is far above any real JSON-RPC frame (a large tool
 * result included) and far below "a peer can exhaust this host".
 */
export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

/** One decoded outcome: a frame, or a refusal (`fatal` when framing is lost). */
export type NdjsonResult =
  | { ok: true; frame: JsonRpcFrame | JsonRpcBatch }
  | { ok: false; error: JsonRpcError; fatal?: true };

export interface NdjsonDecoderOptions {
  /**
   * Bytes one line may occupy before the decoder refuses it. Counts the line's
   * own bytes across however many chunks carry them, and resets at each
   * newline — a long stream of small frames is never affected. Defaults to
   * {@link DEFAULT_MAX_LINE_BYTES}.
   */
  readonly maxLineBytes?: number;
}

/**
 * Stateful frame splitter. Feed raw bytes via `push(chunk)`; the helper
 * holds an internal buffer and yields complete frames whenever `\n`
 * arrives.
 *
 * Over the cap, `push` yields ONE `fatal` refusal and then discards bytes until
 * the next newline: the framing for that line is already lost, so emitting a
 * second error per chunk would just be noise, and parsing from the middle of it
 * would resynchronize on an arbitrary byte. A caller that owns a connection
 * (the server adapter) should close it on `fatal`; a caller that can only read
 * gets a decoder that resumes cleanly at the next line.
 */
export class NdjsonDecoder {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly maxLineBytes: number;
  /** Bytes of the current un-terminated line held in {@link buffer}. */
  private pendingBytes = 0;
  /** True while dropping the remainder of a line that already blew the cap. */
  private discarding = false;

  constructor(options: NdjsonDecoderOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  push(chunk: Buffer | Uint8Array | string): NdjsonResult[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const chunkBytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;

    if (this.discarding) {
      // Skip to the end of the doomed line. Anything before the newline is a
      // fragment of a frame we already refused.
      const newline = text.indexOf("\n");
      if (newline < 0) return [];
      this.discarding = false;
      this.buffer = text.slice(newline + 1);
      this.pendingBytes = Buffer.byteLength(this.buffer);
      return this.drain();
    }

    this.buffer += text;
    this.pendingBytes += chunkBytes;
    return this.drain();
  }

  /** Split out every complete line, then enforce the cap on what is left. */
  private drain(): NdjsonResult[] {
    const out: NdjsonResult[] = [];
    let consumedNewline = false;
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      consumedNewline = true;
      if (line.length > 0) {
        out.push(decodeLine(line));
      }
      idx = this.buffer.indexOf("\n");
    }
    if (consumedNewline) {
      // The tail is a fresh, un-terminated line — recount it. Normally a few
      // bytes; the pathological no-newline flood never reaches this branch, so
      // the count stays O(1) per chunk exactly where it matters.
      this.pendingBytes = Buffer.byteLength(this.buffer);
    }

    if (this.pendingBytes > this.maxLineBytes) {
      out.push({
        ok: false,
        fatal: true,
        error: {
          code: ErrorCode.InvalidRequest,
          message: "NDJSON line too large",
          data: { maxLineBytes: this.maxLineBytes, received: this.pendingBytes },
        },
      });
      this.discarding = true;
      this.buffer = "";
      this.pendingBytes = 0;
    }
    return out;
  }
}

function decodeLine(line: string): NdjsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: ErrorCode.ParseError,
        message: "invalid JSON in NDJSON line",
        data: { reason: String(e) },
      },
    };
  }
  const validated = validateJsonRpcInput(parsed);
  if (validated.ok) return { ok: true, frame: validated.value };
  return { ok: false, error: validated.error };
}
