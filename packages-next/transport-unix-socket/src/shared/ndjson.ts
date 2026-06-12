/**
 * Newline-delimited JSON (NDJSON) codec for Unix-socket transport.
 *
 * Each frame is `JSON.stringify(frame) + '\n'`. Receivers split on `\n`
 * and JSON-parse + validate each line via `validateJsonRpcInput`.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import {
  ErrorCode,
  validateJsonRpcInput,
  type JsonRpcBatch,
  type JsonRpcError,
  type JsonRpcFrame,
} from "@agentick/spec-next";

export function encodeNdjson(frame: JsonRpcFrame | JsonRpcBatch): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Stateful frame splitter. Feed raw bytes via `push(chunk)`; the helper
 * holds an internal buffer and yields complete frames whenever `\n`
 * arrives.
 */
export class NdjsonDecoder {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  push(
    chunk: Buffer | Uint8Array | string,
  ): Array<{ ok: true; frame: JsonRpcFrame | JsonRpcBatch } | { ok: false; error: JsonRpcError }> {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const out: Array<
      { ok: true; frame: JsonRpcFrame | JsonRpcBatch } | { ok: false; error: JsonRpcError }
    > = [];
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) {
        out.push(decodeLine(line));
      }
      idx = this.buffer.indexOf("\n");
    }
    return out;
  }
}

function decodeLine(
  line: string,
): { ok: true; frame: JsonRpcFrame | JsonRpcBatch } | { ok: false; error: JsonRpcError } {
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
