/**
 * `cartesian` — combinatorial product over a record of axis arrays.
 * Tests pin the edge cases that adopters lean on (empty input, empty
 * axis, single-element axes, stable key order).
 */

import { describe, expect, it } from "vitest";

import { cartesian } from "../cartesian.js";

describe("cartesian", () => {
  it("empty axes record yields a single empty cell", () => {
    expect(cartesian({})).toEqual([{}]);
  });

  it("zero-element axis yields zero cells", () => {
    expect(cartesian({ a: [], b: [1, 2] })).toEqual([]);
    expect(cartesian({ a: [1, 2], b: [] })).toEqual([]);
  });

  it("single-axis sweep yields one cell per value", () => {
    expect(cartesian({ a: [1, 2, 3] })).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it("two-axis sweep yields the full product", () => {
    const out = cartesian({ a: [1, 2], b: ["x", "y"] });
    expect(out).toHaveLength(4);
    expect(out).toEqual([
      { a: 1, b: "x" },
      { a: 1, b: "y" },
      { a: 2, b: "x" },
      { a: 2, b: "y" },
    ]);
  });

  it("rightmost axis varies fastest (insertion-order stability)", () => {
    const out = cartesian({ outer: [1, 2], inner: ["x", "y"] });
    // Adjacent cells should share `outer` value when inner is varying.
    expect(out[0]!.outer).toBe(1);
    expect(out[1]!.outer).toBe(1);
    expect(out[2]!.outer).toBe(2);
    expect(out[3]!.outer).toBe(2);
  });

  it("preserves reference identity of axis values", () => {
    const a = { kind: "a" as const };
    const b = { kind: "b" as const };
    const out = cartesian({ obj: [a, b] });
    expect(out[0]!.obj).toBe(a);
    expect(out[1]!.obj).toBe(b);
  });

  it("returns fresh cell objects (mutation-safe)", () => {
    const out = cartesian({ a: [1, 2] });
    out[0]!.a = 99 as never;
    expect(out[1]!.a).toBe(2);
  });
});
