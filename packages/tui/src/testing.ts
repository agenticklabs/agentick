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
 *
 * This works regardless of setTimeout vs setImmediate ordering (which is
 * non-deterministic at the top level in Node.js):
 *   - If setImmediate fires first: effects already ran, our flush confirms it
 *   - If setTimeout fires first: our setImmediate queues after React's, runs after effects
 */

/**
 * Flush pending React renders and effects.
 *
 * Call after render(), stdin.write(), or any state-triggering action.
 * One call is sufficient — no need for double-flush or magic timeouts.
 */
export const flush = () => new Promise<void>((r) => setTimeout(() => setImmediate(r), 0));
