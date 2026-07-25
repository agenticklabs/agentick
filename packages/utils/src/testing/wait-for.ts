/**
 * `waitFor` — poll for an observable condition with a deadline.
 *
 * Replaces the "yield N microtasks/setImmediates and hope" pattern
 * that proliferated through every async-delivery test (in-memory
 * cluster simulator, TCP conformance, etc.). Tests state the
 * EXPECTED OBSERVABLE; this helper drives time forward until the
 * observable is satisfied or the deadline expires.
 *
 *   // Before:
 *   await flushMicrotasks();
 *   await flushMicrotasks();
 *   expect(received).toHaveLength(1);
 *
 *   // After:
 *   await waitFor(() => received.length === 1);
 *   expect(received).toHaveLength(1);
 *
 * Why this is better:
 *   - **Decouples tests from impl timing.** TCP needs more yields
 *     than in-memory; WAN-latency TCP needs more than loopback; CI
 *     runners are slower than dev machines. Polling adapts.
 *   - **Fails loudly with actual context.** Times out with the
 *     condition's source location, not a downstream `expect()` that
 *     happens to fire too early.
 *   - **One pattern across every transport.** No per-test
 *     hand-tuning.
 *
 * For "expect ZERO deliveries" tests where the condition is "stays
 * empty," use {@link waitForStable} (polls until the snapshot
 * stops changing).
 */

export interface WaitForOptions {
  /** Max time to wait before rejecting. Default: 1_000 ms. */
  readonly timeoutMs?: number;
  /** Poll interval between checks. Default: 5 ms. */
  readonly pollMs?: number;
  /**
   * Optional descriptor for the timeout error message. Without one,
   * the error reads "waitFor timed out" — context is opaque.
   */
  readonly description?: string;
}

/**
 * Poll `condition` until it returns a truthy value or the timeout
 * expires. Returns the truthy value (for `waitFor(() => element)`
 * idioms). Rejects with a descriptive error on timeout.
 *
 * The check fires synchronously on each tick before yielding —
 * conditions that become true between polls are caught on the
 * NEXT poll, never silently skipped.
 */
export async function waitFor<T>(
  condition: () => T | false | null | undefined,
  options: WaitForOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const pollMs = options.pollMs ?? 5;
  const description = options.description ?? "condition";
  const start = Date.now();
  // First check synchronously — most tests' conditions are already
  // satisfied by the time waitFor is awaited (e.g., in-memory
  // transports that delivered before the test reached the await).
  let value = condition();
  if (value) return value as T;
  while (Date.now() - start < timeoutMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    value = condition();
    if (value) return value as T;
  }
  throw new Error(`waitFor: ${description} did not become true within ${timeoutMs}ms`);
}

/**
 * Poll `snapshot` until it stops changing across two consecutive
 * polls (uses `Object.is` for primitives, JSON-serialized compare
 * for objects/arrays). Use when the test wants "nothing more
 * arrives" semantics — the alternative `expect(arr).toHaveLength(0)`
 * after a single yield races against late deliveries.
 *
 * Returns the final stable snapshot. Rejects on timeout (i.e.,
 * if the snapshot keeps changing).
 */
export async function waitForStable<T>(
  snapshot: () => T,
  options: WaitForOptions & { readonly stableMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const pollMs = options.pollMs ?? 5;
  const stableMs = options.stableMs ?? 50;
  const description = options.description ?? "stable snapshot";
  const start = Date.now();
  let last = serialize(snapshot());
  let stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    const current = serialize(snapshot());
    if (current === last) {
      if (Date.now() - stableSince >= stableMs) return snapshot();
    } else {
      last = current;
      stableSince = Date.now();
    }
  }
  throw new Error(`waitForStable: ${description} never stabilized within ${timeoutMs}ms`);
}

function serialize(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
