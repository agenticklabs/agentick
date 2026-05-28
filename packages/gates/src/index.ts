/**
 * `@agentick/gates` — reconciler-agnostic descriptor types and factory
 * for the gate pattern.
 *
 * Gates are knob-backed continuation conditions over `@agentick/knobs`.
 * A gate is a three-state knob (`inactive` / `active` / `deferred`)
 * that blocks loop completion until the model clears it. The gate's
 * value lives in the session's KnobsHarness — gates have no
 * independent state, no separate harness, no inbox address.
 *
 * **The hook lives in `@agentick/gates/react`**:
 * ```ts
 * import { useGate } from "@agentick/gates/react";
 * ```
 *
 * Non-React reconcilers (Angular, Vue) implement their own gate hook
 * against the same `GateDescriptor` shape.
 */

export { gate, GATE_OPTIONS } from "./descriptor.js";
export type { GateDescriptor, GateValue } from "./descriptor.js";
