/**
 * The per-call emission target (ADR 102) — the bus every harness in one
 * dynamic call tree publishes to.
 *
 * The app-shared spine (model executor, loop, compiler) is ONE instance per
 * app, constructed on the app's bus, so under a scope-node topology its
 * frames — model deltas above all — would land at the root and never at the
 * session's node. A session scopes its own bus around the execution instead,
 * and the ADR 77 one-fiber spine carries it to every nested `runOperation`,
 * exactly as the tier-4 middleware FiberRef does.
 *
 * @see docs/proposals/v2/blueprint/102-subscription-bus-topology.md
 */

import { Effect, FiberRef } from "effect";
import type { EventBus } from "@agentick/spec";

/** Process-global by design, like `RuntimeContextRef` and `CallMiddlewareRef`. */
const EmissionBusRef = FiberRef.unsafeMake<EventBus | undefined>(undefined);

/** The ambient target, or `undefined` when the emitting harness's own bus stands. */
export const getEmissionBus: Effect.Effect<EventBus | undefined> = FiberRef.get(EmissionBusRef);

/**
 * Land every emission `effect` transitively makes on `bus` rather than on
 * the emitting harness's own. Nested scopings override — the innermost wins.
 */
export function withEmissionBus<A, E, R>(
  bus: EventBus,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.locally(EmissionBusRef, bus as EventBus | undefined)(effect);
}
