/**
 * `useGate` — the React hook for the gate pattern.
 *
 * A gate is a three-state knob (`inactive` / `active` / `deferred`) that
 * blocks loop completion until the model explicitly clears it. This hook
 * composes existing primitives: `useKnob` for the three-state cell,
 * `useOnTickEnd` for activation + continuation triggers, `useLoopControl`
 * to request a continuation when the model would otherwise stop.
 *
 * The descriptor (`GateDescriptor`) and `gate()` factory live in the
 * reconciler-agnostic top-level of `@agentick/gates-next`. Non-React
 * reconcilers (Angular, Vue) would implement their own gate hook
 * against the same descriptor shape.
 *
 * Activation:
 *   - `activateWhen(result)` is consulted only when the gate is `inactive`.
 *     If it returns true, the gate flips to `active` and renders its
 *     instructions on the next render.
 *
 * Continuation:
 *   - When the loop would stop (`result.shouldContinue === false`) AND the
 *     gate is engaged (`active` or `deferred`), the gate calls
 *     `loop.continueAfterTick("gate:<name>")`. A `deferred` gate
 *     un-defers to `active` at that point — the model must face the
 *     instructions before completing.
 *
 * Authoring:
 *   - The model controls the gate via `set_knob(name, value)`.
 *   - `clear()` / `defer()` are programmatic shortcuts for the host.
 *   - `element` is a `<section title={description}>{instructions}</section>`
 *     that's non-null only when the gate is `active`. Authors render it
 *     in their tree (typically last) so the model sees the instructions
 *     immediately before its next response.
 *
 * Semantic shift vs v1:
 *   - v1's `activateWhen` saw the model's *proposed* tool calls
 *     (pre-dispatch). v2's sees `TickResult.toolResults` — the *executed*
 *     results (post-dispatch). For most gates (`r => r.toolResults.some(t
 *     => t.toolName === "write_file")`) the behavior is equivalent with
 *     at most one tick of lag.
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

import { GATE_OPTIONS, type GateDescriptor, type GateValue } from "../descriptor.js";

// ============================================================================
// Hook return shape (React-flavored — embeds a ReactElement)
// ============================================================================

export interface GateState {
  readonly active: boolean;
  readonly deferred: boolean;
  /** `active || deferred` — gate is currently blocking exit. */
  readonly engaged: boolean;
  readonly clear: () => void;
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
  // Push gate metadata onto the bridge so the model's `set_knob` tool +
  // `<Knobs />` section see this knob as a `select` with three known
  // values, grouped under "gates", with the gate's description as
  // human-readable context.
  const knobOptions = useMemo<UseKnobOptions>(
    () => ({
      description: options.description,
      valueType: "string",
      group: "gates",
      options: GATE_OPTIONS,
    }),
    [options.description],
  );
  const [state, setState] = useKnob<GateValue>(name, "inactive", knobOptions);
  const loop = useLoopControl();

  // Ground-truth ref — survives the render-to-callback gap and lets the
  // tick-end handler skip stale state reads.
  const stateRef = useRef<GateValue>(state);
  stateRef.current = state;

  const activateRef = useRef(options.activateWhen);
  activateRef.current = options.activateWhen;

  useOnTickEnd((event) => {
    const result = event.result as TickResult;

    // Activate only when inactive — once engaged, the model is in control.
    if (stateRef.current === "inactive" && activateRef.current(result)) {
      setState("active");
      stateRef.current = "active";
    }

    // Block completion when engaged.
    if (stateRef.current !== "inactive" && !result.shouldContinue) {
      if (stateRef.current === "deferred") {
        // Un-defer: model must face the instructions before completing.
        setState("active");
        stateRef.current = "active";
      }
      loop.continueAfterTick(`gate:${name}`);
    }
  });

  const clear = useCallback(() => {
    setState("inactive");
    stateRef.current = "inactive";
  }, [setState]);

  const defer = useCallback(() => {
    setState("deferred");
    stateRef.current = "deferred";
  }, [setState]);

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
