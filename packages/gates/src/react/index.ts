/**
 * `@agentick/gates/react` — React hook for the gate pattern.
 *
 * Composes `useKnob` + `useOnTickEnd` + `useLoopControl` from the
 * React reconciler ecosystem. Re-exports the descriptor types from
 * the package root so adopters can do everything from this subpath.
 */

export { useGate, type GateState } from "./use-gate.js";

// Re-export descriptor types so adopters can pull everything from /react.
export { gate, GATE_OPTIONS } from "../descriptor.js";
export type { GateDescriptor, GateValue } from "../descriptor.js";
