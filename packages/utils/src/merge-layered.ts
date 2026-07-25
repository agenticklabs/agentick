/**
 * `mergeLayered` — Pattern A cascade primitive (see ADR 34).
 *
 * Deep-merges a sequence of partial-config layers from least-specific
 * to most-specific. The result is a typed merged config with cascade
 * semantics:
 *
 *   - Later layers override earlier on leaf collision.
 *   - `undefined` doesn't override (the slot falls through to a
 *     more-general layer's value).
 *   - Plain objects deep-merge recursively.
 *   - Arrays, primitives, and opaque instances (factories, harness
 *     handles, classes) replace by default — most-specific wins.
 *   - Symbol-wrapped strategies (`append` / `prepend` / `replace` /
 *     `omit`) opt into per-field semantics at the call site, no
 *     custom merger needed.
 *
 * Two consumers in mind:
 *
 *   1. **Agentick's harness hierarchy** — gateway → app → session →
 *      per-call config cascades through `mergeLayered` at construction
 *      boundaries. New harness layer = one new arg. New config field
 *      = one new type addition. No per-field resolver code.
 *
 *   2. **Convenience-wrapper authors** (the v2 equivalent of v1's
 *      `agent({ ... })` package) — combine framework defaults + env
 *      config + project config + adopter call-site config into one
 *      blob, then translate to agentick's primitives. The "config
 *      file ergonomics" story most adopters expect lives in the
 *      wrapper layer; `mergeLayered` is the shared building block.
 *
 * Designed against — and intentionally narrower than — the layered-
 * config primitives in adopter ecosystems (Knowify's `merger` library,
 * `webpack-merge`, Helm value cascade). We ship the cascade primitive
 * + four strategies, NOT operators (`uniq`/`sort`/`filter` are array
 * transforms, a separate concern).
 *
 * @see docs/proposals/v2/blueprint/34-scoped-capability-cascade.md
 */

import { isPlainObject } from "./predicates.js";

// ============================================================================
// Strategy wrappers
// ============================================================================

const STRATEGY = Symbol.for("@agentick/merge-strategy");

type StrategyName = "append" | "prepend" | "replace" | "omit";

/**
 * Field-level strategy wrapper. Adopter writes `append([...])` at the
 * field site; the merge engine unwraps and applies the named strategy
 * when folding that layer.
 */
export interface MergeStrategy<T = unknown> {
  readonly [STRATEGY]: StrategyName;
  readonly value: T;
}

/**
 * Append the wrapped array onto the parent layer's value (parent-first).
 * If the parent doesn't have an array at this slot, the wrapped value
 * is used as-is.
 *
 * ```ts
 * mergeLayered({ extensions: [a] }, { extensions: append([b]) })
 * // → { extensions: [a, b] }
 * ```
 */
export function append<T>(value: readonly T[]): MergeStrategy<readonly T[]> {
  return { [STRATEGY]: "append", value };
}

/**
 * Prepend the wrapped array onto the parent layer's value (wrapped
 * value first). Same fallback as `append` when the parent slot is
 * absent.
 */
export function prepend<T>(value: readonly T[]): MergeStrategy<readonly T[]> {
  return { [STRATEGY]: "prepend", value };
}

/**
 * Replace the parent layer's value verbatim. Use to opt OUT of deep
 * merge when the parent had an object you don't want extended.
 *
 * ```ts
 * mergeLayered({ a: { x: 1 } }, { a: replace({ y: 2 }) })
 * // → { a: { y: 2 } }   (the `x:1` is dropped)
 * ```
 */
export function replace<T>(value: T): MergeStrategy<T> {
  return { [STRATEGY]: "replace", value };
}

/**
 * Explicitly remove the slot from the merged result, even if a parent
 * layer set it. Use rare — most "I don't want this" cases are
 * better-handled by not setting it. But occasionally a child layer
 * needs to suppress a parent default.
 */
export function omit(): MergeStrategy<undefined> {
  return { [STRATEGY]: "omit", value: undefined };
}

/**
 * Type guard — true when the value carries a merge-strategy marker.
 */
export function isMergeStrategy(value: unknown): value is MergeStrategy {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<symbol, unknown>)[STRATEGY] !== undefined
  );
}

// ============================================================================
// Layer typing
// ============================================================================

/**
 * One layer in a cascade — a partial config object where each field
 * may be the raw value OR a strategy-wrapped value OR omitted.
 * Strategy-wrapping types are intentionally loose at this surface; the
 * runtime engine unwraps and applies.
 */
export type Layer<T> = {
  readonly [K in keyof T]?: T[K] | MergeStrategy<T[K]> | MergeStrategy<undefined>;
};

// ============================================================================
// Engine
// ============================================================================

/**
 * Fold one layer into the accumulator. Internal — exported only for
 * testing / advanced composition.
 */
export function foldLayer<T>(acc: Partial<T>, layer: Layer<T> | undefined): Partial<T> {
  if (!layer) return acc;
  const out: Record<string, unknown> = { ...(acc as Record<string, unknown>) };
  for (const [k, raw] of Object.entries(layer)) {
    if (raw === undefined) continue;

    if (isMergeStrategy(raw)) {
      applyStrategy(out, k, raw);
      continue;
    }

    const prior = out[k];
    if (isPlainObject(raw) && isPlainObject(prior)) {
      // Both layers have POJOs — deep merge. Class instances
      // (Executor, etc.) are NOT plain objects and replace as a
      // whole.
      out[k] = foldLayer(prior as Partial<unknown>, raw as Layer<unknown>);
    } else {
      // Most-specific wins for everything else (primitives, arrays,
      // class instances, factories, mixed-shape collisions).
      out[k] = raw;
    }
  }
  return out as Partial<T>;
}

function applyStrategy(out: Record<string, unknown>, key: string, strat: MergeStrategy): void {
  switch (strat[STRATEGY]) {
    case "replace":
      out[key] = strat.value;
      return;
    case "omit":
      delete out[key];
      return;
    case "append": {
      const prior = Array.isArray(out[key]) ? (out[key] as readonly unknown[]) : [];
      const incoming = strat.value as readonly unknown[];
      out[key] = [...prior, ...incoming];
      return;
    }
    case "prepend": {
      const prior = Array.isArray(out[key]) ? (out[key] as readonly unknown[]) : [];
      const incoming = strat.value as readonly unknown[];
      out[key] = [...incoming, ...prior];
      return;
    }
  }
}

/**
 * Deep-merge a sequence of partial-config layers from least-specific
 * to most-specific (left → right). Returns a typed merged config.
 *
 * Empty/undefined layers are skipped, so callers can pass conditional
 * layers inline:
 *
 * ```ts
 * mergeLayered<Config>(
 *   FRAMEWORK_DEFAULTS,
 *   envEnabled ? loadEnvConfig() : undefined,
 *   adopterConfig,
 * );
 * ```
 *
 * The return type is `T`, not `Partial<T>` — adopters are responsible
 * for ensuring the merged layers cover every required field of `T`
 * (typically: the earliest layer carries the defaults).
 */
export function mergeLayered<T>(...layers: ReadonlyArray<Layer<T> | undefined>): T {
  let acc: Partial<T> = {};
  for (const layer of layers) {
    acc = foldLayer(acc, layer);
  }
  return acc as T;
}
