/**
 * Gates — compiler-agnostic descriptor types and factory.
 *
 * A gate is a knob-backed continuation condition that blocks loop
 * completion until it is cleared. Two species, discriminated by the
 * descriptor:
 *
 * **Latch gates** (`activateWhen`) — edge-triggered, model-cleared. The
 * predicate arms the gate once (consulted only while `inactive`);
 * release is explicit: the model sets the knob via `set_knob`, or host
 * code calls `clear()`. Use when the condition is not checkable in code
 * and the model must attest.
 *
 * **Verified gates** (`satisfied`) — level-triggered, code-cleared. The
 * predicate is evaluated at the end of EVERY tick: the gate engages
 * whenever the predicate fails and clears automatically the moment it
 * passes — including re-engaging if a later tick regresses the
 * condition. The backing knob is registered read-only, so the model
 * cannot `set_knob` past a failing check; the predicate is the only
 * authority. Use for invariants code can check. An optional
 * `activateWhen` ARMS the gate (edge-triggered, sticky) so the
 * invariant only applies once something made it relevant — dormant
 * gates neither verify nor block.
 *
 * The descriptors and `gate()` factory live here because they're pure
 * data — no compiler dependency. The consumer hook (`useGate`) is
 * React-specific and lives in `@agentick/gates-next/react`. Other
 * compilers (Angular, Vue) would implement their own equivalent
 * against the same descriptor shapes.
 */

import type { TickResult } from "@agentick/spec-next";

export type GateValue = "inactive" | "active" | "deferred";

/**
 * Latch gate: edge-triggered arming, explicit release.
 */
export interface LatchGateDescriptor {
  /** Short human-readable label. Surfaced via the knob bridge. */
  readonly description: string;
  /** Instructions shown to the model when the gate is `active`. */
  readonly instructions: string;
  /**
   * Arming predicate, consulted at tick-end only while the gate is
   * `inactive`. Once armed, the gate stays engaged until the model
   * clears the knob or host code calls `clear()`.
   */
  readonly activateWhen: (result: TickResult) => boolean;
}

/**
 * Verified gate: level-triggered verification, automatic clearing.
 */
export interface VerifiedGateDescriptor {
  /** Short human-readable label. Surfaced via the knob bridge. */
  readonly description: string;
  /** Instructions shown to the model when the gate is `active`. */
  readonly instructions: string;
  /**
   * Verification predicate, evaluated at the end of every tick (after
   * tool results are in — v2 `TickResult.toolResults` carries executed
   * results). Returning `false` engages the gate; returning `true`
   * clears it. May be async — the lifecycle store awaits tick-end
   * handlers.
   *
   * A thrown error is treated as UNSATISFIED (fail-closed): the v2
   * lifecycle store isolates handler errors rather than propagating
   * them, so a broken verifier must engage the gate, not silently let
   * the loop complete.
   */
  readonly satisfied: (result: TickResult) => boolean | Promise<boolean>;
  /**
   * Optional ARMING predicate — scopes when the obligation applies.
   *
   * While unarmed, the gate is dormant: `satisfied` is not evaluated
   * and the gate never blocks. Arming is edge-triggered and sticky:
   * the first tick where `activateWhen(result)` returns true arms the
   * gate for the rest of the execution, and verification (including
   * same-tick) takes over from there.
   *
   * Omit to arm from the first tick — the obligation always applies
   * (e.g., "a validated submission must exist before finishing").
   * Provide it for conditional invariants — "once files were edited,
   * the typecheck must pass" shouldn't block a turn that edited
   * nothing.
   */
  readonly activateWhen?: (result: TickResult) => boolean;
}

export type GateDescriptor = LatchGateDescriptor | VerifiedGateDescriptor;

/**
 * The three known gate values for LATCH gates, surfaced as `options`
 * for the underlying knob descriptor so the model's `set_knob` tool
 * sees the gate as a select with three known values.
 */
export const GATE_OPTIONS: readonly GateValue[] = ["inactive", "active", "deferred"];

/**
 * Verified gates have no `deferred` state — their lifecycle is owned
 * entirely by the predicate. The knob is registered read-only, so
 * these options are informational (the model reads but cannot set).
 */
export const VERIFIED_GATE_OPTIONS: readonly GateValue[] = ["inactive", "active"];

/** Discriminate the two gate species at runtime. */
export function isVerifiedGate(opts: GateDescriptor): opts is VerifiedGateDescriptor {
  return "satisfied" in opts && typeof (opts as VerifiedGateDescriptor).satisfied === "function";
}

/**
 * Trivial descriptor factory. Exists so authors can declare gates at
 * module scope (`const verificationGate = gate({ … });`) and pass the
 * descriptor into the compiler's gate hook (e.g.,
 * `useGate(name, verificationGate)` in React).
 */
export function gate(opts: GateDescriptor): GateDescriptor {
  return opts;
}
