/**
 * W3C Trace Context — `traceparent` / `tracestate` header generation
 * and parsing.
 *
 * `traceparent` format: `00-<trace-id-hex-32>-<span-id-hex-16>-<flags-hex-2>`
 *
 * @see https://www.w3.org/TR/trace-context/#traceparent-header-field-values
 */

/**
 * Generate a `traceparent` value for a new root trace. Uses
 * `crypto.getRandomValues` when available; falls back to Math.random
 * for environments without WebCrypto.
 *
 * `flags = "01"` sets the `sampled` bit. Adopters who own their own
 * sampler should generate `traceparent` themselves and pass via
 * `recordTraceContext`.
 */
export function generateTraceparent(): string {
  const traceId = randomHex(32);
  const spanId = randomHex(16);
  return `00-${traceId}-${spanId}-01`;
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
