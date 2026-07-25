/**
 * Gates React context — the vehicle that carries the session's
 * {@link GatesController} into the tree.
 *
 * Gates deliberately gets NO `HookBridges` harness slot (it owns no
 * state; a gate's value is a knob value). Per ADR 27 the right vehicle
 * for tree access to the controller is a compiler-react React context,
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
 * Whatever the source, the hook only RESOLVES the controller and returns
 * it (ADR 67). Tick-end evaluation is driven by `session.notifyLifecycle`
 * — the hook no longer subscribes a per-mount tick-end source.
 */

import React, { createContext, useContext, useRef, type ReactNode } from "react";
import type { HookBridges } from "@agentick/spec";
import { useBridges } from "@agentick/compiler-react";
// Side-effect: register the `HookBridges.knobs` slot so `bridges.knobs`
// is typed here (gates reads the session's KnobsHarness off the bundle).
import "@agentick/knobs";

import { GatesController, type GatesHandle, type LoopControlSeam } from "../controller.js";

/**
 * A no-op loop seam for the mount-local fallback controller (a `useGate`
 * render with no session). Standalone mounts have no loop to hold — no
 * `session.notifyLifecycle` drives them — so the seam is inert. The real
 * session injects a live loop bridge into its own controller.
 */
const NOOP_LOOP: LoopControlSeam = {
  continueAfterTick: () => {},
  stopAfterTick: () => {},
};

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
 * PUBLIC accessor — resolve the in-scope gates surface as the curated
 * {@link GatesHandle} (`register` / `get` / `list` / `clear`), the SAME
 * shape `session.gates` exposes. Mirrors `useKnob` → `session.knobs`.
 *
 * The raw {@link GatesController} is intentionally NOT returned — it is an
 * internal impl surface (`unregister`, `handleTickEnd`, …).
 * `Controller` is not a public v2 noun; the vocabulary is
 * Harness/Bridge/Handle/Store.
 */
export function useGates(): GatesHandle {
  return useGatesController();
}

/**
 * INTERNAL accessor — resolve the in-scope {@link GatesController}
 * (context → session-transported → mount-local fallback). Registration
 * only (ADR 67): it does NOT subscribe a tick-end source. Evaluation is
 * driven by `session.notifyLifecycle`. Not exported from the package
 * index (`/react`); the PUBLIC hook is {@link useGates}, which returns
 * the curated {@link GatesHandle}. Kept for the fuller controller surface
 * {@link useGate} needs (`register` / `unregister` / `get`).
 */
export function useGatesController(): GatesController {
  const ctxController = useContext(GatesContext);
  const bridges = useBridges();

  const shared = ctxController ?? transportedController(bridges);

  // Mount-local fallback — constructed once, only when no shared
  // controller exists (a `useGate` render with no session). No hooks in
  // this branch, so the rules of hooks hold regardless of which path a
  // mount takes across its lifetime (a session either always transports a
  // controller or never does). No live loop drives it — standalone gates
  // register their knob but are not evaluated without a session.
  const localRef = useRef<GatesController | null>(null);
  if (!shared && localRef.current === null) {
    localRef.current = new GatesController({
      knobs: bridges.knobs,
      loopControl: NOOP_LOOP,
    });
  }
  return shared ?? localRef.current!;
}
