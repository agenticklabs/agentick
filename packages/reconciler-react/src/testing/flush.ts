/**
 * Test utilities for `@agentick/reconciler-react`.
 *
 * react-reconciler 0.33 with `supportsMicrotasks: true` schedules render
 * work via `queueMicrotask`, and React's Scheduler flushes passive
 * effects (`useEffect`) via `setImmediate` in Node.js.
 *
 * After `reconciler.render(...)` or a `setState` from outside React,
 * we need to wait for:
 *   1. Microtasks   — render + commit
 *   2. Passive effects — `useEffect` callbacks via React's Scheduler
 *
 * `flush()` chains `setTimeout(0) → setImmediate` repeatedly to ensure
 * cascading work (render → effect → setState → re-render → effect …)
 * has fully drained.
 *
 * Mirrors the helper at `packages/tui/src/testing.ts`.
 */

/**
 * Flush pending React renders + effects. Call after `render()` or any
 * state-triggering action before asserting on the host tree.
 *
 * Three rounds because reconciler 0.33 can cascade:
 *   render (microtask) → commit → Scheduler (setImmediate) → effects →
 *   possibly more microtasks → more setImmediate work.
 */
export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => setTimeout(() => setImmediate(resolve), 0));
  }
}

/**
 * Poll until `assertion` passes, flushing between attempts. Useful when
 * the trigger → effect timing is non-deterministic across platforms
 * (local macOS vs CI Linux).
 */
export async function waitFor(
  assertion: () => void,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    await flush();
    try {
      assertion();
      return;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error("waitFor timed out");
}
