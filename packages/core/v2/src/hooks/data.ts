/**
 * V2 Data Hook
 *
 * The useData hook for async data fetching with the resolve-then-render pattern.
 */

import { useTickState } from "./context";
import { useRuntimeStore } from "./runtime-context";
import type { UseDataOptions } from "./types";

/**
 * Fetch and cache async data.
 *
 * This hook enables the "resolve-then-render" pattern:
 * 1. First render: throws a promise (signals need for data)
 * 2. Engine catches, resolves all pending fetches
 * 3. Second render: returns cached value
 *
 * @example
 * ```tsx
 * const MyComponent = ({ userId }) => {
 *   // Cached across ticks (same key = same data)
 *   const user = useData(`user-${userId}`, () => fetchUser(userId));
 *
 *   // Refetch every tick
 *   const status = useData('status', fetchStatus, { refetchEveryTick: true });
 *
 *   return <Section>{user.name}: {status}</Section>;
 * };
 * ```
 */
export function useData<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: UseDataOptions = {},
): T {
  const store = useRuntimeStore();
  const tickState = useTickState();
  const tick = tickState.tick;

  // Check cache
  const cached = store.dataCache.get(key);

  if (cached) {
    // Check if deps changed by comparing against cached deps
    // We can't use useRef here because the throw-promise pattern
    // doesn't preserve ref values (component doesn't commit during throw)
    const depsChanged = options.deps
      ? !cached.deps || !shallowEqual(cached.deps, options.deps)
      : false;

    // Check if stale
    // refetchEveryTick means refetch when tick changes, not every render
    const isStale =
      (options.refetchEveryTick && tick !== cached.tick) ||
      depsChanged ||
      (options.staleAfterTicks !== undefined && tick - cached.tick > options.staleAfterTicks);

    if (!isStale) {
      return cached.value as T;
    }

    // Stale - need to refetch
    store.dataCache.delete(key);
  }

  // Check if fetch already pending
  if (!store.pendingFetches.has(key)) {
    const promise = fetcher().then((value) => {
      store.dataCache.set(key, { value, tick, deps: options.deps });
      store.pendingFetches.delete(key);
      return value;
    });
    store.pendingFetches.set(key, promise);
  }

  // Throw promise to signal we need data
  // Engine will catch this, resolve, and re-render
  throw store.pendingFetches.get(key);
}

/**
 * Shallow equality check for deps arrays.
 */
function shallowEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Hook to get an invalidation function.
 */
export function useInvalidateData(): (pattern: string | RegExp) => void {
  const store = useRuntimeStore();
  return (pattern: string | RegExp) => {
    for (const key of store.dataCache.keys()) {
      const matches = typeof pattern === "string" ? key === pattern : pattern.test(key);
      if (matches) {
        store.dataCache.delete(key);
      }
    }
  };
}
