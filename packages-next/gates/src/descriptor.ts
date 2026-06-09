/**
 * Gates — reconciler-agnostic descriptor types and factory.
 *
 * A gate is a three-state knob (`inactive` / `active` / `deferred`) that
 * blocks loop completion until the model explicitly clears it. The
 * descriptor (`GateDescriptor`) and `gate()` factory live here because
 * they're pure data — no reconciler dependency.
 *
 * The consumer hook (`useGate`) is React-specific and lives in
 * `@agentick/gates-next/react`. Other reconcilers (Angular, Vue) would
 * implement their own equivalent against the same descriptor shape.
 */

import type { TickResult } from "@agentick/spec-next";

export type GateValue = "inactive" | "active" | "deferred";

export interface GateDescriptor {
  /** Short human-readable label. Surfaced via the knob bridge. */
  readonly description: string;
  /** Instructions shown to the model when the gate is `active`. */
  readonly instructions: string;
  /** Predicate that auto-activates the gate at tick-end. */
  readonly activateWhen: (result: TickResult) => boolean;
}

/**
 * The three known gate values, surfaced as `options` for the underlying
 * knob descriptor so the model's `set_knob` tool sees the gate as a
 * select with three known values.
 */
export const GATE_OPTIONS: readonly GateValue[] = ["inactive", "active", "deferred"];

/**
 * Trivial descriptor factory. Exists so authors can declare gates at
 * module scope (`const verificationGate = gate({ … });`) and pass the
 * descriptor into the reconciler's gate hook (e.g.,
 * `useGate(name, verificationGate)` in React).
 */
export function gate(opts: GateDescriptor): GateDescriptor {
  return opts;
}
