/**
 * `useKnob` — model-visible, reactive state managed by the harness.
 *
 * Registers a knob descriptor (description, constraints, momentary,
 * inline, validation) on first render, then exposes the current value
 * + setter. Subsequent updates from anywhere (other components,
 * external `bridge.set`, the `set_knob` tool) trigger re-renders of
 * components consuming the knob via `useSyncExternalStore`.
 *
 * Momentary semantics: when `options.momentary` is true, the hook
 * registers a `useOnExecutionEnd` handler that resets the value to
 * `initial` (the descriptor's `defaultValue`) after each execution
 * completes. Matches v1: momentary = one-shot trigger, auto-resets
 * between executions, not between ticks.
 *
 * @see packages/spec/src/protocol/hook-bridges.ts §KnobBridge
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { KnobPrimitive, KnobRegistration, KnobValueType } from "@agentick/spec";
import { useBridges } from "../bridge-context.js";
import { useOnExecutionEnd } from "./use-on-execution-end.js";

export interface UseKnobOptions {
  readonly description?: string;
  readonly valueType?: KnobValueType;
  readonly group?: string;
  readonly options?: readonly KnobPrimitive[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly required?: boolean;
  readonly momentary?: boolean;
  readonly inline?: boolean;
  readonly validate?: (value: KnobPrimitive) => true | string;
  readonly schema?: unknown;
}

function inferValueType(initial: KnobPrimitive): KnobValueType {
  return typeof initial as KnobValueType;
}

export function useKnob<T extends KnobPrimitive>(
  id: string,
  initial: T,
  options?: UseKnobOptions,
): readonly [T, (value: T) => void] {
  const { knobs } = useBridges();

  // Two-phase initialization:
  //
  //   1. Synchronously seed the value cell on first render so
  //      `useSyncExternalStore.getSnapshot` returns `initial` rather than
  //      `undefined`. We do this with `set` (not `register`) because
  //      `set` only fires id-scoped listeners, not the wildcard. The
  //      wildcard fan-out would re-render any mounted `<Knobs />` mid-
  //      render of THIS component, tripping React's "setState in render"
  //      guard.
  //
  //   2. Push the full descriptor in a `useEffect` after commit. The
  //      bridge's wildcard listeners fire then, safely outside any
  //      render pass. Re-registration happens whenever the `options`
  //      reference changes.
  const seededRef = useRef(false);
  if (!seededRef.current) {
    if (knobs.get(id) === undefined) knobs.set(id, initial);
    seededRef.current = true;
  }

  useEffect(() => {
    const registration: KnobRegistration = {
      defaultValue: initial,
      valueType: options?.valueType ?? inferValueType(initial),
      ...(options?.description !== undefined ? { description: options.description } : {}),
      ...(options?.group !== undefined ? { group: options.group } : {}),
      ...(options?.options !== undefined ? { options: options.options } : {}),
      ...(options?.min !== undefined ? { min: options.min } : {}),
      ...(options?.max !== undefined ? { max: options.max } : {}),
      ...(options?.step !== undefined ? { step: options.step } : {}),
      ...(options?.maxLength !== undefined ? { maxLength: options.maxLength } : {}),
      ...(options?.pattern !== undefined ? { pattern: options.pattern } : {}),
      ...(options?.required !== undefined ? { required: options.required } : {}),
      ...(options?.momentary !== undefined ? { momentary: options.momentary } : {}),
      ...(options?.inline !== undefined ? { inline: options.inline } : {}),
      ...(options?.validate !== undefined ? { validate: options.validate } : {}),
      ...(options?.schema !== undefined ? { schema: options.schema } : {}),
    };
    knobs.register(id, registration);
    // Deliberately not unregistering on unmount — knob state outlives
    // its declaring component (matches v1 semantics; resume-from-snapshot
    // re-attaches the descriptor on next mount).
  }, [knobs, id, initial, options]);

  const subscribe = useCallback(
    (listener: () => void) => knobs.subscribe(id, listener),
    [knobs, id],
  );
  const getSnapshot = useCallback(() => knobs.get(id) as T, [knobs, id]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const set = useCallback(
    (next: T) => {
      knobs.set(id, next);
    },
    [knobs, id],
  );

  // Momentary reset — schedule via lifecycle handler so the reset fires
  // at execution end (matches v1). The hook is called unconditionally
  // every render (React's rules of hooks); the handler body short-
  // circuits when this call site isn't momentary, so the cost is one
  // lifecycle subscription per `useKnob` regardless.
  const momentary = options?.momentary === true;
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useOnExecutionEnd(() => {
    if (momentary) knobs.set(id, initialRef.current);
  });

  return [value, set] as const;
}
