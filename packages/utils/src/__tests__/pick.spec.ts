import { describe, expect, it } from "vitest";
import { pick } from "../pick.js";

describe("pick", () => {
  it("copies the named keys and drops undefined ones", () => {
    const input = { a: 1, b: undefined as string | undefined, c: "keep", d: null };
    expect(pick(input, ["a", "b", "c"])).toEqual({ a: 1, c: "keep" });
  });

  it("keeps falsy values that are not undefined", () => {
    expect(pick({ a: 0, b: "", c: false, d: null }, ["a", "b", "c", "d"])).toEqual({
      a: 0,
      b: "",
      c: false,
      d: null,
    });
  });

  it("never mutates and never adds keys it was not asked for", () => {
    const input = { a: 1, b: 2 };
    const out = pick(input, ["a"]);
    expect(out).toEqual({ a: 1 });
    expect("b" in out).toBe(false);
    expect(input).toEqual({ a: 1, b: 2 });
  });
});
