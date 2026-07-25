/**
 * `PromiseView<T>` — the Promise-typed edge view of an Effect-canonical
 * harness surface (ADR 77, the dual-typed edge).
 *
 * v2's operation spine composes as one Effect fiber tree; a harness's
 * **canonical** surface is therefore Effect-returning (its `.fx` twin —
 * `set(input): Effect<void, E, never>`). The plain, Promise-returning
 * method a caller reaches at the entity edge (`harness.set(input):
 * Promise<void>`) is the *facade*: `runPromise` applied at the boundary.
 *
 * `PromiseView` is the type-level derivation of that facade from the
 * canonical surface. It rewrites every Effect-returning method to its
 * awaited Promise form and passes non-Effect members through unchanged:
 *
 *     interface KnobsFx {
 *       set(input: KnobsSetInput): Effect.Effect<void, SubstrateError, never>;
 *     }
 *     type KnobsAsync = PromiseView<KnobsFx>;
 *     //   ⇒ { set(input: KnobsSetInput): Promise<void> }
 *
 * ## Why derivation runs one way only
 *
 * A `Promise<A>` carries no typed-error channel. You can erase `E` to go
 * `Effect<A, E, R> → Promise<A>`, but you cannot recover `E` going the
 * other way — the information is simply gone. So **Effect is the source
 * of truth**: author the `Fx` twin by hand, derive the Promise view. There
 * is deliberately no `EffectView<Promise-surface>` inverse; it would have
 * to invent an error channel.
 *
 * This is the *type-level* dual of `liftToEffect` in `@agentick/utils`
 * (the *runtime* boundary bridge, ADR 45): one maps the value across the
 * Effect⇄Promise edge, the other maps the type.
 *
 * @see docs/proposals/v2/blueprint/77-operation-spine-and-dual-typed-edge.md
 */

import type { Effect } from "effect";

/**
 * Map an Effect-canonical surface to its Promise-typed edge view.
 *
 * Homomorphic over `T` — `readonly` and optional (`?`) modifiers on each
 * member are preserved. A member whose type is an Effect-returning
 * function `(...args) => Effect<R, E, Ctx>` becomes `(...args) =>
 * Promise<R>` (the `E` and `Ctx` channels are dropped — `runPromise`
 * rejects on `E` and requires `Ctx = never`). Every other member — sync
 * accessors, plain fields — passes through untouched.
 *
 * ## INVARIANT — keep this homomorphic (`[K in keyof T]`)
 *
 * The `Fx` twin is the single source of truth for BOTH type and doc: a
 * homomorphic mapped type preserves each source member's JSDoc, so the
 * doc authored once on `XFx.method` surfaces on the derived Promise
 * method too (verified — see `promise-view.spec`). Rewriting this into a
 * NON-homomorphic form — key-remapping (`[K in keyof T as ...]`), a union
 * wrapper, an intersection — silently drops that JSDoc. Doc loss does not
 * fail `tsc`: types still resolve, every suite stays green, only the
 * hover goes blank. The `promise-view.spec` regression test is the ONLY
 * guard. Do not "simplify" this shape.
 */
export type PromiseView<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Effect.Effect<infer R, infer _E, infer _Ctx>
    ? (...args: A) => Promise<R>
    : T[K];
};
