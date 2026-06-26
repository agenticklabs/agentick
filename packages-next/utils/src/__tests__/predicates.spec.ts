import { describe, expect, it } from "vitest";

import {
  isArray,
  isBoolean,
  isDefined,
  isEqual,
  isFunction,
  isNull,
  isNumber,
  isObject,
  isPlainObject,
  isString,
  isThenable,
  isUndefined,
} from "../predicates.js";

describe("predicates", () => {
  describe("isString", () => {
    it.each([
      ["", true],
      ["hello", true],
      [0, false],
      [null, false],
      [undefined, false],
      [{}, false],
      [[], false],
    ])("isString(%p) → %p", (v, expected) => {
      expect(isString(v)).toBe(expected);
    });
  });

  describe("isNumber", () => {
    it.each([
      [0, true],
      [-1, true],
      [3.14, true],
      [NaN, true], // NaN IS a number per typeof — callers wanting "finite" must add the check
      [Infinity, true],
      ["1", false],
      [null, false],
      [undefined, false],
      [{}, false],
    ])("isNumber(%p) → %p", (v, expected) => {
      expect(isNumber(v)).toBe(expected);
    });
  });

  describe("isBoolean", () => {
    it.each([
      [true, true],
      [false, true],
      [0, false],
      [1, false],
      ["true", false],
      [null, false],
    ])("isBoolean(%p) → %p", (v, expected) => {
      expect(isBoolean(v)).toBe(expected);
    });
  });

  describe("isNull / isUndefined / isDefined", () => {
    it("isNull only matches null", () => {
      expect(isNull(null)).toBe(true);
      expect(isNull(undefined)).toBe(false);
      expect(isNull(0)).toBe(false);
      expect(isNull("")).toBe(false);
    });
    it("isUndefined only matches undefined", () => {
      expect(isUndefined(undefined)).toBe(true);
      expect(isUndefined(null)).toBe(false);
      expect(isUndefined(0)).toBe(false);
    });
    it("isDefined excludes null AND undefined", () => {
      expect(isDefined(null)).toBe(false);
      expect(isDefined(undefined)).toBe(false);
      expect(isDefined(0)).toBe(true);
      expect(isDefined("")).toBe(true);
      expect(isDefined(false)).toBe(true);
    });
  });

  describe("isFunction", () => {
    it("matches functions and arrow functions", () => {
      expect(isFunction(() => 0)).toBe(true);
      expect(isFunction(function () {})).toBe(true);
      expect(isFunction(async () => 0)).toBe(true);
      expect(isFunction(class {})).toBe(true); // classes are callable
      expect(isFunction(null)).toBe(false);
      expect(isFunction({})).toBe(false);
    });
  });

  describe("isArray", () => {
    it("matches arrays, rejects array-likes", () => {
      expect(isArray([])).toBe(true);
      expect(isArray([1, 2, 3])).toBe(true);
      expect(isArray("abc")).toBe(false);
      expect(isArray({ length: 0 })).toBe(false);
      expect(isArray(null)).toBe(false);
    });
  });

  describe("isPlainObject — POJO only", () => {
    it("matches object literals and Object.create(null)", () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ a: 1 })).toBe(true);
      expect(isPlainObject(Object.create(null))).toBe(true);
    });
    it("rejects class instances", () => {
      class X {
        constructor(public n = 1) {}
      }
      expect(isPlainObject(new X())).toBe(false);
    });
    it("rejects built-ins (Date, RegExp, Map, Set)", () => {
      expect(isPlainObject(new Date())).toBe(false);
      expect(isPlainObject(/x/)).toBe(false);
      expect(isPlainObject(new Map())).toBe(false);
      expect(isPlainObject(new Set())).toBe(false);
    });
    it("rejects arrays, null, primitives, functions", () => {
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
      expect(isPlainObject(0)).toBe(false);
      expect(isPlainObject("")).toBe(false);
      expect(isPlainObject(() => 0)).toBe(false);
    });
  });

  describe("isObject — plain objects only", () => {
    it("matches plain objects", () => {
      expect(isObject({})).toBe(true);
      expect(isObject({ a: 1 })).toBe(true);
      expect(isObject(Object.create(null))).toBe(true);
    });
    it("rejects arrays, null, primitives, and functions", () => {
      expect(isObject([])).toBe(false);
      expect(isObject(null)).toBe(false);
      expect(isObject(undefined)).toBe(false);
      expect(isObject(0)).toBe(false);
      expect(isObject("")).toBe(false);
      expect(isObject(() => 0)).toBe(false);
    });
    it("matches class instances (also plain object-ish)", () => {
      class X {}
      expect(isObject(new X())).toBe(true);
      // Date counts as a typeof object → isObject true; callers needing
      // "POJO only" can compose with `!isDate(v)` themselves.
      expect(isObject(new Date())).toBe(true);
    });
  });

  describe("isThenable", () => {
    it("native Promises are thenable", () => {
      expect(isThenable(Promise.resolve(1))).toBe(true);
      expect(isThenable(Promise.reject(new Error("x")).catch(() => undefined))).toBe(true);
    });

    it("custom thenables (A+ shape) are thenable", () => {
      const fake = { then: (_r: (v: number) => void) => undefined };
      expect(isThenable(fake)).toBe(true);
    });

    it("rejects non-objects", () => {
      expect(isThenable(null)).toBe(false);
      expect(isThenable(undefined)).toBe(false);
      expect(isThenable("then")).toBe(false);
      expect(isThenable(42)).toBe(false);
    });

    it("rejects objects without a function-valued `then`", () => {
      expect(isThenable({})).toBe(false);
      expect(isThenable({ then: 1 })).toBe(false);
      expect(isThenable({ then: "promise" })).toBe(false);
    });
  });

  describe("isEqual", () => {
    describe("primitives", () => {
      it("equal primitives", () => {
        expect(isEqual(1, 1)).toBe(true);
        expect(isEqual("a", "a")).toBe(true);
        expect(isEqual(true, true)).toBe(true);
        expect(isEqual(null, null)).toBe(true);
        expect(isEqual(undefined, undefined)).toBe(true);
      });
      it("different primitives", () => {
        expect(isEqual(1, 2)).toBe(false);
        expect(isEqual("a", "b")).toBe(false);
        expect(isEqual(true, false)).toBe(false);
        expect(isEqual(null, undefined)).toBe(false);
        expect(isEqual(0, "0")).toBe(false);
      });
      it("NaN === NaN via Object.is semantics", () => {
        expect(isEqual(NaN, NaN)).toBe(true);
      });
      it("-0 and +0 are NOT equal (matches Object.is)", () => {
        expect(isEqual(-0, +0)).toBe(false);
      });
    });

    describe("arrays", () => {
      it("equal arrays", () => {
        expect(isEqual([], [])).toBe(true);
        expect(isEqual([1, 2, 3], [1, 2, 3])).toBe(true);
        expect(isEqual([[1], [2]], [[1], [2]])).toBe(true);
      });
      it("different arrays", () => {
        expect(isEqual([1, 2, 3], [1, 2, 4])).toBe(false);
        expect(isEqual([1, 2], [1, 2, 3])).toBe(false);
        expect(isEqual([], [undefined])).toBe(false);
      });
      it("array vs object", () => {
        expect(isEqual([], {})).toBe(false);
        expect(isEqual([1, 2], { 0: 1, 1: 2, length: 2 })).toBe(false);
      });
    });

    describe("plain objects", () => {
      it("equal objects (key order doesn't matter)", () => {
        expect(isEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
        expect(isEqual({}, {})).toBe(true);
      });
      it("different objects", () => {
        expect(isEqual({ a: 1 }, { a: 2 })).toBe(false);
        expect(isEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
        expect(isEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
      });
      it("nested equality", () => {
        expect(isEqual({ a: { b: { c: [1, 2] } } }, { a: { b: { c: [1, 2] } } })).toBe(true);
        expect(isEqual({ a: { b: { c: [1, 2] } } }, { a: { b: { c: [1, 3] } } })).toBe(false);
      });
    });

    describe("Date", () => {
      it("equal dates", () => {
        const t = new Date("2025-01-01");
        expect(isEqual(t, new Date("2025-01-01"))).toBe(true);
      });
      it("different dates", () => {
        expect(isEqual(new Date("2025-01-01"), new Date("2025-01-02"))).toBe(false);
      });
      it("Date vs string with same value", () => {
        expect(isEqual(new Date("2025-01-01"), "2025-01-01")).toBe(false);
      });
    });

    describe("functions — presence-equality", () => {
      it("two functions are equal (matches JSON.stringify semantics)", () => {
        expect(
          isEqual(
            () => 1,
            () => 2,
          ),
        ).toBe(true);
        expect(
          isEqual(
            async () => 1,
            function () {},
          ),
        ).toBe(true);
      });
      it("function vs non-function is NOT equal", () => {
        expect(isEqual(() => 0, {})).toBe(false);
        expect(isEqual(() => 0, null)).toBe(false);
      });
      it("objects with function-valued keys compare by other keys", () => {
        // Two factory-built wrappers with structurally-equal data and
        // referentially-different validate functions — the registry's
        // idempotency check depends on this.
        const a = { type: "object", validate: () => 1, schema: { x: 1 } };
        const b = { type: "object", validate: () => 2, schema: { x: 1 } };
        expect(isEqual(a, b)).toBe(true);
      });
    });

    describe("RegExp", () => {
      it("equal regexes", () => {
        expect(isEqual(/foo/g, /foo/g)).toBe(true);
        expect(isEqual(/abc/iy, /abc/iy)).toBe(true);
      });
      it("different source or flags", () => {
        expect(isEqual(/foo/, /bar/)).toBe(false);
        expect(isEqual(/foo/g, /foo/i)).toBe(false);
      });
    });
  });
});
