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
 *
 * Constraints are type-safe: number knobs accept min/max/step,
 * string knobs accept maxLength/pattern. Boolean knobs have no constraints.
 */

import { useEffect, useMemo } from "react";
import { useRuntimeStore } from "./runtime-context";
import { useComState } from "./com-state";

// ============================================================================
// Types — Primitives, Constraints, Options
// ============================================================================

const KNOB_SYMBOL = Symbol.for("tentickle.knob");

export type KnobPrimitive = string | number | boolean;

/**
 * Type-safe constraints based on value type.
 * Numbers get min/max/step. Strings get maxLength/pattern.
 */
export type KnobConstraints<T extends KnobPrimitive> = T extends number
  ? { min?: number; max?: number; step?: number }
  : T extends string
    ? { maxLength?: number; pattern?: string }
    : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
      {};

/**
 * Options for knob() and useKnob(). Type-safe constraints based on value type.
 */
export type KnobOpts<T extends KnobPrimitive> = KnobConstraints<T> & {
  description: string;
  options?: T[];
  group?: string;
  required?: boolean;
  validate?: (value: T) => true | string;
};

// ============================================================================
// KnobDescriptor — config-level declaration
// ============================================================================

/**
 * Descriptor carrying a knob's default value, constraints, and optional resolver.
 * Created by knob(), consumed by useKnob() and <Knobs />.
 *
 * Stores the superset of all constraint fields (the user-facing KnobOpts<T>
 * provides compile-time safety; the descriptor is a runtime carrier).
 */
export interface KnobDescriptor<T extends KnobPrimitive = KnobPrimitive, R = T> {
  [KNOB_SYMBOL]: true;
  defaultValue: T;
  description: string;
  options?: T[];
  valueType: "string" | "number" | "boolean";
  resolve?: (value: T) => R;
  group?: string;
  required?: boolean;
  validate?: (value: T) => true | string;
  // Number constraints
  min?: number;
  max?: number;
  step?: number;
  // String constraints
  maxLength?: number;
  pattern?: string;
}

/**
 * Create a knob descriptor (no resolver — primitive IS the value).
 */
export function knob<T extends KnobPrimitive>(
  defaultValue: T,
  opts: KnobOpts<T>,
): KnobDescriptor<T, T>;

/**
 * Create a knob descriptor with a resolver (primitive → rich value).
 */
export function knob<T extends KnobPrimitive, R>(
  defaultValue: T,
  opts: KnobOpts<T>,
  resolve: (value: T) => R,
): KnobDescriptor<T, R>;

export function knob(
  defaultValue: KnobPrimitive,
  opts: KnobOpts<any>,
  resolve?: (value: any) => any,
): KnobDescriptor {
  return {
    [KNOB_SYMBOL]: true,
    defaultValue,
    description: opts.description,
    options: opts.options,
    valueType: typeof defaultValue as "string" | "number" | "boolean",
    resolve,
    group: opts.group,
    required: opts.required,
    validate: opts.validate,
    min: (opts as any).min,
    max: (opts as any).max,
    step: (opts as any).step,
    maxLength: (opts as any).maxLength,
    pattern: (opts as any).pattern,
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
  // Normalize arguments — extract all fields from descriptor or opts
  let defaultValue: KnobPrimitive;
  let description: string;
  let options: KnobPrimitive[] | undefined;
  let valueType: "string" | "number" | "boolean";
  let resolve: ((value: any) => any) | undefined;
  let group: string | undefined;
  let required: boolean | undefined;
  let validate: ((value: any) => true | string) | undefined;
  let min: number | undefined;
  let max: number | undefined;
  let step: number | undefined;
  let maxLength: number | undefined;
  let pattern: string | undefined;

  if (isKnob(defaultOrDescriptor)) {
    defaultValue = defaultOrDescriptor.defaultValue;
    description = defaultOrDescriptor.description;
    options = defaultOrDescriptor.options;
    valueType = defaultOrDescriptor.valueType;
    resolve = defaultOrDescriptor.resolve;
    group = defaultOrDescriptor.group;
    required = defaultOrDescriptor.required;
    validate = defaultOrDescriptor.validate;
    min = defaultOrDescriptor.min;
    max = defaultOrDescriptor.max;
    step = defaultOrDescriptor.step;
    maxLength = defaultOrDescriptor.maxLength;
    pattern = defaultOrDescriptor.pattern;
  } else {
    defaultValue = defaultOrDescriptor;
    const opts = optsOrUndefined!;
    description = opts.description;
    options = opts.options;
    valueType = typeof defaultValue as "string" | "number" | "boolean";
    resolve = maybeResolve;
    group = opts.group;
    required = opts.required;
    validate = opts.validate;
    min = (opts as any).min;
    max = (opts as any).max;
    step = (opts as any).step;
    maxLength = (opts as any).maxLength;
    pattern = (opts as any).pattern;
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
      group,
      required,
      validate,
      min,
      max,
      step,
      maxLength,
      pattern,
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
