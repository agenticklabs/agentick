/**
 * Exponential backoff with full jitter.
 *
 * Per AWS Builder's Library "Timeouts, retries, and backoff with jitter"
 * (Marc Brooker). "Full jitter" means the ENTIRE range is jittered, not just
 * the added portion — which is what removes the thundering herd when a fleet
 * of clients all lose the same server at the same instant.
 *
 * Lives here rather than in a transport because two independent retry loops
 * need identical timing discipline: the wire dial loop in
 * `@agentick/transport`'s `BaseClientTransport`, and the handshake retry loop
 * in `@agentick/client-core` (a handshake can fail while the wire stays up,
 * and it retries on its own schedule).
 *
 * @verifiedBy ../../transport/src/__tests__/backoff-jitter.spec.ts
 */

/** The two knobs the delay curve is derived from. */
export interface BackoffCurve {
  /** Delay ceiling for the FIRST attempt (attempt 0). */
  readonly initialDelayMs: number;
  /** Hard cap the exponential growth saturates at. */
  readonly maxDelayMs: number;
}

/**
 * Returns a uniform random delay in
 * `[0, min(maxDelayMs, initialDelayMs * 2^attempt))`.
 *
 * `attempt` is zero-based: attempt 0 draws from `[0, initialDelayMs)`.
 * `random` is injectable so the distribution can be tested deterministically.
 */
export function computeFullJitterBackoff(
  attempt: number,
  policy: BackoffCurve,
  random: () => number = Math.random,
): number {
  const exp = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** attempt);
  return random() * exp;
}
