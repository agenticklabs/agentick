/**
 * Per-render ambient state for `useData` + any other walker-portable
 * suspend-via-throw primitive. One `RenderContext` per `compileToTree`
 * invocation, threaded via lexically-scoped stack discipline.
 *
 * Why stack-discipline (and NOT `node:async_hooks` / Effect FiberRef):
 *
 *  - `async_hooks` is Node-only. Breaks browser, Deno (partial), Bun,
 *    edge runtimes. Compiler-next aims to ship anywhere JS runs.
 *  - Effect FiberRef can't be read from inside plain JS user code
 *    (React function components aren't `Effect.gen`). Wrong layer.
 *
 * Stack discipline works because `withRenderContext` only ever wraps
 * SYNCHRONOUS work — the actual render pass. The compile-until-stable
 * loop awaits suspended Promises OUTSIDE the wrapper, so the
 * module-level singleton is correctly scoped: each pass SETs on entry
 * and RESTOREs on exit (try/finally), and concurrent compiles never
 * cross awaits with the singleton populated.
 *
 * @see compile.ts for the loop that drives this contract
 */

import { isThenable as isThenableFromUtils } from "@agentick/utils-next";

/**
 * Per-render state. Cache holds resolved data; pending tracks in-flight
 * fetches so concurrent `useData` calls on the same key share a Promise.
 */
export interface RenderContext {
  readonly cache: Map<string, unknown>;
  readonly pending: Map<string, Promise<unknown>>;
}

/**
 * The active context — set by `withRenderContext`, read by `useData`.
 * Module-level for lexical-scope simplicity; safe under stack discipline
 * because the wrapper never awaits.
 */
let activeContext: RenderContext | undefined;

/**
 * Run `body` with `ctx` as the active render context. SYNCHRONOUS only —
 * callers MUST NOT await inside `body`. The compile loop honors this by
 * doing the suspend-await OUTSIDE the wrapper.
 */
export function withRenderContext<T>(ctx: RenderContext, body: () => T): T {
  const prev = activeContext;
  activeContext = ctx;
  try {
    return body();
  } finally {
    activeContext = prev;
  }
}

/**
 * Read the active context. Throws if called outside a
 * `withRenderContext` scope — `useData` is meaningless without one.
 */
export function getRenderContext(): RenderContext {
  if (!activeContext) {
    throw new Error(
      "useData called outside a compiler render scope. Templates that use " +
        "useData must be rendered via a compiler-react-next (or other " +
        "framework adapter) render entry point.",
    );
  }
  return activeContext;
}

/**
 * Construct a fresh empty render context — one per compile invocation.
 */
export function createRenderContext(): RenderContext {
  return { cache: new Map(), pending: new Map() };
}

/**
 * Re-export — keep the compiler's suspend mechanism in sync with the
 * canonical predicate in `@agentick/utils-next`.
 */
export const isThenable = isThenableFromUtils;
