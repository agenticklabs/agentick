/**
 * Gate — knob-backed continuation condition.
 *
 * A gate blocks execution from completing until it is cleared. Two species,
 * discriminated by their descriptor:
 *
 * **Latch gates** (`activateWhen`) — edge-triggered, model-cleared. The
 * predicate arms the gate once (checked only while inactive); release is
 * explicit: the model sets the knob, or application code calls `clear()`.
 * Use when the condition is not checkable in code and the model must attest
 * ("you edited files — verify your edits before finishing").
 *
 * **Verified gates** (`satisfied`) — level-triggered, code-cleared. The
 * predicate is evaluated at the end of EVERY tick: the gate engages whenever
 * the predicate fails and clears automatically the moment it passes — including
 * re-engaging if a later tick regresses the condition. The backing knob is
 * read-only to the model (set_knob rejects writes), so the model cannot
 * bypass verification; the predicate is the only authority. Use for
 * invariants that code can check ("the submitted extraction reconciles
 * against the document totals"). An optional `activateWhen` ARMS the gate
 * (edge-triggered, sticky) so the invariant only applies once something made
 * it relevant — dormant gates neither verify nor block.
 *
 * Both species auto-render an Ephemeral element with instructions while
 * active, and force continuation (`result.continue`) when the model attempts
 * to stop while the gate is engaged. Explicit `result.stop()` requests from
 * other tick-end callbacks still win — stop beats continue in tick-control
 * arbitration — so budget guards can always terminate a gated loop.
 */

import { createElement, useRef, useCallback } from "react";
import type { JSX } from "react";
import { useOnTickEnd } from "./lifecycle.js";
import { useKnob } from "./knob.js";
import { Ephemeral } from "../jsx/components/messages.js";
import type { TickResult } from "./types.js";

export type GateValue = "inactive" | "active" | "deferred";

/**
 * Latch gate: edge-triggered arming, explicit release.
 */
export interface LatchGateDescriptor {
  description: string;
  instructions: string;
  /**
   * Arming predicate, checked at tick end only while the gate is inactive.
   * Once armed, the gate stays engaged until the model clears the knob or
   * application code calls `clear()`.
   */
  activateWhen: (result: TickResult) => boolean;
}

/**
 * Verified gate: level-triggered verification, automatic clearing.
 */
export interface VerifiedGateDescriptor {
  description: string;
  instructions: string;
  /**
   * Verification predicate, evaluated at the end of every tick (after tool
   * results are in). Returning false engages the gate; returning true clears
   * it. May be async. Must not throw — a thrown error propagates out of the
   * tick loop and fails the execution.
   */
  satisfied: (result: TickResult) => boolean | Promise<boolean>;
  /**
   * Optional ARMING predicate — scopes when the obligation applies.
   *
   * While unarmed, the gate is dormant: `satisfied` is not evaluated and the
   * gate never blocks. Arming is edge-triggered and sticky: the first tick
   * where `activateWhen(result)` returns true arms the gate for the rest of
   * the execution, and verification (including same-tick) takes over.
   *
   * Omit to arm from the first tick — the obligation always applies. Provide
   * it for conditional invariants — "once files were edited, the typecheck
   * must pass" shouldn't block a turn that edited nothing.
   */
  activateWhen?: (result: TickResult) => boolean;
}

export type GateDescriptor = LatchGateDescriptor | VerifiedGateDescriptor;

export interface GateState {
  active: boolean;
  deferred: boolean;
  engaged: boolean;
  /**
   * Release the gate. For verified gates this is transient — the predicate
   * re-engages the gate at the next tick end if still unsatisfied.
   */
  clear: () => void;
  /**
   * Postpone the gate (latch gates only — the model must still face it
   * before completing). No-op on verified gates, whose lifecycle is owned
   * entirely by the predicate.
   */
  defer: () => void;
  element: JSX.Element | null;
}

/** Identity helper for declaring gate descriptors with inference. */
export function gate(opts: GateDescriptor): GateDescriptor {
  return opts;
}

function isVerified(opts: GateDescriptor): opts is VerifiedGateDescriptor {
  return "satisfied" in opts && typeof (opts as VerifiedGateDescriptor).satisfied === "function";
}

export function useGate(name: string, options: GateDescriptor): GateState {
  const verified = isVerified(options);

  const [state, setState] = useKnob<string>(name, "inactive", {
    description: options.description,
    group: "gates",
    // Verified gates have no deferred state and are code-cleared only —
    // exposing the knob read-only lets the model see gate status without
    // being able to knob itself past verification.
    options: verified ? ["inactive", "active"] : ["inactive", "active", "deferred"],
    readOnly: verified,
  });

  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Ref tracks ground truth — survives the render→callback gap.
  // Syncs from knob on each render (picks up external set_knob changes).
  const stateRef = useRef(state);
  stateRef.current = state;

  const transition = useCallback(
    (next: GateValue) => {
      if (stateRef.current !== next) {
        setState(next);
        stateRef.current = next;
      }
    },
    [setState],
  );

  // Arming latch for verified gates with an `activateWhen` scope. Sticky:
  // once armed, verification owns the gate for the rest of the execution.
  // Verified gates without `activateWhen` are armed from the start.
  const armedRef = useRef(false);

  useOnTickEnd(async (result) => {
    const opts = optionsRef.current;

    if (isVerified(opts)) {
      // Optional arming scope: while unarmed, the gate is dormant —
      // `satisfied` is not evaluated and the gate never blocks. The first
      // tick where `activateWhen` fires arms it (sticky) and verification
      // takes over immediately, same tick.
      if (!armedRef.current) {
        if (opts.activateWhen === undefined || opts.activateWhen(result)) {
          armedRef.current = true;
        } else {
          return;
        }
      }

      // Level-triggered: verify every tick, engage/clear from the predicate
      // alone. Runs after tool results are ingested, so the predicate sees
      // this tick's tool outcomes.
      const ok = await opts.satisfied(result);
      if (ok) {
        transition("inactive");
        return;
      }
      transition("active");
      if (!result.shouldContinue) {
        result.continue(`gate:${name}`);
      }
      return;
    }

    // Edge-triggered latch: activate only when inactive — once engaged,
    // the model controls it.
    if (stateRef.current === "inactive" && opts.activateWhen(result)) {
      transition("active");
    }

    // Block completion when gate is engaged (active or deferred)
    if (stateRef.current !== "inactive" && !result.shouldContinue) {
      // Un-defer: model must face the gate before completing
      if (stateRef.current === "deferred") {
        transition("active");
      }
      result.continue(`gate:${name}`);
    }
  });

  const clear = useCallback(() => {
    transition("inactive");
  }, [transition]);

  const defer = useCallback(() => {
    if (!verified) {
      transition("deferred");
    }
  }, [transition, verified]);

  const active = state === "active";
  const deferred = state === "deferred";

  const element = active
    ? createElement(
        Ephemeral,
        { type: "gate", position: "end", id: `gate:${name}` },
        options.instructions,
      )
    : null;

  return { active, deferred, engaged: active || deferred, clear, defer, element };
}
