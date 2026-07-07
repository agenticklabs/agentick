/**
 * `@agentick/gates-next` — reconciler-agnostic descriptor types and factory
 * for the gate pattern.
 *
 * Gates are knob-backed continuation conditions over `@agentick/knobs-next`.
 * A gate blocks loop completion until cleared. Two species:
 *
 *   - **Latch gates** (`activateWhen`) — edge-triggered; the model
 *     clears via `set_knob` (three states: `inactive`/`active`/`deferred`).
 *   - **Verified gates** (`satisfied`) — level-triggered; a code
 *     predicate evaluated every tick auto-clears on pass and re-engages
 *     on regression. Backing knob is read-only to the model.
 *
 * The gate's value lives in the session's KnobsHarness — gates have no
 * independent state, no separate harness, no inbox address.
 *
 * **The hook lives in `@agentick/gates-next/react`**:
 * ```ts
 * import { useGate } from "@agentick/gates-next/react";
 * ```
 *
 * Non-React reconcilers (Angular, Vue) implement their own gate hook
 * against the same descriptor shapes.
 */

export { gate, isVerifiedGate, GATE_OPTIONS, VERIFIED_GATE_OPTIONS } from "./descriptor.js";
export type {
  GateDescriptor,
  LatchGateDescriptor,
  VerifiedGateDescriptor,
  GateValue,
} from "./descriptor.js";
