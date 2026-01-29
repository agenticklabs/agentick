/**
 * Test Helpers
 *
 * Utility functions for async testing, event handling, and stream processing.
 */

import { EventEmitter } from "events";

// =============================================================================
// Async Utilities
// =============================================================================

/**
 * Wait for a specific event to be emitted
 */
export function waitForEvent<T = unknown>(
  emitter: EventEmitter,
  eventName: string,
  timeoutMs: number = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      emitter.removeListener(eventName, handler);
      reject(new Error(`Timeout waiting for event '${eventName}' after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (data: T) => {
      clearTimeout(timeout);
      resolve(data);
    };

    emitter.once(eventName, handler);
  });
}

/**
 * Wait for multiple events to be emitted
 */
export function waitForEvents<T = unknown>(
  emitter: EventEmitter,
  eventName: string,
  count: number,
  timeoutMs: number = 5000,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const events: T[] = [];

    const timeout = setTimeout(() => {
      emitter.removeListener(eventName, handler);
      reject(
        new Error(
          `Timeout waiting for ${count} '${eventName}' events after ${timeoutMs}ms (got ${events.length})`,
        ),
      );
    }, timeoutMs);

    const handler = (data: T) => {
      events.push(data);
      if (events.length >= count) {
        clearTimeout(timeout);
        emitter.removeListener(eventName, handler);
        resolve(events);
      }
    };

    emitter.on(eventName, handler);
  });
}

/**
 * Wait for a condition to become true
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
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a deferred promise (manually resolvable)
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
 * Capture all items from an async generator into an array
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
 * Create a mock async generator from an array
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
 * Create a controllable async generator for testing
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

// =============================================================================
// SSE Utilities
// =============================================================================

/**
 * Parse SSE event string into structured data
 */
export function parseSSEEvent(eventString: string): {
  event?: string;
  data?: string;
  id?: string;
} | null {
  if (!eventString.trim()) return null;

  const result: { event?: string; data?: string; id?: string } = {};
  const lines = eventString.split("\n");

  for (const line of lines) {
    if (line.startsWith("event:")) {
      result.event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      result.data = line.slice(5).trim();
    } else if (line.startsWith("id:")) {
      result.id = line.slice(3).trim();
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse multiple SSE events from a buffer
 */
export function parseSSEBuffer(buffer: string): Array<{
  event?: string;
  data?: string;
  id?: string;
}> {
  const events = buffer.split("\n\n");
  return events.map((e) => parseSSEEvent(e)).filter((e): e is NonNullable<typeof e> => e !== null);
}

/**
 * Format data as SSE event
 */
export function formatSSEEvent(
  data: unknown,
  options: { event?: string; id?: string } = {},
): string {
  const lines: string[] = [];

  if (options.event) {
    lines.push(`event: ${options.event}`);
  }
  if (options.id) {
    lines.push(`id: ${options.id}`);
  }

  const dataStr = typeof data === "string" ? data : JSON.stringify(data);
  lines.push(`data: ${dataStr}`);
  lines.push("");
  lines.push("");

  return lines.join("\n");
}

// =============================================================================
// Mock Utilities
// =============================================================================

/**
 * Create a spy function that tracks calls
 */
export function createSpy<T extends (...args: any[]) => any>(
  implementation?: T,
): T & {
  calls: Parameters<T>[];
  results: ReturnType<T>[];
  callCount: number;
  reset: () => void;
  mockImplementation: (fn: T) => void;
} {
  const calls: Parameters<T>[] = [];
  const results: ReturnType<T>[] = [];
  let currentImpl = implementation;

  const spy = ((...args: Parameters<T>) => {
    calls.push(args);
    const result = currentImpl?.(...args);
    results.push(result);
    return result;
  }) as T & {
    calls: Parameters<T>[];
    results: ReturnType<T>[];
    callCount: number;
    reset: () => void;
    mockImplementation: (fn: T) => void;
  };

  Object.defineProperty(spy, "calls", { get: () => calls });
  Object.defineProperty(spy, "results", { get: () => results });
  Object.defineProperty(spy, "callCount", { get: () => calls.length });

  spy.reset = () => {
    calls.length = 0;
    results.length = 0;
  };

  spy.mockImplementation = (fn: T) => {
    currentImpl = fn;
  };

  return spy;
}

/**
 * Create a mock function that returns a value
 */
export function createMock<T>(returnValue: T): () => T {
  return () => returnValue;
}

/**
 * Create a mock function that returns different values on each call
 */
export function createMockSequence<T>(...values: T[]): () => T {
  let index = 0;
  return () => {
    const value = values[index];
    if (index < values.length - 1) {
      index++;
    }
    return value;
  };
}
