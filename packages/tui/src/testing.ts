/**
 * Test utilities for @agentick/tui.
 *
 * react-reconciler@0.31 with `supportsMicrotasks: true` schedules render work
 * via queueMicrotask, and React's Scheduler flushes passive effects (useEffect)
 * via setImmediate in Node.js.
 *
 * After render() or state changes, we need to wait for:
 *   1. Microtasks — React render + commit, Ink stdout.write
 *   2. Passive effects — useEffect callbacks (e.g., useInput's stdin listener)
 *
 * The flush() utility chains setTimeout(0) → setImmediate to guarantee both
 * have completed:
 *   - setTimeout(0) yields to the macrotask queue, ensuring all microtasks
 *     (render + commit) have drained
 *   - setImmediate runs in Node's check phase, AFTER React's Scheduler has
 *     flushed passive effects (also scheduled via setImmediate, but earlier)
 */

/**
 * Flush pending React renders and effects.
 *
 * Call after render(), stdin.write(), or any state-triggering action.
 */
export const flush = () => new Promise<void>((r) => setTimeout(() => setImmediate(r), 0));

/**
 * Poll until an assertion passes, flushing the event loop between attempts.
 *
 * Use this instead of `flush()` + immediate assertion when the timing between
 * a trigger (e.g., stdin.write) and its effect (e.g., useInput callback) is
 * non-deterministic across environments (local macOS vs CI Linux).
 */
export async function waitFor(assertion: () => void, timeout = 2000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeout) {
    await flush();
    try {
      assertion();
      return;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
