/**
 * Gates — compiler-agnostic descriptor types and factory.
 *
 * A gate is a rule about loop continuation. Three species, discriminated
 * by the descriptor:
 *
 * **Latch gates** (`activateWhen`) — edge-triggered, model-cleared. The
 * predicate arms the gate once (consulted only while `inactive`);
 * release is explicit: the model sets the knob via `knob_set`, or host
 * code calls `clear()`. Use when the condition is not checkable in code
 * and the model must attest.
 *
 * **Verified gates** (`satisfied`) — level-triggered, code-cleared. The
 * predicate is evaluated at the end of EVERY tick: the gate engages
 * whenever the predicate fails and clears automatically the moment it
 * passes — including re-engaging if a later tick regresses the
 * condition. The backing knob is registered read-only, so the model
 * cannot `knob_set` past a failing check; the predicate is the only
 * authority. Use for invariants code can check. An optional
 * `activateWhen` ARMS the gate (edge-triggered, sticky) so the
 * invariant only applies once something made it relevant — dormant
 * gates neither verify nor block.
 *
 * **Stop gates** (`stopWhen`) — the inverse species. Latch and verified
 * gates are value cells that HOLD a loop open; a stop gate ENDS a loop
 * that would continue. It carries no value, registers no backing knob,
 * and is invisible to the model: nothing about it is settable, so there
 * is nothing to show or to forge. {@link stopOnTools} is the shipped
 * factory.
 *
 * The descriptors and `gate()` factory live here because they're pure
 * data — no compiler dependency. The consumer hook (`useGate`) is
 * React-specific and lives in `@agentick/gates/react`. Other
 * compilers (Angular, Vue) would implement their own equivalent
 * against the same descriptor shapes.
 */

import type { TickResult } from "@agentick/spec";

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

/**
 * Stop gate: ends the turn when the predicate holds.
 *
 * Evaluated at TICK END, so a parallel tool batch has fully settled
 * before the predicate is consulted — a stop never interrupts a batch
 * mid-flight.
 */
export interface StopGateDescriptor {
  /** Short human-readable label. Surfaced by `gates:list`. */
  readonly description: string;
  /** Ends the turn when it returns true against the settled tick. */
  readonly stopWhen: (result: TickResult) => boolean;
}

/** The knob-backed species — the two that hold a value the model can read. */
export type ValueGateDescriptor = LatchGateDescriptor | VerifiedGateDescriptor;

export type GateDescriptor = ValueGateDescriptor | StopGateDescriptor;

export type GateSpecies = "latch" | "verified" | "stop";

/**
 * The three known gate values for LATCH gates, surfaced as `options`
 * for the underlying knob descriptor so the model's `knob_set` tool
 * sees the gate as a select with three known values.
 */
export const GATE_OPTIONS: readonly GateValue[] = ["inactive", "active", "deferred"];

/**
 * Verified gates have no `deferred` state — their lifecycle is owned
 * entirely by the predicate. The knob is registered read-only, so
 * these options are informational (the model reads but cannot set).
 */
export const VERIFIED_GATE_OPTIONS: readonly GateValue[] = ["inactive", "active"];

export function isVerifiedGate(opts: GateDescriptor): opts is VerifiedGateDescriptor {
  return "satisfied" in opts && typeof (opts as VerifiedGateDescriptor).satisfied === "function";
}

export function isStopGate(opts: GateDescriptor): opts is StopGateDescriptor {
  return "stopWhen" in opts && typeof (opts as StopGateDescriptor).stopWhen === "function";
}

export function gateSpecies(opts: GateDescriptor): GateSpecies {
  if (isStopGate(opts)) return "stop";
  return isVerifiedGate(opts) ? "verified" : "latch";
}

/**
 * Trivial descriptor factory. Exists so authors can declare gates at
 * module scope (`const verificationGate = gate({ … });`) and pass the
 * descriptor into the compiler's gate hook (e.g.,
 * `useGate(name, verificationGate)` in React). Identity on the type so
 * the species survives — `useGate` accepts only the value species.
 */
export function gate<T extends GateDescriptor>(opts: T): T {
  return opts;
}

/**
 * The turn ends once the tick dispatched one of these tools — the
 * canonical explicit-completion mechanism (`stopOnTools("done")`).
 *
 * Reads the DISPATCHED calls (`toolResults`), not the requested ones: a
 * call an admission guard refused never ran, and must not end the turn.
 */
export function stopOnTools(...names: string[]): StopGateDescriptor {
  if (names.length === 0) throw new Error("stopOnTools() requires at least one tool name.");
  const stopAt = new Set(names);
  return {
    description: `Ends the turn once ${names.join(" or ")} is called`,
    stopWhen: (result) => result.toolResults.some((t) => stopAt.has(t.toolName)),
  };
}
