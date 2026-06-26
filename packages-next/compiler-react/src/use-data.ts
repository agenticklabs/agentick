/**
 * React-Context-based `useData` for the React compiler.
 *
 * Why a React Context (vs compiler-next's stack-discipline version):
 * react-reconciler may retry suspended fibers in microtasks that run
 * OUTSIDE our compile-loop's synchronous withRenderContext call. A
 * React Context propagates through ALL of react-reconciler's
 * scheduling — including suspense retries — because it's part of
 * React's own state machine.
 *
 * Adopters writing React templates import `useData` from
 * `@agentick/compiler-react-next`. compiler-next's `useData` remains
 * available for pure-JS drivers (custom AST walkers, tests) where
 * stack-discipline is sufficient.
 */

import { type RenderContext } from "@agentick/compiler-next";
import { createContext, useContext } from "react";

const RenderContextCtx = createContext<RenderContext | null>(null);

export const RenderContextProvider = RenderContextCtx.Provider;

class CachedRejection {
  constructor(readonly error: unknown) {}
}

/**
 * `useData(key, fetcher)` — suspend-via-throw + cache. Reads the
 * compiler's RenderContext from React Context; throws if called
 * outside a `compileToTree` / `render` call.
 *
 * Semantics match compiler-next's `useData`:
 *   - cached value      → returns it
 *   - cached rejection  → throws the cached error synchronously
 *   - fetch in flight   → throws the in-flight Promise
 *   - nothing in flight → kicks off fetcher, throws Promise
 */
export function useData<T>(key: string, fetcher: () => Promise<T>): T {
  const ctx = useContext(RenderContextCtx);
  if (!ctx) {
    throw new Error(
      "useData called outside a compiler-react-next render. Templates that use " +
        "useData must be rendered via compileToTree() / render() from " +
        "@agentick/compiler-react-next.",
    );
  }
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
        ctx.cache.set(key, new CachedRejection(err));
        ctx.pending.delete(key);
        // Propagate the rejection — compileToTree's loop awaits pending
        // and surfaces the error there. The cache also holds the
        // CachedRejection so any subsequent render re-throws synchronously.
        throw err;
      },
    );
    ctx.pending.set(key, pending);
  }
  throw pending;
}
