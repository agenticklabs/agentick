/**
 * Tentickle-aware act() wrapper
 *
 * Extends React's act() to handle Tentickle-specific concerns:
 * - Signal notifications (microtask-based)
 * - Scheduler flushing
 * - Async compilation
 */

import { act as reactAct } from "react";
import { flushSync, flushPassiveEffects } from "../reconciler/reconciler";

/**
 * Flush all pending microtasks.
 *
 * Signals and the scheduler use queueMicrotask for batching.
 * This ensures all pending notifications are processed.
 */
export async function flushMicrotasks(): Promise<void> {
  // Multiple passes to handle cascading microtasks
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
  }
}

/**
 * Flush all pending work synchronously.
 *
 * Combines React's flushSync with passive effects flushing.
 */
export function flushAll(): void {
  flushSync(() => {});
  flushPassiveEffects();
}

/**
 * Tentickle-aware act() wrapper.
 *
 * Use this in tests to wrap any code that triggers state updates,
 * signal changes, or reconciliation. It ensures all effects and
 * microtasks are flushed before the assertion phase.
 *
 * @example
 * ```tsx
 * import { act } from '@tentickle/core/testing';
 *
 * test('signal updates trigger reconciliation', async () => {
 *   const { send } = renderAgent(MyAgent);
 *
 *   await act(async () => {
 *     await send("Hello");
 *   });
 *
 *   // Assertions here - all effects have run
 * });
 * ```
 */
export async function act<T>(callback: () => T | Promise<T>): Promise<T> {
  let result: T;

  // Wrap in React's act for proper React state handling
  await reactAct(async () => {
    result = await callback();

    // Flush Tentickle-specific concerns
    flushAll();
    await flushMicrotasks();

    // Second pass for cascading effects
    flushAll();
    await flushMicrotasks();
  });

  return result!;
}

/**
 * Synchronous act for non-async operations.
 *
 * Use when you know the operation is synchronous and won't
 * trigger async effects.
 *
 * @example
 * ```tsx
 * actSync(() => {
 *   signal.set(newValue);
 * });
 * ```
 */
export function actSync<T>(callback: () => T): T {
  let result: T;

  // React's act() can accept a sync function
  reactAct(() => {
    result = callback();
    flushAll();
  });

  return result!;
}
