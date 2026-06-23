/**
 * Bedrock type predicates + structural equality.
 *
 * These are the kind of helpers every JS/TS codebase re-rolls in
 * five different places over a year. Centralizing them here removes
 * drift, makes intent self-documenting at call sites (`isObject(x)`
 * vs the always-easy-to-get-wrong `x && typeof x === "object" &&
 * !Array.isArray(x)`), and gives one canonical answer to questions
 * like "is null an object?" (no, per our convention).
 *
 * Conventions:
 *  - `isObject` = plain object. Arrays and `null` are NOT objects.
 *  - `isEqual` = deep structural equality for JSON-shape values plus
 *    `Date` and `RegExp`. Map/Set are NOT supported (rare in our
 *    codebase; consumers needing them should reach for `effect/Equal`).
 *  - `NaN === NaN` → false by `===`, but `isEqual(NaN, NaN) → true`
 *    (matches `Object.is` semantics, which is what callers expect).
 */

// ============================================================================
// Type predicates
// ============================================================================

export function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function isNumber(v: unknown): v is number {
  return typeof v === "number";
}

export function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

export function isNull(v: unknown): v is null {
  return v === null;
}

export function isUndefined(v: unknown): v is undefined {
  return v === undefined;
}

/** True for any value that's not `null` and not `undefined`. */
export function isDefined<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

export function isFunction(v: unknown): v is (...args: unknown[]) => unknown {
  return typeof v === "function";
}

export function isArray(v: unknown): v is readonly unknown[] {
  return Array.isArray(v);
}

/**
 * Plain object — NOT an array, NOT `null`, NOT a function, NOT a
 * primitive. The everyday "do I have a key/value bag" check.
 *
 * Note: returns `true` for class instances and built-ins like `Date`
 * (they're typeof "object"). Callers wanting "POJO only" (no class
 * instances) reach for {@link isPlainObject}.
 */
export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Plain Old JavaScript Object — `{}`-literal or `Object.create(null)`.
 * NOT a class instance, NOT `Date` / `RegExp` / `Map` / `Set`, NOT an
 * array, NOT `null`.
 *
 * Used by deep-merge consumers that need to distinguish "extend this
 * key-value bag" from "treat this as an opaque value." `Executor`
 * instances are opaque; `{x:1, y:2}` is mergeable.
 *
 * Detects via prototype chain: a value is a plain object iff its
 * prototype is either `Object.prototype` or `null`.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

// ============================================================================
// Deep structural equality
// ============================================================================

/**
 * Deep structural equality, value-shape semantics.
 *
 * Handles: primitives (Object.is — `NaN === NaN` is true), arrays
 * (length + element-wise), plain objects (key-set + value-wise),
 * `Date` (timestamp), `RegExp` (source + flags).
 *
 * **Functions compare equal to functions** (presence-equality, not
 * reference). Matches `JSON.stringify(a) === JSON.stringify(b)`
 * semantics, which is what callers comparing config/data want —
 * "do these two values represent the same thing?", not "do these
 * two values share identity at the function level?". Callers
 * needing reference equality on functions use `===` directly.
 *
 * Does NOT handle: `Map`, `Set`, class instances with custom equality,
 * cyclic references. Reach for `effect/Equal` if you need those.
 */
export function isEqual(a: unknown, b: unknown): boolean {
  // Primitives + identical references — `Object.is` handles `NaN`,
  // `-0`/`+0`, and avoids the `===`/`==` footguns.
  if (Object.is(a, b)) return true;

  // Two functions are equal-by-presence — see header note.
  if (typeof a === "function" && typeof b === "function") return true;

  // One null/undefined, one not — `Object.is` already ruled out both
  // being the same null/undefined.
  if (a === null || b === null || a === undefined || b === undefined) return false;

  // typeof divergence fast-fails the rest.
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  // Date
  if (a instanceof Date) {
    return b instanceof Date && a.getTime() === b.getTime();
  }
  if (b instanceof Date) return false;

  // RegExp
  if (a instanceof RegExp) {
    return b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }
  if (b instanceof RegExp) return false;

  // Array — both must be arrays of equal length with equal elements.
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  // Plain object — same key set, equal values for every key.
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!isEqual(ao[k], bo[k])) return false;
  }
  return true;
}
