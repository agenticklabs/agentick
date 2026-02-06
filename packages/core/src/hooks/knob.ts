/**
 * Knob — model-visible, model-settable reactive state.
 *
 * Three pieces:
 * 1. `knob()` — descriptor factory for config-level declaration
 * 2. `useKnob()` — hook returning [value, setter] tuple + registers in knobRegistry
 * 3. `isKnob()` — type guard for detecting KnobDescriptor values
 *
 * Knobs present primitive values (string, number, boolean) to the model.
 * An optional resolve callback maps the primitive to a rich application value.
 */

import { useEffect, useMemo } from "react";
import { useRuntimeStore } from "./runtime-context";
import { useComState } from "./com-state";

// ============================================================================
// KnobDescriptor — config-level declaration
// ============================================================================

const KNOB_SYMBOL = Symbol.for("tentickle.knob");

type KnobPrimitive = string | number | boolean;

export interface KnobDescriptor<T extends KnobPrimitive = KnobPrimitive, R = T> {
  [KNOB_SYMBOL]: true;
  defaultValue: T;
  description: string;
  options?: T[];
  valueType: "string" | "number" | "boolean";
  resolve?: (value: T) => R;
}

/**
 * Create a knob descriptor (no resolver — primitive IS the value).
 */
export function knob<T extends KnobPrimitive>(
  defaultValue: T,
  opts: { description: string; options?: T[] },
): KnobDescriptor<T, T>;

/**
 * Create a knob descriptor with a resolver (primitive → rich value).
 */
export function knob<T extends KnobPrimitive, R>(
  defaultValue: T,
  opts: { description: string; options?: T[] },
  resolve: (value: T) => R,
): KnobDescriptor<T, R>;

export function knob(
  defaultValue: KnobPrimitive,
  opts: { description: string; options?: KnobPrimitive[] },
  resolve?: (value: any) => any,
): KnobDescriptor {
  return {
    [KNOB_SYMBOL]: true,
    defaultValue,
    description: opts.description,
    options: opts.options,
    valueType: typeof defaultValue as "string" | "number" | "boolean",
    resolve,
  };
}

/**
 * Check if a value is a KnobDescriptor.
 */
export function isKnob(value: unknown): value is KnobDescriptor {
  return typeof value === "object" && value !== null && KNOB_SYMBOL in value;
}

// ============================================================================
// useKnob — hook returning [value, setter] tuple
// ============================================================================

interface KnobOpts<T extends KnobPrimitive> {
  description: string;
  options?: T[];
}

/**
 * Create a knob (no resolver). Returns [value, setter].
 */
export function useKnob<T extends KnobPrimitive>(
  name: string,
  defaultValue: T,
  opts: KnobOpts<T>,
): [T, (value: T) => void];

/**
 * Create a knob with a resolver. Returns [resolvedValue, primitiveSetter].
 */
export function useKnob<T extends KnobPrimitive, R>(
  name: string,
  defaultValue: T,
  opts: KnobOpts<T>,
  resolve: (value: T) => R,
): [R, (value: T) => void];

/**
 * Create a knob from a KnobDescriptor. Returns [resolvedValue, primitiveSetter].
 */
export function useKnob<T extends KnobPrimitive, R>(
  name: string,
  descriptor: KnobDescriptor<T, R>,
): [R, (value: T) => void];

export function useKnob(
  name: string,
  defaultOrDescriptor: KnobPrimitive | KnobDescriptor,
  optsOrUndefined?: KnobOpts<any>,
  maybeResolve?: (value: any) => any,
): [any, (value: any) => void] {
  // Normalize arguments
  let defaultValue: KnobPrimitive;
  let description: string;
  let options: KnobPrimitive[] | undefined;
  let valueType: "string" | "number" | "boolean";
  let resolve: ((value: any) => any) | undefined;

  if (isKnob(defaultOrDescriptor)) {
    defaultValue = defaultOrDescriptor.defaultValue;
    description = defaultOrDescriptor.description;
    options = defaultOrDescriptor.options;
    valueType = defaultOrDescriptor.valueType;
    resolve = defaultOrDescriptor.resolve;
  } else {
    defaultValue = defaultOrDescriptor;
    const opts = optsOrUndefined!;
    description = opts.description;
    options = opts.options;
    valueType = typeof defaultValue as "string" | "number" | "boolean";
    resolve = maybeResolve;
  }

  const store = useRuntimeStore();
  const comKey = `knob:${name}`;

  // COM-persisted state with automatic re-render on external changes
  const primitiveSignal = useComState<KnobPrimitive>(comKey, defaultValue);

  // Register in knobRegistry eagerly so <Knobs /> sees it on the same render pass.
  // NOTE: Intentional render-time side effect — safe because Tentickle's reconciler
  // is synchronous/single-pass. Would not be safe in concurrent React.
  useMemo(() => {
    store.knobRegistry.set(name, {
      name,
      description,
      getPrimitive: () => primitiveSignal(),
      setPrimitive: (v) => primitiveSignal.set(v),
      defaultValue,
      options,
      valueType,
    });
  }, [name]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      store.knobRegistry.delete(name);
    };
  }, [name, store]);

  // Current value — resolved if callback provided, primitive otherwise
  const primitive = primitiveSignal();
  const value = resolve ? resolve(primitive) : primitive;

  return [value, (v: KnobPrimitive) => primitiveSignal.set(v)];
}
