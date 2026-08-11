/**
 * The one walk over a {@link CodeBindings} context.
 *
 * The harness needs the audit record's names; a provider needs the functions to
 * marshal and the data to inject. Those are three readings of a single tree, so
 * they are one function — a provider that re-derived the rule would be free to
 * disagree with the record a guard already decided on.
 */

import { CodeBindingNameInvalid } from "./errors.js";
import type { CodeBinding, CodeBindings } from "./contract.js";

/** Ambient names and property paths: plain identifiers only. */
const SAFE_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
export const BINDING_PATH_SEPARATOR = ".";

/**
 * How deep a record is still a NAMESPACE. Past it a record is a value — which
 * bounds the walk, and with it the audit record: `{ dataset }` should cost one
 * line in the journal, not one per row.
 */
export const MAX_BINDING_DEPTH = 3;

export interface FlatBindings {
  /** Every callable, by dotted path — the key a provider marshals against. */
  readonly functions: ReadonlyMap<string, CodeBinding>;
  /** The same tree with the callables removed: what crosses a membrane as data. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Every leaf's dotted path, sorted. The audit record. */
  readonly names: readonly string[];
}

export function flattenBindings(bindings: CodeBindings | undefined): FlatBindings {
  const functions = new Map<string, CodeBinding>();
  const values: Record<string, unknown> = {};
  const names: string[] = [];
  if (bindings !== undefined) walk(bindings, "", 1, { functions, values, names });
  return { functions, values, names: names.sort() };
}

/** Every binding name a {@link CodeBindings} puts in scope, as dotted paths, sorted. */
export function bindingNames(bindings: CodeBindings | undefined): readonly string[] {
  return flattenBindings(bindings).names;
}

/**
 * A record is a namespace only if it is a PLAIN one. An array is data, and so
 * is anything carrying a prototype of its own — a `Date` or a `Map` walked as a
 * namespace would publish its internals as binding names and arrive at the far
 * side as something else entirely.
 */
function isNamespace(entry: unknown): entry is Record<string, unknown> {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const proto = Object.getPrototypeOf(entry) as unknown;
  return proto === Object.prototype || proto === null;
}

interface Collected {
  readonly functions: Map<string, CodeBinding>;
  readonly values: Record<string, unknown>;
  readonly names: string[];
}

function walk(node: object, prefix: string, depth: number, into: Collected): void {
  for (const [key, entry] of Object.entries(node)) {
    assertUsableSegment(key, prefix);
    const path = prefix === "" ? key : `${prefix}${BINDING_PATH_SEPARATOR}${key}`;
    if (typeof entry === "function") {
      into.functions.set(path, entry as CodeBinding);
      into.names.push(path);
      continue;
    }
    if (isNamespace(entry) && depth < MAX_BINDING_DEPTH) {
      const nested: Record<string, unknown> = {};
      into.values[key] = nested;
      walk(entry, path, depth + 1, { ...into, values: nested });
      continue;
    }
    into.values[key] = entry;
    into.names.push(path);
  }
}

function assertUsableSegment(segment: string, prefix: string): void {
  const named = prefix === "" ? segment : `${prefix}${BINDING_PATH_SEPARATOR}${segment}`;
  if (!SAFE_SEGMENT.test(segment)) {
    throw new CodeBindingNameInvalid({ bindingName: named, reason: "not a plain identifier" });
  }
  if (RESERVED_SEGMENTS.has(segment)) {
    throw new CodeBindingNameInvalid({
      bindingName: named,
      reason: "collides with a prototype member",
    });
  }
}

/**
 * Resolve a dotted path against a value tree, own-properties only. `in` would
 * walk the prototype chain, so a program asking for `constructor` would be
 * handed Object's.
 */
export function resolveBindingPath(
  values: Readonly<Record<string, unknown>>,
  path: string,
): { readonly found: boolean; readonly value: unknown } {
  let cursor: unknown = values;
  for (const segment of path.split(BINDING_PATH_SEPARATOR)) {
    if (typeof cursor !== "object" || cursor === null) return { found: false, value: undefined };
    if (!Object.hasOwn(cursor, segment)) return { found: false, value: undefined };
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return { found: true, value: cursor };
}

/** Freeze every namespace in a value tree, so a program cannot swap what it was given. */
export function freezeNamespaces<T>(tree: T): T {
  if (!isNamespace(tree)) return tree;
  for (const entry of Object.values(tree)) freezeNamespaces(entry);
  return Object.freeze(tree);
}
