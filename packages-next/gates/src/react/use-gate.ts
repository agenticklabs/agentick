/**
 * `useGate` — the React hook for the gate pattern.
 *
 * A gate is a knob-backed continuation condition that blocks loop
 * completion until cleared. This hook composes existing primitives:
 * `useKnob` for the state cell, `useOnTickEnd` for activation /
 * verification + continuation triggers, `useLoopControl` to request a
 * continuation when the model would otherwise stop.
 *
 * The descriptors (`LatchGateDescriptor` / `VerifiedGateDescriptor`)
 * and `gate()` factory live in the reconciler-agnostic top-level of
 * `@agentick/gates-next`. Non-React reconcilers (Angular, Vue) would
 * implement their own gate hook against the same descriptor shapes.
 *
 * Latch gates (`activateWhen`):
 *   - `activateWhen(result)` is consulted only when the gate is
 *     `inactive`. If it returns true, the gate flips to `active` and
 *     renders its instructions on the next render.
 *   - The model controls the gate via `set_knob(name, value)`;
 *     `clear()` / `defer()` are programmatic shortcuts for the host.
 *
 * Verified gates (`satisfied`):
 *   - The predicate is evaluated at the end of EVERY tick, whatever
 *     the current state: `false` → `active`, `true` → `inactive`.
 *     Auto-clears on pass, re-engages on regression. No other
 *     transitions exist; `defer()` is a no-op and `clear()` is
 *     transient (the predicate re-engages at the next tick end if
 *     still unsatisfied).
 *   - An optional `activateWhen` ARMS the gate: while unarmed it is
 *     dormant (no verification, no blocking); the first tick where the
 *     arming predicate fires latches it armed for the rest of the
 *     mount and verification takes over, same tick. Omit to arm from
 *     the first tick.
 *   - The backing knob is registered `readOnly` — the model can read
 *     the gate's state in the Knobs section but `set_knob` rejects
 *     writes, so verification cannot be bypassed.
 *   - Fail-closed: a predicate that THROWS is treated as unsatisfied.
 *     The v2 lifecycle store isolates handler errors (they're logged,
 *     not propagated), so without this a broken verifier would leave
 *     the gate in its previous state and could let the loop complete
 *     unverified.
 *
 * Continuation (both species):
 *   - When the loop would stop (`result.shouldContinue === false`) AND
 *     the gate is engaged, the gate calls
 *     `loop.continueAfterTick("gate:<name>")`. A `deferred` latch gate
 *     un-defers to `active` at that point — the model must face the
 *     instructions before completing. Explicit stop requests still win
 *     over gate continuations in loop arbitration, so budget guards
 *     compose with gates.
 *
 * Authoring:
 *   - `element` is a `<section title={description}>{instructions}</section>`
 *     that's non-null only when the gate is `active`. Authors render it
 *     in their tree (typically last) so the model sees the instructions
 *     immediately before its next response.
 *
 * Semantic shift vs v1:
 *   - v1's tick-end predicates saw the model's *proposed* tool calls
 *     (pre-dispatch). v2's see `TickResult.toolResults` — the *executed*
 *     results (post-dispatch). For most gates (`r => r.toolResults.some(t
 *     => t.toolName === "write_file")`) the behavior is equivalent with
 *     at most one tick of lag. For verified gates this is strictly
 *     better: the predicate judges what actually happened.
 *
 * The `event.result` payload on `useOnTickEnd` is typed `unknown` at the
 * reconciler-protocol boundary (the reconciler is loop-agnostic). Gates
 * are loop-coupled, so they cast at the seam.
 *
 * @see packages/core/src/hooks/gate.ts (v1 origin)
 */

import React, { useCallback, useMemo, useRef } from "react";
import type { TickResult } from "@agentick/spec-next";
import { useLoopControl, useOnTickEnd } from "@agentick/reconciler-react-next";
import { useKnob, type UseKnobOptions } from "@agentick/knobs-next/react";

import {
  GATE_OPTIONS,
  VERIFIED_GATE_OPTIONS,
  isVerifiedGate,
  type GateDescriptor,
  type GateValue,
} from "../descriptor.js";

// ============================================================================
// Hook return shape (React-flavored — embeds a ReactElement)
// ============================================================================

export interface GateState {
  readonly active: boolean;
  readonly deferred: boolean;
  /** `active || deferred` — gate is currently blocking exit. */
  readonly engaged: boolean;
  /**
   * Release the gate. Transient on verified gates — the predicate
   * re-engages at the next tick end if still unsatisfied.
   */
  readonly clear: () => void;
  /**
   * Postpone the gate (latch gates only — the model must still face it
   * before completing). No-op on verified gates.
   */
  readonly defer: () => void;
  /**
   * Non-null when `active`. Render in your component tree where you want
   * the instructions to appear in the model's context.
   */
  readonly element: React.ReactElement | null;
}

// ============================================================================
// Hook
// ============================================================================

export function useGate(name: string, options: GateDescriptor): GateState {
  const verified = isVerifiedGate(options);

  // Push gate metadata onto the bridge so the model's `set_knob` tool +
  // `<Knobs />` section see this knob as a `select`, grouped under
  // "gates", with the gate's description as human-readable context.
  // Verified gates register read-only with two options — the model can
  // read the state but not set it.
  const knobOptions = useMemo<UseKnobOptions>(
    () => ({
      description: options.description,
      valueType: "string",
      group: "gates",
      options: verified ? VERIFIED_GATE_OPTIONS : GATE_OPTIONS,
      ...(verified ? { readOnly: true } : {}),
    }),
    [options.description, verified],
  );
  const [state, setState] = useKnob<GateValue>(name, "inactive", knobOptions);
  const loop = useLoopControl();

  // Ground-truth ref — survives the render-to-callback gap and lets the
  // tick-end handler skip stale state reads.
  const stateRef = useRef<GateValue>(state);
  stateRef.current = state;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const transition = useCallback(
    (next: GateValue) => {
      if (stateRef.current !== next) {
        setState(next);
        stateRef.current = next;
      }
    },
    [setState],
  );

  // Arming latch for verified gates with an `activateWhen` scope.
  // Sticky per mount: once armed, verification owns the gate for the
  // rest of the execution. Verified gates without `activateWhen` are
  // armed from the start.
  const armedRef = useRef(false);

  useOnTickEnd(async (event) => {
    const result = event.result as TickResult;
    const opts = optionsRef.current;

    if (isVerifiedGate(opts)) {
      // Optional arming scope: while unarmed, the gate is dormant —
      // `satisfied` is not evaluated and the gate never blocks. The
      // first tick where `activateWhen` fires arms it (sticky) and
      // verification takes over immediately, same tick.
      if (!armedRef.current) {
        if (opts.activateWhen === undefined || opts.activateWhen(result)) {
          armedRef.current = true;
        } else {
          return;
        }
      }

      // Level-triggered: verify every tick; engage/clear from the
      // predicate alone. Fail-closed — a throwing predicate counts as
      // unsatisfied (the lifecycle store would otherwise swallow the
      // error and leave the gate in its previous state).
      let ok = false;
      try {
        ok = await opts.satisfied(result);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[@agentick/gates] verified gate "${name}" predicate threw; ` +
            `treating as unsatisfied (fail-closed).`,
          err,
        );
      }
      if (ok) {
        transition("inactive");
        return;
      }
      transition("active");
      if (!result.shouldContinue) {
        loop.continueAfterTick(`gate:${name}`);
      }
      return;
    }

    // Edge-triggered latch: activate only when inactive — once engaged,
    // the model is in control.
    if (stateRef.current === "inactive" && opts.activateWhen(result)) {
      transition("active");
    }

    // Block completion when engaged.
    if (stateRef.current !== "inactive" && !result.shouldContinue) {
      if (stateRef.current === "deferred") {
        // Un-defer: model must face the instructions before completing.
        transition("active");
      }
      loop.continueAfterTick(`gate:${name}`);
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sectionType = "section" as any;
  const element = active
    ? React.createElement(
        sectionType,
        { id: `gate:${name}`, title: options.description },
        options.instructions,
      )
    : null;

  return { active, deferred, engaged: active || deferred, clear, defer, element };
}
