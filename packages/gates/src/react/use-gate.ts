/**
 * `useGate` — the React front-end for the gate pattern.
 *
 * A gate is a knob-backed continuation condition that blocks loop
 * completion until cleared. This hook is a THIN BINDING over the
 * compiler-agnostic {@link GatesController}: it resolves the in-scope
 * controller (see {@link useGatesController}), registers the descriptor
 * on mount, unregisters on unmount, and reflects the gate's value into a
 * React-flavored `GateState` (with the rendered `<section>` element).
 *
 * The verification wiring — arming, `satisfied` evaluation at tick-end,
 * fail-closed on throw, auto-clear / re-engage, loop continuation, the
 * read-only-for-verified knob — lives ENTIRELY in the controller. This
 * hook does NOT re-implement any of it, and (ADR 67) does NOT subscribe a
 * tick-end source: evaluation is DRIVEN by `session.notifyLifecycle`, not
 * a per-mount compiler subscription. The hook is registration-only. The
 * programmatic `session.gates` API registers into the SAME controller, so
 * tree-declared and programmatic gates share one registry and one wiring.
 *
 * Latch gates (`activateWhen`):
 *   - Edge-triggered arming (consulted only while `inactive`); the model
 *     controls release via `knob_set`. `clear()` / `defer()` are host
 *     shortcuts.
 *
 * Verified gates (`satisfied`):
 *   - Level-triggered; auto-clears on pass, re-engages on regression.
 *     Optional `activateWhen` arms the obligation. Backing knob is
 *     read-only — `knob_set` cannot bypass verification. `defer()` is a
 *     no-op; `clear()` is transient (re-engages next tick if unsatisfied).
 *
 * @see ../controller.ts (the shared wiring)
 * @see ./gates-context.ts (controller resolution)
 * @see packages/core/src/hooks/gate.ts (v1 origin)
 */

import React, { useCallback, useEffect } from "react";
import { useSyncExternalStore } from "react";
import { useBridges } from "@agentick/compiler-react";

import { type GateDescriptor, type GateValue } from "../descriptor.js";
import { useGatesController } from "./gates-context.js";

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
  const controller = useGatesController();
  const { knobs } = useBridges();

  // Register (idempotent, last-writer-wins) on mount; unregister on
  // unmount. Registration lives in an effect (post-commit) — the same
  // timing `useKnob` uses, so the descriptor lands after the first
  // render + flush.
  useEffect(() => {
    controller.register(name, options);
    return () => controller.unregister(name);
  }, [controller, name, options]);

  // Reactive value read off the backing knob — the controller keeps the
  // knob and its synchronous mirror aligned, so this reflects both
  // controller transitions and model `knob_set` clears.
  const value = useSyncExternalStore(
    useCallback((listener: () => void) => knobs.subscribe(name, listener), [knobs, name]),
    useCallback(() => (knobs.get(name) ?? "inactive") as GateValue, [knobs, name]),
    useCallback(() => (knobs.get(name) ?? "inactive") as GateValue, [knobs, name]),
  );

  // `clear` / `defer` are now async + journaled on the controller; the React
  // surface stays fire-and-forget (`() => void`) — the value re-reads reactively
  // off the backing knob subscription above once the transition lands.
  const clear = useCallback(() => {
    void controller.get(name)?.clear();
  }, [controller, name]);
  const defer = useCallback(() => {
    void controller.get(name)?.defer();
  }, [controller, name]);

  const active = value === "active";
  const deferred = value === "deferred";

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
