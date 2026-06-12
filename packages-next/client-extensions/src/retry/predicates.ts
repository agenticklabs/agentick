/**
 * Default retryable-error predicate and idempotency-key helpers.
 *
 * The default predicate retries on transport-layer failures
 * (connection drop, closed mid-request, timeout) and on a small set of
 * application-layer codes that imply transient backend pressure
 * (rate-limited, backpressure, internal-error). Authentication and
 * authorization failures are NOT retried by default — the request will
 * always fail until the adopter fixes credentials.
 *
 * @see https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
 */

import { ErrorCode, type JsonRpcError } from "@agentick/spec-next";

/**
 * Shape of an error the retry middleware sees on the Promise rejection
 * channel. `TransportError` from spec is the canonical shape; we keep
 * this looser to accept anything thrown.
 */
export interface RetryableError {
  readonly kind?: string;
  readonly error?: JsonRpcError;
}

/**
 * Default retryable predicate. Adopters override via
 * `retry({ isRetryable: ... })`.
 *
 * Retries (matches AWS SDK / Google Cloud SDK conventions):
 *   - `kind: "connection"` — network unreachable, DNS, TLS, refused
 *   - `kind: "closed"` — wire dropped mid-request (replayable)
 *   - `kind: "timeout"` — client-side deadline (replayable)
 *   - `kind: "rpc"` with code in: -32603 InternalError, -32040 RateLimited,
 *     -32050 Backpressure
 *
 * Does NOT retry:
 *   - `kind: "cancelled"` — caller-initiated, retrying would be wrong
 *   - `kind: "rpc"` with auth/authz/not-found/invalid-params codes —
 *     the request will keep failing until the adopter fixes the call
 *   - `kind: "protocol"` — wire shape violation; retrying won't help
 */
export function defaultIsRetryable(err: unknown): boolean {
  const e = err as RetryableError;
  if (!e || typeof e !== "object") return false;

  switch (e.kind) {
    case "connection":
    case "closed":
    case "timeout":
      return true;
    case "rpc": {
      const code = e.error?.code;
      return (
        code === ErrorCode.InternalError ||
        code === ErrorCode.RateLimited ||
        code === ErrorCode.Backpressure
      );
    }
    default:
      return false;
  }
}

/**
 * Default idempotency-key generator. Picks methods that are NOT
 * inherently idempotent (POST-like semantics) and need a server-side
 * dedup hint so retries don't cause double-execution.
 *
 * `session/send`, `app/runOnce`, `session/dispatch`, `session/queue` are
 * the canonical agentick examples. Read-shaped methods (`gateway/list*`,
 * `app/get*`) don't get keys — replaying them is naturally idempotent.
 *
 * Returns the key as a string to attach to `params._meta.idempotencyKey`.
 */
export function defaultIdempotencyKey(method: string): string | undefined {
  if (
    method === "session/send" ||
    method === "session/dispatch" ||
    method === "session/queue" ||
    method === "app/runOnce"
  ) {
    return generateIdempotencyKey();
  }
  return undefined;
}

/**
 * RFC-4122-ish UUID v4 generator. Uses `crypto.randomUUID()` when
 * available (Node 19+, browser, edge); falls back to a Math.random
 * variant for older runtimes. Adopters who need cryptographic
 * uniqueness should ensure they're on a runtime with native UUID.
 */
export function generateIdempotencyKey(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Fallback — sufficient for collision avoidance at expected scales,
  // not cryptographic.
  const r = () => Math.random().toString(16).slice(2, 10);
  return `idem-${r()}${r()}-${r()}-${r()}-${r()}${r()}`;
}
