/**
 * `@agentick/gates-next/react` — React front-end for the gate pattern.
 *
 * `useGate` is a thin binding over the reconciler-agnostic
 * {@link GatesController}. The context surface (`GatesContext`,
 * `GatesProvider`, `useGatesController`, `GatesRuntime`) resolves + wires
 * the controller; adopters rarely touch it directly. Re-exports the
 * descriptor types + controller types so everything is reachable from
 * this subpath.
 */

export { useGate, type GateState } from "./use-gate.js";
export {
  GatesContext,
  GatesProvider,
  GatesRuntime,
  useGatesController,
  type GatesProviderProps,
} from "./gates-context.js";

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
  GateKnobs,
  LoopControlSeam,
  TickEndSeam,
  GateOverrideAudit,
  GateInfo,
  GateHandle,
  GatesHandle,
} from "../controller.js";
