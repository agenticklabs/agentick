/**
 * `useData(key, fetcher)` — walker-portable suspend-via-throw primitive
 * for loading data inside a template.
 *
 * Pattern (universal across frameworks that handle thrown Promises):
 *
 *   first call:   cache miss → kicks off fetcher → throws the Promise
 *                 → framework runtime (React Suspense, Solid, etc.)
 *                 catches, awaits, retries the component
 *   second call:  cache populated → returns the resolved value
 *
 * Not a React hook — a plain function. Works without React's current-
 * dispatcher because the blocking pattern is just throw/await/catch.
 * The ambient `RenderContext` is threaded by `withRenderContext`
 * (lexical stack discipline).
 *
 * Each adapter that wants the same call signature in its own framework
 * may re-export this directly (React, Solid) or replace it with a
 * framework-native variant (Angular: Observable subscription) that
 * matches the signature.
 */

import { getRenderContext } from "./render-context.js";

/**
 * Sentinel wrapper for a cached fetcher rejection. We can't store an
 * `Error` directly in the value cache because real fetched values
 * might BE error-like (a valid resource that happens to be
 * `Error`-shaped). The wrapper disambiguates.
 */
class CachedRejection {
  constructor(readonly error: unknown) {}
}

/**
 * Synchronously read cached data; on miss, kick off the fetcher and
 * throw the in-flight Promise. The walker / framework runtime catches,
 * awaits, retries.
 *
 *  - cached value       → returns it (hot path)
 *  - cached rejection   → throws the cached error synchronously
 *  - fetch in flight    → throws the in-flight Promise (de-duped per key)
 *  - nothing in flight  → starts fetcher, stores Promise, throws it
 *
 * Within a SINGLE render, the fetcher runs at most once per key.
 * Failures cache too — a rejecting fetcher fails ONCE and the cached
 * error throws synchronously on subsequent calls (no refetch loop).
 * Across renders the fetcher MAY rerun — the cache lives on the
 * RenderContext, which is constructed fresh per `compileToTree`
 * invocation. Adopters who want cross-render caching wrap the fetcher
 * with their own cache.
 */
export function useData<T>(key: string, fetcher: () => Promise<T>): T {
  const ctx = getRenderContext();
  if (ctx.cache.has(key)) {
    const cached = ctx.cache.get(key);
    if (cached instanceof CachedRejection) throw cached.error;
    return cached as T;
  }

  let pending = ctx.pending.get(key);
  if (!pending) {
    pending = fetcher().then(
      (value) => {
        ctx.cache.set(key, value);
        ctx.pending.delete(key);
        return value;
      },
      (err: unknown) => {
        // Cache the rejection — next retry pass sees it synchronously
        // and throws the original error (not a thenable), so the
        // framework runtime / driver propagates as a real error
        // instead of looping forever on a reproducibly-failing fetch.
        ctx.cache.set(key, new CachedRejection(err));
        ctx.pending.delete(key);
        // Resolve (NOT reject) — the driver's `await pending` should
        // proceed to the next render pass, where the cache lookup
        // surfaces the error synchronously.
        return undefined as never;
      },
    );
    ctx.pending.set(key, pending);
  }
  throw pending;
}
