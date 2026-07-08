/**
 * `@agentick/gates-next/react` — React front-end for the gate pattern.
 *
 * `useGate` is a REGISTRATION-ONLY binding over the reconciler-agnostic
 * {@link GatesController} (ADR 67): it registers the descriptor on mount,
 * unregisters on unmount, and reflects the gate's knob value. It does NOT
 * wire tick-end evaluation — that is driven by `session.notifyLifecycle`.
 * `useGates()` returns the curated {@link GatesHandle} — the in-scope
 * gates surface, the SAME shape `session.gates` exposes. The remaining
 * context surface (`GatesContext`, `GatesProvider`) resolves the
 * controller; adopters rarely touch it directly. The raw
 * `GatesController` accessor is intentionally internal (not exported
 * here). Re-exports the descriptor types + controller types so everything
 * is reachable from this subpath.
 */

export { useGate, type GateState } from "./use-gate.js";
export { GatesContext, GatesProvider, useGates, type GatesProviderProps } from "./gates-context.js";

// Re-export descriptor + controller types so adopters can pull
// everything from /react.
export { gate, isVerifiedGate, GATE_OPTIONS, VERIFIED_GATE_OPTIONS } from "../descriptor.js";
export type {
  GateDescriptor,
  LatchGateDescriptor,
  VerifiedGateDescriptor,
  GateValue,
} from "../descriptor.js";
export { GatesController } from "../controller.js";
export type {
  GatesControllerDeps,
  GatesParentLayer,
  GateKnobs,
  LoopControlSeam,
  GateOverrideAudit,
  GateInfo,
  GateHandle,
  GatesHandle,
} from "../controller.js";
