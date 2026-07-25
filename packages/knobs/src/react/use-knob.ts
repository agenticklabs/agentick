/**
 * `useKnob` — model-visible, reactive state managed by the harness.
 *
 * Registers a knob descriptor in `useEffect` (post-commit) via
 * fire-and-forget on the async register Operation. The first
 * `getSnapshot` falls back to `initial` because the harness may not
 * have the value yet; once register's Operation lands (microtask after
 * commit), the wildcard listener fires, useSyncExternalStore re-reads,
 * and renders converge on the harness-stored value.
 *
 * Subsequent updates from anywhere (other components, external
 * `harness.set`, the `knob_set` tool dispatch, inbox mutations from
 * remote actors) trigger re-renders via the harness's per-id subscribe.
 *
 * Per ADR 26, `useBridges().knobs` is the session's `KnobsHarness` — a
 * full harness, not a "bridge". `set` / `register` are async Operations
 * that emit envelopes through the substrate. This hook fires them
 * fire-and-forget (`void`) — the React setter API stays sync; the
 * Operation completes in the background and the harness notifies
 * subscribers when the value lands.
 *
 * Momentary semantics: when `options.momentary` is true, the hook
 * registers a `useOnExecutionEnd` handler that resets the value to
 * `initial` after each execution completes. Matches v1: momentary =
 * one-shot trigger, auto-resets between executions, not between ticks.
 *
 * @see packages/spec/src/protocol/knobs-harness.ts
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type {
  KnobPrimitive,
  KnobRegistration,
  KnobValueType,
  StandardSchemaV1,
} from "@agentick/spec";
import { useBridges } from "@agentick/compiler-react";
import { useOnExecutionEnd } from "@agentick/compiler-react";

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
  /**
   * Model-visible but not model-settable — `knob_set` rejects writes;
   * only application code mutates via the returned setter.
   */
  readonly readOnly?: boolean;
  readonly validate?: (value: KnobPrimitive) => true | string;
  readonly schema?: StandardSchemaV1;
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

  // Register descriptor in useEffect (post-commit, no setState-in-render
  // hazard). Fire-and-forget the async Operation; by the time it
  // resolves, the harness has the descriptor + (if previously unset)
  // value === defaultValue, wildcard listeners have fired, and any
  // subscribed components re-render.
  useEffect(() => {
    void knobs.register({ id, descriptor: buildRegistration(initial, options) });
  }, [knobs, id, initial, options]);

  const subscribe = useCallback(
    (listener: () => void) => knobs.subscribe(id, listener),
    [knobs, id],
  );
  // Fallback to `initial` while the register Operation is in flight —
  // `getSnapshot` is referentially stable in primitives between renders.
  const getSnapshot = useCallback(() => (knobs.get(id) ?? initial) as T, [knobs, id, initial]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const set = useCallback(
    (next: T) => {
      void knobs.set({ id, value: next });
    },
    [knobs, id],
  );

  // Momentary reset at execution-end. Conditional handler body so the
  // cost is one lifecycle subscription per useKnob regardless of
  // whether momentary is active.
  const momentary = options?.momentary === true;
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useOnExecutionEnd(() => {
    if (momentary) void knobs.set({ id, value: initialRef.current });
  });

  return [value, set] as const;
}

function buildRegistration(
  initial: KnobPrimitive,
  options: UseKnobOptions | undefined,
): KnobRegistration {
  return {
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
    ...(options?.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
    ...(options?.validate !== undefined ? { validate: options.validate } : {}),
    ...(options?.schema !== undefined ? { schema: options.schema } : {}),
  };
}
