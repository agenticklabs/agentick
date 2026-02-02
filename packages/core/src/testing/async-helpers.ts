/**
 * Async Testing Helpers
 *
 * Utility functions for async testing, condition polling, and stream processing.
 */

// =============================================================================
// Async Utilities
// =============================================================================

/**
 * Sleep for a specified duration.
 *
 * @example
 * ```ts
 * await sleep(100); // Wait 100ms
 * ```
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a condition to become true.
 *
 * @example
 * ```ts
 * await waitFor(() => element.isVisible, { timeout: 5000 });
 * await waitFor(() => model.getCapturedInputs().length > 0);
 * ```
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: {
    timeout?: number;
    interval?: number;
    message?: string;
  } = {},
): Promise<void> {
  const { timeout = 5000, interval = 50, message = "Condition not met" } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await sleep(interval);
  }

  throw new Error(`${message} after ${timeout}ms`);
}

/**
 * Create a deferred promise (manually resolvable).
 *
 * @example
 * ```ts
 * const { promise, resolve, reject } = createDeferred<string>();
 *
 * // Later...
 * resolve("done");
 *
 * // Or in async code
 * const result = await promise;
 * ```
 */
export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

// =============================================================================
// Stream Utilities
// =============================================================================

/**
 * Capture all items from an async generator into an array.
 *
 * @example
 * ```ts
 * const events = await captureAsyncGenerator(model.executeStream(input));
 * expect(events).toHaveLength(5);
 * ```
 */
export async function captureAsyncGenerator<T>(
  generator: AsyncIterable<T>,
  options: { timeout?: number } = {},
): Promise<T[]> {
  const { timeout = 10000 } = options;
  const items: T[] = [];

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;

  const cleanup = () => {
    aborted = true;
    if (timeoutId) clearTimeout(timeoutId);
    // Try to close the generator if it has a return method
    const gen = generator as AsyncGenerator<T>;
    if (typeof gen.return === "function") {
      gen.return(undefined as any).catch(() => {});
    }
  };

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`Generator timeout after ${timeout}ms`));
    }, timeout);
  });

  const capturePromise = (async () => {
    try {
      for await (const item of generator) {
        if (aborted) break;
        items.push(item);
      }
      return items;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  })();

  return Promise.race([capturePromise, timeoutPromise]);
}

/**
 * Create a mock async generator from an array.
 *
 * @example
 * ```ts
 * const generator = arrayToAsyncGenerator([1, 2, 3], 10);
 * for await (const item of generator) {
 *   console.log(item); // 1, 2, 3 with 10ms delay between
 * }
 * ```
 */
export async function* arrayToAsyncGenerator<T>(
  items: T[],
  delayMs: number = 0,
): AsyncGenerator<T> {
  for (const item of items) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    yield item;
  }
}

/**
 * Create a controllable async generator for testing.
 *
 * Allows manually pushing values, completing, or erroring the generator.
 *
 * @example
 * ```ts
 * const { generator, push, complete, error } = createControllableGenerator<number>();
 *
 * // In test setup
 * push(1);
 * push(2);
 * push(3);
 * complete();
 *
 * // In code under test
 * for await (const value of generator) {
 *   console.log(value); // 1, 2, 3
 * }
 * ```
 */
export function createControllableGenerator<T>(): {
  generator: AsyncGenerator<T>;
  push: (value: T) => void;
  complete: () => void;
  error: (err: Error) => void;
} {
  const queue: Array<{ value: T } | { error: Error } | { done: true }> = [];
  let resolveNext: (() => void) | null = null;
  let isComplete = false;

  const generator = (async function* () {
    while (true) {
      if (queue.length === 0 && !isComplete) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
        resolveNext = null;
      }

      const item = queue.shift();
      if (!item) continue;

      if ("done" in item) {
        return;
      }
      if ("error" in item) {
        throw item.error;
      }
      yield item.value;
    }
  })();

  return {
    generator,
    push: (value: T) => {
      queue.push({ value });
      resolveNext?.();
    },
    complete: () => {
      isComplete = true;
      queue.push({ done: true });
      resolveNext?.();
    },
    error: (err: Error) => {
      queue.push({ error: err });
      resolveNext?.();
    },
  };
}
