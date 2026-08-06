/**
 * W3C Trace Context generation. The FORMAT itself lives in `@agentick/spec`
 * (`formatTraceparent` / `parseTraceparent`), which both wire ends share.
 *
 * @see https://www.w3.org/TR/trace-context/#traceparent-header-field-values
 */

import { formatTraceparent } from "@agentick/spec";

/**
 * Generate a `traceparent` for a new root trace.
 *
 * `sampled` must be what is actually true — a downstream that honours the bit
 * on a span nobody recorded keeps a trace with a hole in it.
 */
export function generateTraceparent(sampled = true): string {
  return formatTraceparent({ traceId: randomHex(32), spanId: randomHex(16), sampled });
}

/**
 * Build a `_meta` patch carrying W3C Trace Context. Merge into request
 * params via the middleware. Server-side extracts `traceparent` /
 * `tracestate` from `_meta` and seeds its own span hierarchy.
 */
export function recordTraceContext(
  traceparent: string,
  tracestate?: string,
): { traceparent: string; tracestate?: string } {
  return tracestate ? { traceparent, tracestate } : { traceparent };
}

function randomHex(chars: number): string {
  const bytes = chars / 2;
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (g.crypto?.getRandomValues) {
    const buf = new Uint8Array(bytes);
    g.crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let out = "";
  for (let i = 0; i < bytes; i++) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}
