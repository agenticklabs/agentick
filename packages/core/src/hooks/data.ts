/**
 * Data Hook
 *
 * The useData hook for async data fetching with the resolve-then-render pattern.
 */

import { useTickState } from "./context.js";
import { useRuntimeStore, type HookPersistenceOptions } from "./runtime-context.js";

/**
 * Options for {@link useData}.
 */
export interface UseDataOptions extends HookPersistenceOptions {}

/** Sentinel value marking a cached fetch error. */
const DATA_ERROR = Symbol("useData:error");

/**
 * Fetch and cache async data.
 *
 * This hook enables the "resolve-then-render" pattern:
 * 1. First render: throws a promise (signals need for data)
 * 2. Engine catches, resolves all pending fetches
 * 3. Second render: returns cached value
 *
 * If the fetcher rejects, the error is cached for the current deps.
 * The error is re-thrown synchronously on the next render (not as a
 * promise), so the compiler loop terminates cleanly. When deps change
 * the cache invalidates and a fresh fetch is attempted.
 *
 * @example
 * ```tsx
 * const MyComponent = ({ userId }) => {
 *   // Cached across ticks, refetch when userId changes
 *   const user = useData('user', () => fetchUser(userId), [userId]);
 *
 *   // Refetch every tick by including tick in deps
 *   const { tick } = useTickState();
 *   const status = useData('status', fetchStatus, [tick]);
 *
 *   return <Section>{user.name}: {status}</Section>;
 * };
 * ```
 *
 * @example Opt out of snapshot persistence
 * ```tsx
 * // Large or frequently-changing data — re-fetch on hydration instead
 * const embeddings = useData(
 *   'embeddings',
 *   () => fetchEmbeddings(query),
 *   [query],
 *   { persist: false },
 * );
 * ```
 */
export function useData<T>(
  key: string,
  fetcher: () => Promise<T>,
  deps?: unknown[],
  options?: UseDataOptions,
): T {
  const store = useRuntimeStore();
  const tickState = useTickState();
  const tick = tickState.tick;

  // Check cache
  const cached = store.dataCache.get(key);

  if (cached) {
    // Check if deps changed by comparing against cached deps
    const depsChanged = deps ? !cached.deps || !shallowEqual(cached.deps, deps) : false;

    if (!depsChanged) {
      // Cached error — re-throw synchronously (not as promise) so the
      // compiler loop sees storeHasPendingData → false and exits cleanly.
      if (cached.value === DATA_ERROR) {
        throw (cached as any).error;
      }
      return cached.value as T;
    }

    // Deps changed - need to refetch
    store.dataCache.delete(key);
  }

  // Check if fetch already pending
  if (!store.pendingFetches.has(key)) {
    const promise = fetcher().then(
      (value) => {
        store.dataCache.set(key, { value, tick, deps, persist: options?.persist });
        store.pendingFetches.delete(key);
        return value;
      },
      (error) => {
        // Cache the error so subsequent renders fail fast instead of
        // leaving a stale rejected promise in pendingFetches forever.
        store.dataCache.set(key, {
          value: DATA_ERROR,
          error,
          tick,
          deps,
          persist: false,
        } as any);
        store.pendingFetches.delete(key);
        // Don't re-throw: the promise resolves (to undefined), so
        // storeResolvePendingData / Promise.all won't reject. The
        // error surfaces on the next render via the cache check above.
      },
    );
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
