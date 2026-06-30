/**
 * Lift a sync / async / Effect function into an Effect-returning function.
 *
 * Per ADR 45 (Runtime context model — closure-capture propagation): adopter
 * code crosses into framework substrate via lift helpers like this one.
 * The substrate's call sites are Effect-typed; adopter code is typically
 * Promise-typed. `liftToEffect` is the type-shape bridge.
 *
 * ## Idempotence
 *
 * The lift is idempotent on its return type: if `fn` already returns an
 * `Effect`, the lifted function passes it through unchanged (no double-
 * wrap). If `fn` returns a Promise or a plain value, the lift wraps via
 * `Effect.tryPromise`. Adopters apply the lift unconditionally without
 * checking the underlying return shape.
 *
 * ## What it does NOT do
 *
 * - **Does NOT capture context.** The lifted function runs inside whichever
 *   fiber the caller is in. If the caller is inside Effect, the wrapped
 *   `fn` runs inside `Effect.tryPromise`, which awaits the Promise. The
 *   Promise's continuation runs OUTSIDE the fiber (per the FiberRef
 *   propagation rules — see ADR 45). If `fn` needs ambient context, it
 *   must receive it via a deps parameter (closure-capture), not via
 *   `readContext()` calls inside its body.
 *
 * - **Does NOT typed-narrow errors.** The `E` type parameter is what the
 *   caller declares; the lift trusts it. Pass an `errorMap` to coerce the
 *   thrown `unknown` into a typed error class.
 *
 * For surface-specific lifts that DO context-capture and propagate ctx
 * via deps (e.g., `liftHandler` for tool handlers), see the package that
 * owns the surface — those compose `liftToEffect` underneath plus
 * `yield* getContext` for the capture.
 *
 * @see docs/proposals/v2/blueprint/45-runtime-context-model.md §"The
 *      lift helper preserves the pattern"
 */

import { Effect } from "effect";

/**
 * Lift any sync-or-async-or-Effect function into an Effect-returning
 * function. Idempotent on Effect-returning inputs.
 *
 * @example
 *     // Plain async function:
 *     const fetchUser = async (id: string) => fetch(`/api/users/${id}`);
 *
 *     // Lifted — now composable in Effect chains:
 *     const fetchUserEff = liftToEffect(fetchUser);
 *     yield* fetchUserEff("42");  // Effect.Effect<Response, unknown>
 *
 * @example
 *     // With typed error mapping:
 *     const fetchUserEff = liftToEffect(
 *       fetchUser,
 *       (err) => new FetchFailed({ cause: err }),
 *     );
 *     yield* fetchUserEff("42");  // Effect.Effect<Response, FetchFailed>
 */
export function liftToEffect<Args extends readonly unknown[], A, E = unknown>(
  fn: (...args: Args) => A | Promise<A> | Effect.Effect<A, E>,
  errorMap?: (err: unknown) => E,
): (...args: Args) => Effect.Effect<A, E> {
  return (...args) =>
    // `Effect.suspend` defers `fn(...args)` invocation until the
    // Effect is actually run (via `yield*` / `runPromise` / `fork` /
    // etc.). Matches Effect's lazy convention — the lifted call site
    // produces an unrun Effect; the value/promise doesn't materialize
    // until composition runs it. Without `suspend`, async fns would
    // start executing at the lift call (the function body runs until
    // the first await) which leaks side effects into construction.
    Effect.suspend(() => {
      const result = fn(...args);
      if (Effect.isEffect(result)) return result;
      return Effect.tryPromise({
        try: () => Promise.resolve(result),
        catch: errorMap ?? ((err: unknown) => err as E),
      });
    });
}
