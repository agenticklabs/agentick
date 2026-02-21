/**
 * Kernel Testing Utilities
 *
 * Provides `createTestProcedure` — a lightweight Procedure stub for testing
 * code that *consumes* procedures without needing real middleware, context
 * propagation, or execution tracking.
 *
 * @example
 * ```typescript
 * import { createTestProcedure } from "@agentick/kernel/testing";
 *
 * const proc = createTestProcedure({ handler: async (x: number) => x * 2 });
 * const result = await proc(5).result;  // 10
 * expect(proc._callCount).toBe(1);
 * expect(proc._lastArgs).toEqual([5]);
 * ```
 *
 * @module @agentick/kernel/testing
 */

import { createProcedurePromise, PROCEDURE_SYMBOL } from "./procedure.js";
import type { Procedure, ProcedurePromise } from "./procedure.js";

// ============================================================================
// Types
// ============================================================================

export interface TestProcedureOptions<TFn extends (...args: any[]) => any> {
  /** Handler function (default: () => undefined) */
  handler?: TFn;
  /** Name for debugging */
  name?: string;
}

export interface TestProcedure<TFn extends (...args: any[]) => any> extends Procedure<TFn, true> {
  /** Every call recorded: { args, timestamp } */
  _calls: Array<{ args: any[]; timestamp: number }>;
  /** Shorthand for _calls.length */
  readonly _callCount: number;
  /** Shorthand for _calls.at(-1)?.args */
  readonly _lastArgs: any[] | undefined;
  /** Override return value for the NEXT call only (reverts after) */
  respondWith(value: ReturnType<TFn> | (() => ReturnType<TFn>)): void;
  /** Override return value for ALL subsequent calls */
  setResponse(value: ReturnType<TFn> | (() => ReturnType<TFn>)): void;
  /** Clear _calls and all overrides */
  reset(): void;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a test procedure stub.
 *
 * Callable + branded with `PROCEDURE_SYMBOL` so `isProcedure()` returns true.
 * Returns `ProcedurePromise` so `.result` chaining works.
 *
 * Chainable methods (`.use()`, `.withContext()`, etc.) are no-ops returning self.
 * This is intentional — test procedures are for testing code that *calls*
 * procedures, not for testing middleware.
 */
export function createTestProcedure<TFn extends (...args: any[]) => any>(
  options: TestProcedureOptions<TFn> = {},
): TestProcedure<TFn> {
  const handler = options.handler ?? ((() => undefined) as unknown as TFn);

  const calls: Array<{ args: any[]; timestamp: number }> = [];
  let nextResponse: { value: ReturnType<TFn> | (() => ReturnType<TFn>) } | null = null;
  let persistentResponse: { value: ReturnType<TFn> | (() => ReturnType<TFn>) } | null = null;

  function resolveOverride(override: ReturnType<TFn> | (() => ReturnType<TFn>)): ReturnType<TFn> {
    return typeof override === "function" ? (override as () => ReturnType<TFn>)() : override;
  }

  const callable = (...args: any[]): ProcedurePromise<ReturnType<TFn>> => {
    calls.push({ args, timestamp: Date.now() });

    const promise = Promise.resolve().then(() => {
      // One-shot override takes priority
      if (nextResponse !== null) {
        const override = nextResponse;
        nextResponse = null;
        return resolveOverride(override.value);
      }

      // Persistent override
      if (persistentResponse !== null) {
        return resolveOverride(persistentResponse.value);
      }

      // Default handler
      return handler(...args);
    });

    return createProcedurePromise(promise);
  };

  // Attach Procedure interface methods as no-ops
  callable.exec = callable;
  callable.use = () => callable;
  callable.withContext = () => callable;
  callable.withMiddleware = () => callable;
  callable.withTimeout = () => callable;
  callable.withMetadata = () => callable;
  callable.pipe = () => callable;

  // Brand
  (callable as any)[PROCEDURE_SYMBOL] = true;

  // Test-specific API
  Object.defineProperty(callable, "_calls", {
    get: () => calls,
    enumerable: true,
  });

  Object.defineProperty(callable, "_callCount", {
    get: () => calls.length,
    enumerable: true,
  });

  Object.defineProperty(callable, "_lastArgs", {
    get: () => calls.at(-1)?.args,
    enumerable: true,
  });

  (callable as any).respondWith = (value: ReturnType<TFn> | (() => ReturnType<TFn>)) => {
    nextResponse = { value };
  };

  (callable as any).setResponse = (value: ReturnType<TFn> | (() => ReturnType<TFn>)) => {
    persistentResponse = { value };
  };

  (callable as any).reset = () => {
    calls.length = 0;
    nextResponse = null;
    persistentResponse = null;
  };

  return callable as any;
}
