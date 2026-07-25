import { describe, expect, it } from "vitest";

import { applyJsonPatch, JsonPatchError, type JsonPatchOp } from "../json-patch.js";

describe("applyJsonPatch", () => {
  describe("object ops", () => {
    it("replace sets an existing key", () => {
      expect(applyJsonPatch({ a: 1, b: 2 }, [{ op: "replace", path: "/a", value: 9 }])).toEqual({
        a: 9,
        b: 2,
      });
    });

    it("add creates a new key", () => {
      expect(applyJsonPatch({ a: 1 }, [{ op: "add", path: "/b", value: 2 }])).toEqual({
        a: 1,
        b: 2,
      });
    });

    it("add on an existing key behaves as replace (RFC 6902)", () => {
      expect(applyJsonPatch({ a: 1 }, [{ op: "add", path: "/a", value: 5 }])).toEqual({ a: 5 });
    });

    it("remove deletes a key", () => {
      const out = applyJsonPatch({ a: 1, b: 2 }, [{ op: "remove", path: "/a" }]);
      expect(out).toEqual({ b: 2 });
      expect("a" in out).toBe(false);
    });

    it("throws when replace targets a missing key", () => {
      expect(() => applyJsonPatch({ a: 1 }, [{ op: "replace", path: "/z", value: 1 }])).toThrow(
        JsonPatchError,
      );
    });

    it("throws when remove targets a missing key", () => {
      expect(() => applyJsonPatch({ a: 1 }, [{ op: "remove", path: "/z" }])).toThrow(
        JsonPatchError,
      );
    });
  });

  describe("nested paths", () => {
    it("mutates a deep key", () => {
      expect(
        applyJsonPatch({ a: { b: { c: 1 } } }, [{ op: "replace", path: "/a/b/c", value: 2 }]),
      ).toEqual({ a: { b: { c: 2 } } });
    });

    it("unescapes ~1 (/) and ~0 (~) in tokens", () => {
      const doc = { "a/b": 1, "m~n": 2 };
      const out = applyJsonPatch(doc, [
        { op: "replace", path: "/a~1b", value: 9 },
        { op: "replace", path: "/m~0n", value: 8 },
      ]);
      expect(out).toEqual({ "a/b": 9, "m~n": 8 });
    });
  });

  describe("array ops", () => {
    it("add inserts at an index", () => {
      expect(applyJsonPatch({ xs: [1, 3] }, [{ op: "add", path: "/xs/1", value: 2 }])).toEqual({
        xs: [1, 2, 3],
      });
    });

    it('add with "-" appends', () => {
      expect(applyJsonPatch({ xs: [1, 2] }, [{ op: "add", path: "/xs/-", value: 3 }])).toEqual({
        xs: [1, 2, 3],
      });
    });

    it("remove splices an element", () => {
      expect(applyJsonPatch({ xs: [1, 2, 3] }, [{ op: "remove", path: "/xs/1" }])).toEqual({
        xs: [1, 3],
      });
    });

    it("throws on a non-numeric or out-of-bounds index", () => {
      expect(() =>
        applyJsonPatch({ xs: [1] }, [{ op: "replace", path: "/xs/x", value: 0 }]),
      ).toThrow(JsonPatchError);
      expect(() =>
        applyJsonPatch({ xs: [1] }, [{ op: "replace", path: "/xs/5", value: 0 }]),
      ).toThrow(JsonPatchError);
    });
  });

  describe("test op", () => {
    it("passes on deep-equal value and leaves the doc untouched", () => {
      const doc = { a: { b: [1, 2] } };
      const out = applyJsonPatch(doc, [{ op: "test", path: "/a", value: { b: [1, 2] } }]);
      expect(out).toBe(doc); // same reference — test never clones.
    });

    it("throws on mismatch", () => {
      expect(() => applyJsonPatch({ a: 1 }, [{ op: "test", path: "/a", value: 2 }])).toThrow(
        JsonPatchError,
      );
    });
  });

  describe("immutability + structural sharing", () => {
    it("never mutates the input document", () => {
      const doc = { a: 1, nested: { x: 1 } };
      const frozen = JSON.parse(JSON.stringify(doc));
      applyJsonPatch(doc, [{ op: "replace", path: "/a", value: 99 }]);
      expect(doc).toEqual(frozen);
    });

    it("shares untouched subtrees by reference (copy-on-write)", () => {
      const doc = { touched: { v: 1 }, untouched: { v: 2 } };
      const out = applyJsonPatch(doc, [{ op: "replace", path: "/touched/v", value: 9 }]);
      expect(out.untouched).toBe(doc.untouched); // shared
      expect(out.touched).not.toBe(doc.touched); // cloned along the path
    });
  });

  describe("op sequencing", () => {
    it("applies ops in order, each seeing prior results", () => {
      const ops: JsonPatchOp[] = [
        { op: "add", path: "/b", value: 2 },
        { op: "replace", path: "/b", value: 3 },
        { op: "test", path: "/b", value: 3 },
      ];
      expect(applyJsonPatch({ a: 1 }, ops)).toEqual({ a: 1, b: 3 });
    });

    it("replaces the whole document at path ''", () => {
      expect(applyJsonPatch({ a: 1 }, [{ op: "replace", path: "", value: { z: 9 } }])).toEqual({
        z: 9,
      });
    });
  });
});
