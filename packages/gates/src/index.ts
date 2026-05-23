/**
 * `@agentick/gates` — knob-backed continuation conditions.
 *
 * Gates are a UX pattern over `@agentick/knobs`. A gate is a three-state
 * knob (`inactive` / `active` / `deferred`) that blocks loop completion
 * until the model clears it. The gate's value lives in the session's
 * KnobsHarness — gates have no independent state, no separate harness,
 * no inbox address. They are a pure composition: `useKnob` for the
 * three-state cell + `useOnTickEnd` for activation + `useLoopControl`
 * for continuation.
 *
 * @see packages/gates/src/use-gate.ts
 */

export { useGate, gate } from "./use-gate.js";
export type { GateDescriptor, GateState, GateValue } from "./use-gate.js";
