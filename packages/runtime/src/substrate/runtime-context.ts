/**
 * RuntimeContext — scope identity that propagates through Effect fibers.
 *
 * One substrate, one truth. The active runtime scope (sessionId,
 * executionId, tickId, opId, parentOpId, correlationId, plus a
 * caller-supplied request bag) lives in an Effect `FiberRef`. It
 * inherits across forks, propagates across structured concurrency
 * boundaries, and (when the cluster substrate lands) is serializable
 * across nodes.
 *
 *   - **Effect-native readers** use `getContext`.
 *   - **Effect-native writers** layer scope via `withContext(scope, eff)`.
 *
 * Promise-shaped consumers do NOT have a parallel surface here. Code
 * that needs to bridge crosses at the runtime edge with
 * `Effect.runPromise` / `Effect.promise`, where the FiberRef remains
 * the source of truth. We do not maintain an AsyncLocalStorage mirror —
 * ALS is the wrong primitive for an actor substrate where addresses
 * outlive any single async call stack.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The MessageInbox / §BaseHarness
 */

import { Effect, FiberRef } from "effect";

// ============================================================================
// Scope shape
// ============================================================================

/**
 * The runtime scope a handler / middleware / observer sees. Every
 * field is optional — outside any bracket they are `undefined`.
 */
export interface RuntimeContext {
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly tickId?: string;
  readonly opId?: string;
  /** Parent op id for causality. */
  readonly parentOpId?: string;
  /** Request bundle id when one user request spawns many ops. */
  readonly correlationId?: string;
  /** Caller-supplied bag (traceparent, userId, etc.). */
  readonly request?: Readonly<Record<string, unknown>>;
}

/** The "no scope active" value. */
export const EMPTY_CONTEXT: RuntimeContext = Object.freeze({});

// ============================================================================
// FiberRef substrate
// ============================================================================

/**
 * The FiberRef that holds the active runtime context. Substrate-
 * internal; `getContext` / `withContext` are the documented surface.
 */
export const RuntimeContextRef = FiberRef.unsafeMake<RuntimeContext>(EMPTY_CONTEXT);

/** Effect-native read. */
export const getContext: Effect.Effect<RuntimeContext> = FiberRef.get(RuntimeContextRef);

/**
 * Run an Effect with the supplied scope merged into the ambient
 * runtime context. Visible to nested reads via `getContext`.
 *
 * Merge rule: inner wins on collision.
 */
export function withContext<R, E, A>(
  scope: RuntimeContext,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const current = yield* FiberRef.get(RuntimeContextRef);
    const merged: RuntimeContext = { ...current, ...scope };
    return yield* Effect.locally(RuntimeContextRef, merged)(effect);
  });
}
