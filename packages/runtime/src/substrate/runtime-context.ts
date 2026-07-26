/**
 * RuntimeContext FiberRef substrate — the in-fiber PROPAGATION mechanism for
 * the ctx trunk.
 *
 * The `RuntimeContext` TYPE (and `EMPTY_CONTEXT` / `RuntimeContextUser`) moved
 * to `@agentick/spec` (ADR 91 §1 — the trunk is pure data with zero runtime
 * deps, so it belongs behind the firewall). This module keeps the MECHANISM:
 * the FiberRef that holds the active trunk and the `getContext` / `withContext`
 * / `readContext` surface over it. The type is re-exported here so substrate
 * imports stay local (clean-imports convention).
 *
 *   - **Inside Effect**: substrate code reads via `yield* getContext` and
 *     scopes via `withContext(scope, effect)`. FiberRef-backed.
 *   - **Outside Effect** (adopter tool handlers, middleware, hooks):
 *     receive `ctx` as a deps parameter (per ADR 43); JS closure semantics
 *     propagate it through any async chain the function authors. Do NOT
 *     call `readContext()` inside an active Effect fiber — nested
 *     `Effect.runSync` starts a fresh root fiber that doesn't inherit
 *     the outer's FiberRef. Use `yield* getContext` inside Effect.
 *
 * Per ADR 45/91 — see `docs/proposals/v2/blueprint/45-runtime-context-model.md`
 * and `docs/proposals/v2/blueprint/91-ctx-spine.md`.
 */

import { Effect, FiberRef } from "effect";

import { EMPTY_CONTEXT, type RuntimeContext } from "@agentick/spec";

// The trunk type + empty value + adopter-augmentation seed now live in spec.
// Re-exported so `@agentick/runtime` consumers keep importing them from here.
export { EMPTY_CONTEXT, type RuntimeContext, type RuntimeContextUser } from "@agentick/spec";

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
 * Synchronous accessor for the active runtime context.
 *
 * ## Honest contract
 *
 * **Works correctly:**
 *   - Called from raw JS at the top of a chain where the runtime has
 *     been set via a single `withContext(...)` scope that wraps the
 *     synchronous portion of the call (rare in v2; the substrate
 *     usually keeps context inside Effect chains).
 *
 * **Does NOT work as expected — returns `EMPTY_CONTEXT`:**
 *   - Called from INSIDE an active Effect fiber. Internally runs
 *     `Effect.runSync(getContext)` — that nested `runSync` starts a
 *     FRESH root fiber that does NOT inherit the outer fiber's
 *     FiberRef state. Use `yield* getContext` inside Effect chains.
 *   - Called from inside a Promise chain that's being awaited by an
 *     Effect (via `Effect.tryPromise`). The Promise's continuation
 *     runs outside the fiber; FiberRef is invisible there.
 *
 * **Preferred patterns** (per ADR 45):
 *   - **Adopter code**: receive `ctx` as a parameter via deps. JS
 *     closure semantics propagate ctx through any async chain you
 *     author. No `readContext()` call needed inside the body.
 *   - **Substrate code**: use `yield* getContext` inside Effect
 *     chains. Effect-native, fiber-aware, works correctly.
 *   - **Lifting between worlds**: use `liftHandler` / `liftToEffect`
 *     to capture ctx from FiberRef at lift time and thread it
 *     through deps to a plain-async handler.
 *
 * `readContext()` exists for the narrow case where neither pattern
 * fits — top-level subscribers / plugin hooks with fixed signatures
 * that don't receive deps. Use sparingly. Prefer refactoring the
 * callsite to receive ctx explicitly.
 *
 * @see docs/proposals/v2/blueprint/45-runtime-context-model.md
 */
export function readContext(): RuntimeContext {
  try {
    return Effect.runSync(getContext);
  } catch {
    return EMPTY_CONTEXT;
  }
}

/**
 * Run an Effect with the supplied scope merged into the ambient
 * runtime context. Visible to nested reads via `getContext`.
 *
 * Merge rule: inner wins on collision. Partial scope — only the
 * fields you specify are overlaid; unspecified fields keep their
 * ambient values.
 */
export function withContext<R, E, A>(
  scope: Partial<RuntimeContext>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const current = yield* FiberRef.get(RuntimeContextRef);
    const merged: RuntimeContext = { ...current, ...scope };
    return yield* Effect.locally(RuntimeContextRef, merged)(effect);
  });
}

// NOTE: `runWithContext` / `runWithContextAsync` — the v1 `Context.run(...)`
// sync-scoped-set analogs — are deliberately NOT shipped. Per ADR 45:
//
//   `Effect.runSync(withContext(scope, Effect.sync(fn)))` looks like
//   it should work but doesn't — the nested `Effect.runSync(getContext)`
//   inside `readContext()` starts a fresh fiber that doesn't inherit
//   the outer's locally-scoped FiberRef value. Faithfully imitating
//   v1's ALS-based Context.run would require AsyncLocalStorage as a
//   parallel substrate the FiberRef stays in sync with.
//
// The v2 design rejects ALS coupling — Node-tie, worker-thread caveat,
// cross-runtime portability cost — in favor of closure-capture-via-deps
// (the primary propagation pattern for adopter code) plus FiberRef-
// native propagation inside Effect chains. See:
//
//   docs/proposals/v2/blueprint/45-runtime-context-model.md — §"What
//   we considered and rejected — sync `runWithContext` primitive."
//
// Callers wanting a scoped sync set should either:
//   (a) Restructure to receive ctx via a deps parameter (closure
//       capture handles propagation through any async work).
//   (b) Enter Effect-land at the boundary:
//       `Effect.runPromise(withContext(scope, eff))`.
