/**
 * SSE (Server-Sent Events) helpers.
 *
 * Minimal `data:`-line parser — agentick only emits `data:` lines per
 * the Streamable HTTP profile (no `event:` types, no `id:` for SSE
 * reconnect; cursor-aware resume happens at the JSON-RPC application
 * layer, not the SSE transport layer).
 *
 * Per W3C EventSource spec §9.2.5 — frames are terminated by `\n\n`
 * (or `\r\n\r\n`); lines within a frame begin with a field name
 * followed by `:`. `data:` lines are concatenated with `\n`; other
 * fields ignored for our purposes.
 *
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

import {
  ErrorCode,
  validateJsonRpcInput,
  type JsonRpcBatch,
  type JsonRpcError,
  type JsonRpcFrame,
} from "@agentick/spec-next";

export type SseFrame = { data: string };

/**
 * Encode a JSON-RPC frame as an SSE `data:` line block.
 */
export function encodeSseFrame(frame: JsonRpcFrame | JsonRpcBatch): string {
  const text = JSON.stringify(frame);
  // SSE forbids embedded newlines inside `data:`; replace any with
  // explicit `data:` continuation lines.
  const lines = text
    .split("\n")
    .map((l) => `data: ${l}`)
    .join("\n");
  return `${lines}\n\n`;
}

/**
 * Parse a `ReadableStream<Uint8Array>` of SSE bytes into a stream of
 * decoded JSON-RPC frames (or batches). Frames that fail validation
 * are surfaced as `{ ok: false; error }` so the caller can decide how
 * to handle malformed input.
 */
export async function* parseSseFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<
  { ok: true; frame: JsonRpcFrame | JsonRpcBatch } | { ok: false; error: JsonRpcError }
> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line. Match both \n\n and \r\n\r\n.
      let sep = findSeparator(buffer);
      while (sep !== null) {
        const block = buffer.slice(0, sep.start);
        buffer = buffer.slice(sep.end);
        const dataLines: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("data:")) {
            // Per spec, single space after `:` is stripped.
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }
        if (dataLines.length === 0) {
          sep = findSeparator(buffer);
          continue;
        }
        const joined = dataLines.join("\n");
        try {
          const parsed = JSON.parse(joined);
          const validated = validateJsonRpcInput(parsed);
          if (validated.ok) {
            yield { ok: true, frame: validated.value };
          } else {
            yield { ok: false, error: validated.error };
          }
        } catch (e) {
          yield {
            ok: false,
            error: {
              code: ErrorCode.ParseError,
              message: "invalid JSON in SSE data",
              data: { reason: String(e) },
            },
          };
        }
        sep = findSeparator(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface SepRange {
  start: number;
  end: number;
}

function findSeparator(buffer: string): SepRange | null {
  const rn = buffer.indexOf("\r\n\r\n");
  const nn = buffer.indexOf("\n\n");
  if (rn >= 0 && (nn < 0 || rn < nn)) return { start: rn, end: rn + 4 };
  if (nn >= 0) return { start: nn, end: nn + 2 };
  return null;
}
