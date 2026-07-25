import { describe, expect, it } from "vitest";

import { omitUndefined } from "../omit-undefined.js";

describe("omitUndefined", () => {
  it("drops keys whose value is undefined", () => {
    const result = omitUndefined({ a: 1, b: undefined, c: "x" });
    expect(result).toEqual({ a: 1, c: "x" });
    expect("b" in result).toBe(false);
  });

  it("preserves falsy-but-defined values (0, '', false, null)", () => {
    const result = omitUndefined({ zero: 0, empty: "", flag: false, none: null });
    expect(result).toEqual({ zero: 0, empty: "", flag: false, none: null });
  });

  it("returns an empty object when every key is undefined", () => {
    const result = omitUndefined({ a: undefined, b: undefined });
    expect(result).toEqual({});
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("returns an empty object for an empty input", () => {
    expect(omitUndefined({})).toEqual({});
  });

  it("does not mutate the input", () => {
    const input = { a: 1, b: undefined };
    const result = omitUndefined(input);
    expect(input).toEqual({ a: 1, b: undefined });
    expect(result).not.toBe(input);
  });

  it("preserves type-level optionality at assignment boundaries", () => {
    // Compile-only check: result is assignable to types whose
    // corresponding keys are optional (the canonical
    // exactOptionalPropertyTypes use case).
    type Target = { readonly host?: string; readonly port?: number };
    const input: { host: string | undefined; port: number | undefined } = {
      host: "localhost",
      port: undefined,
    };
    const result: Target = omitUndefined(input);
    expect(result).toEqual({ host: "localhost" });
  });

  it("composes with object spread for default-then-override pattern", () => {
    const defaults = { host: "127.0.0.1", port: 8080, debug: false };
    const overrides = { port: 9000, debug: undefined };
    const merged = { ...defaults, ...omitUndefined(overrides) };
    expect(merged).toEqual({ host: "127.0.0.1", port: 9000, debug: false });
  });
});
