/**
 * Gates React context — the vehicle that carries the session's
 * {@link GatesController} into the tree.
 *
 * Gates deliberately gets NO `HookBridges` harness slot (it owns no
 * state; a gate's value is a knob value). Per ADR 27 the right vehicle
 * for tree access to the controller is a reconciler-react React context,
 * NOT a typed `HookBridges` slot. Resolution order in {@link useGatesController}:
 *
 *   1. An explicit `<GatesProvider>` in the tree (advanced/manual wiring).
 *   2. The session-supplied controller transported on the bridge bundle
 *      (`bridges.gates`) — how the real `session.gates` and every
 *      `useGate` converge on ONE controller (unified registry). The
 *      transport rides the existing `BridgeContext` (itself a React
 *      context); it is a runtime property, never a typed `HookBridges`
 *      slot, and is not snapshot-captured.
 *   3. A mount-local controller wired from the bridges the hook can see
 *      — the isolated path (a `useGate` render with no session, e.g.
 *      harness-level tests). Behaviorally identical to the old inline
 *      wiring.
 *
 * Whatever the source, the hook attaches THIS mount's tick-end source to
 * the controller (ref-counted) so the single shared wiring runs.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { HookBridges, LifecycleTickEnd, TickResult } from "@agentick/spec-next";
import { useBridges, useLifecycleStore, useLoopControl } from "@agentick/reconciler-react-next";
// Side-effect: register the `HookBridges.knobs` slot so `bridges.knobs`
// is typed here (gates reads the session's KnobsHarness off the bundle).
import "@agentick/knobs-next";

import { GatesController, type LoopControlSeam, type TickEndSeam } from "../controller.js";

export const GatesContext = createContext<GatesController | null>(null);
GatesContext.displayName = "AgentickGatesContext";

export interface GatesProviderProps {
  readonly value: GatesController;
  readonly children?: ReactNode;
}

/**
 * Provide an explicit controller to a subtree. Rarely needed — the
 * session transports its controller on the bridge bundle automatically.
 * Useful for adopters constructing a controller by hand (headless hosts,
 * bespoke tests).
 */
export function GatesProvider({ value, children }: GatesProviderProps): React.ReactElement {
  return React.createElement(GatesContext.Provider, { value }, children);
}

/** Read the session-transported controller off the bridge bundle, if any. */
function transportedController(bridges: HookBridges): GatesController | undefined {
  return (bridges as { gates?: GatesController }).gates;
}

/**
 * Resolve the in-scope {@link GatesController} and attach this mount's
 * tick-end source to it. Called by {@link useGate}; also usable directly
 * to wire the controller when a session has programmatic-only gates and
 * no `useGate` in the tree (mount {@link GatesRuntime}).
 */
export function useGatesController(): GatesController {
  const ctxController = useContext(GatesContext);
  const bridges = useBridges();
  const lifecycle = useLifecycleStore();

  // Keep the loop bridge fresh — a per-execution loop bridge is tracked
  // via the getter passed to the local controller.
  const loop = useLoopControl();
  const loopRef = useRef<LoopControlSeam>(loop);
  loopRef.current = loop;

  const shared = ctxController ?? transportedController(bridges);

  // Mount-local fallback — constructed once, only when no shared
  // controller exists. No hooks in this branch, so the rules of hooks
  // hold regardless of which path a mount takes across its lifetime
  // (a session either always transports a controller or never does).
  const localRef = useRef<GatesController | null>(null);
  if (!shared && localRef.current === null) {
    localRef.current = new GatesController({
      knobs: bridges.knobs,
      loopControl: () => loopRef.current,
    });
  }
  const controller = shared ?? localRef.current!;

  const onTickEnd: TickEndSeam = useMemo(
    () => (cb) =>
      lifecycle.register("tick-end", (event: LifecycleTickEnd) => cb(event.result as TickResult)),
    [lifecycle],
  );

  useEffect(() => controller.attach(onTickEnd), [controller, onTickEnd]);

  return controller;
}

/**
 * Zero-render component that wires the in-scope controller to the
 * mount's tick-end source. Mount it when a session declares gates only
 * programmatically (`session.gates.register(...)`) with no `useGate` in
 * the tree, so those gates are still evaluated every tick.
 *
 * TODO(gates-auto-runtime): a future generic reconciler-owned provider
 * seam could mount this automatically for every session, removing the
 * manual step. Today reconciler-react has no gates dependency by design.
 */
export function GatesRuntime(): null {
  useGatesController();
  return null;
}
