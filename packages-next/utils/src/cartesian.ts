/**
 * Cartesian product of axis values. Given a record where each key
 * maps to an array of candidate values, returns every combination —
 * one record per combination, one value picked from each axis.
 *
 * Algebra:
 *   cartesian({ a: [1, 2], b: ["x", "y"] })
 *   →  [
 *       { a: 1, b: "x" }, { a: 1, b: "y" },
 *       { a: 2, b: "x" }, { a: 2, b: "y" },
 *     ]
 *
 * Edge cases (consistent with the mathematical product):
 *   - Empty axes record (`{}`)        → `[{}]`         (one empty cell)
 *   - Any axis with an empty array    → `[]`           (zero cells)
 *   - Single-element axes             → `[{ ...one cell... }]`
 *
 * The output is a fresh array; cells are fresh objects. Stable order:
 * iterates keys in insertion order, leftmost axis varies slowest.
 */
export function cartesian<T extends Record<string, ReadonlyArray<unknown>>>(
  axes: T,
): Array<{ [K in keyof T]: T[K][number] }> {
  const keys = Object.keys(axes) as Array<keyof T>;
  if (keys.length === 0) return [{} as { [K in keyof T]: T[K][number] }];

  let out: Array<{ [K in keyof T]: T[K][number] }> = [{} as { [K in keyof T]: T[K][number] }];
  for (const key of keys) {
    const values = axes[key];
    if (values.length === 0) return [];
    const next: Array<{ [K in keyof T]: T[K][number] }> = [];
    for (const partial of out) {
      for (const v of values) {
        next.push({ ...partial, [key]: v });
      }
    }
    out = next;
  }
  return out;
}
