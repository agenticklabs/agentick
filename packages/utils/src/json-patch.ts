/**
 * `applyJsonPatch` — apply an RFC 6902 (JSON Patch) op list to a document,
 * returning a NEW document. The input is never mutated.
 *
 * Structural sharing (copy-on-write): only the containers ALONG each op's
 * pointer path are cloned; every untouched subtree is shared by reference
 * with the input. A reactive consumer can therefore compare references to
 * discover exactly which branch changed — the property that makes this the
 * right applier for state-sync (knobs/gates/state emit patches; a UI applies
 * them and re-renders only the changed branch), not a whole-document clone.
 *
 * **Op coverage — the four core ops:** `add`, `replace`, `remove`, `test`.
 * `move` / `copy` are intentionally omitted: our emitters only ever produce
 * `add` / `replace` (a per-key change) + `remove`, and `test` closes the
 * round-trip for verification. `move`/`copy` are pure sugar over
 * `remove`+`add` and can be added when a concrete consumer needs them —
 * YAGNI until then ([[feedback_steelman_the_null_hypothesis]]).
 *
 * **JSON-shape values only.** Paths address plain objects + arrays; leaves
 * are JSON primitives. `test` compares with {@link isEqual} (value-shape
 * deep equality). Cyclic graphs / Map / Set are out of scope (as for the
 * rest of our wire contracts).
 *
 * On any violation — pointer syntax, a missing target for `replace`/`remove`,
 * descending through a non-container, or a failed `test` — throws a typed
 * {@link JsonPatchError}. Errors over nulls: a bad patch is a bug at the
 * producer, not a value to swallow.
 *
 * @example
 *   const next = applyJsonPatch({ a: 1 }, [{ op: "replace", path: "/a", value: 2 }]);
 *   // { a: 2 } — a fresh object; the input is untouched.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc6902
 */

import { isEqual } from "./predicates.js";

/**
 * A single RFC 6902 operation. `add` on an existing object key behaves as
 * `replace` (per the RFC); on an array index it inserts, with `"-"` meaning
 * "append". `value` is required for `add` / `replace` / `test` and absent
 * for `remove`.
 */
export type JsonPatchOp =
  | { readonly op: "add"; readonly path: string; readonly value: unknown }
  | { readonly op: "replace"; readonly path: string; readonly value: unknown }
  | { readonly op: "remove"; readonly path: string }
  | { readonly op: "test"; readonly path: string; readonly value: unknown };

/** Thrown when a patch cannot be applied to the given document. */
export class JsonPatchError extends Error {
  override readonly name = "JsonPatchError";
}

/**
 * Apply `ops` to `doc` in order, returning a new document. Ops are applied
 * sequentially — a later op sees the result of the earlier ones. Throws on
 * the first op that cannot be applied (the document is not partially
 * mutated; `doc` itself is never touched).
 */
export function applyJsonPatch<T>(doc: T, ops: readonly JsonPatchOp[]): T {
  let current: unknown = doc;
  for (const op of ops) current = applyOp(current, op);
  return current as T;
}

// ============================================================================
// Internals
// ============================================================================

function applyOp(doc: unknown, op: JsonPatchOp): unknown {
  const tokens = parsePointer(op.path);
  if (op.op === "test") {
    if (!isEqual(getAt(doc, tokens, op.path), op.value)) {
      throw new JsonPatchError(`test op failed at "${op.path}"`);
    }
    return doc; // test never mutates.
  }
  return mutateAt(doc, tokens, op);
}

/**
 * Parse a JSON Pointer (RFC 6901) into its reference tokens. `""` addresses
 * the whole document (no tokens). Each token unescapes `~1` → `/` and
 * `~0` → `~` (in that order, per the RFC).
 */
function parsePointer(pointer: string): readonly string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new JsonPatchError(`invalid JSON Pointer (must be "" or start with "/"): "${pointer}"`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function getAt(node: unknown, tokens: readonly string[], path: string): unknown {
  let cur = node;
  for (const token of tokens) {
    if (Array.isArray(cur)) {
      cur = cur[arrayIndex(token, cur.length, path)];
    } else if (isObject(cur) && token in cur) {
      cur = cur[token];
    } else {
      throw new JsonPatchError(`path not found: "${path}"`);
    }
  }
  return cur;
}

/**
 * Copy-on-write descent: clone the container at this level, recurse into the
 * addressed child, and splice the rewritten child back in. Untouched siblings
 * are shared by reference.
 */
function mutateAt(node: unknown, tokens: readonly string[], op: JsonPatchOp): unknown {
  if (tokens.length === 0) {
    // Whole-document target.
    if (op.op === "remove")
      throw new JsonPatchError('cannot "remove" the whole document (path "")');
    return op.value;
  }
  const [key, ...rest] = tokens;
  if (rest.length === 0) return applyLeaf(node, key!, op);

  if (Array.isArray(node)) {
    const idx = arrayIndex(key!, node.length, op.path);
    const copy = node.slice();
    copy[idx] = mutateAt(node[idx], rest, op);
    return copy;
  }
  if (isObject(node)) {
    if (!(key! in node)) throw new JsonPatchError(`path not found: "${op.path}"`);
    return { ...node, [key!]: mutateAt(node[key!], rest, op) };
  }
  throw new JsonPatchError(`cannot descend into non-container at "${op.path}"`);
}

function applyLeaf(node: unknown, key: string, op: JsonPatchOp): unknown {
  if (Array.isArray(node)) {
    const copy = node.slice();
    if (op.op === "add") {
      const idx =
        key === "-" ? copy.length : arrayIndex(key, copy.length, op.path, /*forAdd*/ true);
      copy.splice(idx, 0, op.value);
    } else if (op.op === "replace") {
      copy[arrayIndex(key, copy.length, op.path)] = op.value;
    } else {
      copy.splice(arrayIndex(key, copy.length, op.path), 1);
    }
    return copy;
  }
  if (isObject(node)) {
    if (op.op === "add") return { ...node, [key]: op.value };
    if (!(key in node)) throw new JsonPatchError(`path not found: "${op.path}"`);
    if (op.op === "replace") return { ...node, [key]: op.value };
    const copy = { ...node };
    delete copy[key];
    return copy;
  }
  throw new JsonPatchError(`cannot apply "${op.op}" to non-container at "${op.path}"`);
}

function arrayIndex(token: string, length: number, path: string, forAdd = false): number {
  if (!/^\d+$/.test(token)) throw new JsonPatchError(`invalid array index "${token}" at "${path}"`);
  const idx = Number(token);
  // `add` may target the position just past the end (append); other ops must
  // hit an existing element.
  if (idx > length || (idx === length && !forAdd)) {
    throw new JsonPatchError(`array index ${idx} out of bounds at "${path}"`);
  }
  return idx;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
