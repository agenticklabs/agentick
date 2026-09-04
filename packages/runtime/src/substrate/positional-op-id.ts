/**
 * Positional operation ids — the deterministic child-key mechanism durable
 * replay rests on.
 *
 * A child operation's opId is `${parentOpId}:${childIndex}` — `parentOpId` is
 * already auto-threaded by `runOperation`, so the only new ingredient is a
 * deterministic `childIndex`: a per-op-scope counter, reset to 0 at each op
 * boundary and incremented once per child op. On a deterministic re-run (same
 * children, same order) each child gets the SAME index → the SAME opId →
 * `lookupTerminal` replays it instead of re-executing. This is what turns the
 * hand-supplied positional keys the proofs used into automatic ones.
 *
 * Step 1 wires ONLY the reset ({@link withFreshChildScope} at `runOperation`
 * entry): the counter resets per op, but nothing reads it yet, so the change is
 * additive and dormant — no opId changes. Consumers ({@link nextChildIndex} +
 * {@link positionalOpId}) are opted into surgically, at the few sites that must
 * replay for durable code mode (a host-driven `tool:dispatch`, an elicit, a
 * code-mode `run`).
 *
 * FiberRef-backed, mirroring `RuntimeContextRef` — the scope propagates in-fiber
 * and `Effect.locally` bounds a reset to exactly one op body.
 */

import { Effect, FiberRef } from "effect";

/**
 * Per-op-scope child counter. Reset to 0 for the duration of each op body (via
 * {@link withFreshChildScope}); a child op reads-and-increments it to claim its
 * position within the current scope. Substrate-internal — go through the helpers.
 */
export const ChildIndexRef = FiberRef.unsafeMake<number>(0);

/**
 * The next child index in the current op scope (get-and-increment). Read once
 * per child op, in the PARENT's scope, before entering the child's own reset.
 */
export const nextChildIndex: Effect.Effect<number> = FiberRef.getAndUpdate(
  ChildIndexRef,
  (n) => n + 1,
);

/**
 * Run `effect` with a FRESH child scope — the counter reset to 0. `runOperation`
 * wraps each op body in this, so the op's children number from 0 within its own
 * scope and a nested op's counter never leaks to (or from) its parent.
 */
export function withFreshChildScope<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.locally(effect, ChildIndexRef, 0);
}

/** The positional opId for a child at `index` under `parentOpId`. */
export function positionalOpId(parentOpId: string, index: number): string {
  return `${parentOpId}:${index}`;
}
