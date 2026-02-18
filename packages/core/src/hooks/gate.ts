/**
 * Gate — knob-backed continuation condition.
 *
 * A gate is a three-state knob (inactive/active/deferred) that blocks
 * execution from completing until the model explicitly clears it.
 * Auto-activates when `activateWhen` fires. Auto-renders an Ephemeral
 * element with instructions when active.
 */

import { createElement, useRef, useCallback } from "react";
import type { JSX } from "react";
import { useOnTickEnd } from "./lifecycle";
import { useKnob } from "./knob";
import { Ephemeral } from "../jsx/components/messages";
import type { TickResult } from "./types";

export type GateValue = "inactive" | "active" | "deferred";

export interface GateDescriptor {
  description: string;
  instructions: string;
  activateWhen: (result: TickResult) => boolean;
}

export interface GateState {
  active: boolean;
  deferred: boolean;
  engaged: boolean;
  clear: () => void;
  defer: () => void;
  element: JSX.Element | null;
}

export function gate(opts: GateDescriptor): GateDescriptor {
  return opts;
}

export function useGate(name: string, options: GateDescriptor): GateState {
  const [state, setState] = useKnob<string>(name, "inactive", {
    description: options.description,
    group: "gates",
    options: ["inactive", "active", "deferred"],
  });

  const activateRef = useRef(options.activateWhen);
  activateRef.current = options.activateWhen;

  // Ref tracks ground truth — survives the render→callback gap.
  // Syncs from knob on each render (picks up external set_knob changes).
  const stateRef = useRef(state);
  stateRef.current = state;

  useOnTickEnd((result) => {
    // Activate only when inactive — once engaged, model controls it
    if (stateRef.current === "inactive" && activateRef.current(result)) {
      setState("active");
      stateRef.current = "active";
    }

    // Block completion when gate is engaged (active or deferred)
    if (stateRef.current !== "inactive" && !result.shouldContinue) {
      // Un-defer: model must face the gate before completing
      if (stateRef.current === "deferred") {
        setState("active");
        stateRef.current = "active";
      }
      result.continue(`gate:${name}`);
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

  const element = active
    ? createElement(
        Ephemeral,
        { type: "gate", position: "end", id: `gate:${name}` },
        options.instructions,
      )
    : null;

  return { active, deferred, engaged: active || deferred, clear, defer, element };
}
