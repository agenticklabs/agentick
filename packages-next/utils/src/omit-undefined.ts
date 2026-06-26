/**
 * `omitUndefined` — drop entries whose value is `undefined`.
 *
 * Designed for the spread-pattern tax under TypeScript's
 * `exactOptionalPropertyTypes: true`. Without it, every "pass an
 * optional field through if defined" assignment becomes:
 *
 *   const x: Target = {
 *     ...(input.a !== undefined ? { a: input.a } : {}),
 *     ...(input.b !== undefined ? { b: input.b } : {}),
 *     ...(input.c !== undefined ? { c: input.c } : {}),
 *   };
 *
 * That pattern accumulated ~780 instances across `packages-next/`
 * before this helper landed. The principled rewrite:
 *
 *   const x: Target = omitUndefined({
 *     a: input.a,
 *     b: input.b,
 *     c: input.c,
 *   });
 *
 * Type behavior: the result type marks every key OPTIONAL with
 * `undefined` excluded from the value type. Assignable to any target
 * whose corresponding keys are optional (the canonical case at
 * `exactOptionalPropertyTypes` boundaries).
 *
 * Semantics:
 *  - `undefined` values → key dropped.
 *  - `null`, `0`, `""`, `false` → key PRESERVED (only literal `undefined` is dropped).
 *  - **Shallow only.** Nested objects + arrays pass through by reference;
 *    `undefined` *inside* them is untouched. This is intentional: the
 *    primitive answers "is this key present at the boundary" — not
 *    "scrub undefined recursively." A nested `{ x: undefined }` may be
 *    a sentinel the consumer cares about; recursing would erase that.
 *    For deep cleanup, write a focused helper at the call site
 *    (`arr.map(omitUndefined)` for arrays-of-objects, etc.) — don't
 *    overload this primitive.
 *  - Never mutates input; always allocates a fresh object.
 *  - O(n) over `Object.keys(obj)`. Prototype chain ignored.
 *
 * @example
 *   const opts = omitUndefined({ host: "localhost", port: undefined });
 *   // { host: "localhost" }
 *
 *   const merged = { ...defaults, ...omitUndefined(input) };
 *   // Defaults are preserved for keys where input is undefined.
 */

/**
 * Type of the result: every key from `T` becomes optional, with
 * `undefined` excluded from its value type. At assignment boundaries
 * under `exactOptionalPropertyTypes`, this fits any target shape that
 * declares the same keys as optional.
 */
export type OmitUndefined<T> = {
  [K in keyof T]?: Exclude<T[K], undefined>;
};

export function omitUndefined<T extends object>(obj: T): OmitUndefined<T> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as OmitUndefined<T>;
}
