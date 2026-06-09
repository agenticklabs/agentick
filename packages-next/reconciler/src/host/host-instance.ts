/**
 * HostInstance — one node in the host tree.
 *
 * The host tree is the mutable, transient structure react-reconciler
 * builds via our host config. It NEVER crosses the harness boundary;
 * the collector walks it and produces a `RenderedTree` JSON IR.
 *
 * Two variants discriminated by `kind`:
 *   - `element` — a JSX element (intrinsic string, function component,
 *     or Fragment symbol)
 *   - `text` — a text node (string literal inside JSX)
 *
 * Each instance carries a stable `hostId` (assigned at create-time and
 * preserved across rerenders) and an inherited `HostScope` captured
 * from `getChildHostContext` at the moment of creation.
 *
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md §Layer A
 */

import type { HostScope } from "./host-context.js";

/**
 * Type discriminator for a host node — what JSX produced it.
 *
 *   - `string`              an intrinsic element (`section`, `message`, …)
 *   - `Function`            a function or class component
 *   - `symbol`              `Fragment` or other React magic
 */
export type HostType =
  | string
  | ((...args: never[]) => unknown)
  | { new (...args: never[]): unknown }
  | symbol;

/**
 * Props bag carried on an `ElementInstance`. The `children` and `key`
 * fields are stripped at create-time — children come through host-config
 * tree-mutation methods, key through React's reconciliation.
 */
export type Props = Readonly<Record<string, unknown>>;

export interface ElementInstance {
  readonly kind: "element";

  /**
   * Component identity. Use referential equality for function / class
   * components, string equality for intrinsics, `Symbol` equality for
   * Fragment. Stable across the lifetime of the instance.
   */
  readonly type: HostType;

  /**
   * Current props (mutable — replaced via `commitUpdate`). Frozen
   * shape on each replacement.
   */
  props: Props;

  /**
   * Ordered children. Mutated by host-config tree-mutation methods
   * (`appendChild`, `insertBefore`, `removeChild`).
   */
  readonly children: HostInstance[];

  /**
   * Parent pointer maintained by the host config. `null` when the
   * instance is the root of a Container.
   */
  parent: HostInstance | null;

  /**
   * Stable identity assigned at create-time. Used by collectors as a
   * deterministic key for stable id derivation, and by snapshots to
   * pin hook state to the right instance.
   */
  readonly hostId: string;

  /**
   * `HostScope` captured at create-time from `getChildHostContext`.
   * Replaced (not mutated) when the scope is re-derived during
   * commit.
   */
  scope: HostScope;
}

export interface TextInstance {
  readonly kind: "text";
  text: string;
  parent: HostInstance | null;
  readonly hostId: string;
}

export type HostInstance = ElementInstance | TextInstance;

// ============================================================================
// Factories
// ============================================================================

/**
 * Monotonic counter for host ids. Per-process. Combined with a
 * container-local prefix in `createElementInstance` / `createTextInstance`
 * so two simultaneous containers don't collide.
 */
let counter = 0;
function nextId(prefix: string): string {
  counter = (counter + 1) | 0;
  return `${prefix}#${counter.toString(36)}`;
}

export function createElementInstance(
  type: HostType,
  props: Props,
  scope: HostScope,
  options: { readonly idPrefix?: string } = {},
): ElementInstance {
  return {
    kind: "element",
    type,
    props: stripReservedProps(props),
    children: [],
    parent: null,
    hostId: nextId(options.idPrefix ?? "h"),
    scope,
  };
}

export function createTextInstance(
  text: string,
  options: { readonly idPrefix?: string } = {},
): TextInstance {
  return {
    kind: "text",
    text,
    parent: null,
    hostId: nextId(options.idPrefix ?? "t"),
  };
}

export function isElementInstance(node: HostInstance): node is ElementInstance {
  return node.kind === "element";
}

export function isTextInstance(node: HostInstance): node is TextInstance {
  return node.kind === "text";
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Strip props the host instance does not carry. `key` is consumed by
 * React's reconciliation; `children` is delivered through host-config
 * tree-mutation methods, not as a prop.
 */
function stripReservedProps(props: Props): Props {
  if (!("key" in props) && !("children" in props)) return props;
  const out: Record<string, unknown> = {};
  for (const k in props) {
    if (k === "key" || k === "children") continue;
    out[k] = props[k];
  }
  return out;
}
