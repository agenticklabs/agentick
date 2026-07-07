/**
 * `applyEdits` — direct unit tests for the ported crown-jewel transform.
 *
 * A representative subset of v1's `edit.spec.ts` covering the load-bearing
 * behaviors: the 3-strategy layered matching (exact → line-normalized →
 * indent-adjusted), all modes (replace / delete / insert / range), smart
 * line deletion, CRLF normalization, multi-edit overlap detection, and
 * diagnostic errors. The harness integration path is covered in
 * `harness.spec.ts`.
 */

import { describe, expect, it } from "vitest";
import { applyEdits, EditError } from "../edit.js";

describe("applyEdits — strategy 1: exact match", () => {
  it("replaces a unique match and reports the change", () => {
    const result = applyEdits("function foo() {\n  return 1;\n}", [
      { old: "return 1;", new: "return 2;" },
    ]);
    expect(result.content).toBe("function foo() {\n  return 2;\n}");
    expect(result.applied).toBe(1);
    expect(result.changes).toEqual([{ line: 2, removed: 1, added: 1 }]);
  });

  it("throws on ambiguous match (multiple occurrences, no all)", () => {
    expect(() => applyEdits("foo\nbar\nfoo", [{ old: "foo", new: "FOO" }])).toThrow(EditError);
  });

  it("all: true renames every occurrence", () => {
    const result = applyEdits("const oldName = 1;\nlog(oldName);", [
      { old: "oldName", new: "newName", all: true },
    ]);
    expect(result.content).toBe("const newName = 1;\nlog(newName);");
    expect(result.applied).toBe(2);
  });
});

describe("applyEdits — strategy 2: line-normalized match", () => {
  it("matches despite trailing whitespace in source", () => {
    const result = applyEdits("function foo() {  \n  return 1;   \n}", [
      { old: "function foo() {\n  return 1;\n}", new: "function bar() {\n  return 2;\n}" },
    ]);
    expect(result.content).toBe("function bar() {\n  return 2;\n}");
  });
});

describe("applyEdits — strategy 3: indent-adjusted match", () => {
  it("matches unindented anchor and re-indents the replacement", () => {
    const source = ["class Foo {", "  method() {", "    return 1;", "  }", "}"].join("\n");
    const result = applyEdits(source, [
      { old: "method() {\n  return 1;\n}", new: "method() {\n  return 2;\n}" },
    ]);
    expect(result.content).toBe(
      ["class Foo {", "  method() {", "    return 2;", "  }", "}"].join("\n"),
    );
  });
});

describe("applyEdits — delete + smart line deletion", () => {
  it("deletes a middle line and consumes its trailing newline", () => {
    expect(applyEdits("line1\nline2\nline3", [{ old: "line2", delete: true }]).content).toBe(
      "line1\nline3",
    );
  });

  it("deletes the last line and consumes the preceding newline", () => {
    expect(applyEdits("line1\nline2\nline3", [{ old: "line3", delete: true }]).content).toBe(
      "line1\nline2",
    );
  });
});

describe("applyEdits — insert modes", () => {
  it("inserts after an anchor", () => {
    const result = applyEdits("import a;\n\nmain();", [
      { old: "import a;", insert: "after", content: "import b;" },
    ]);
    expect(result.content).toBe("import a;\nimport b;\n\nmain();");
  });

  it("appends to end without doubling newlines", () => {
    expect(applyEdits("line1\nline2\n", [{ insert: "end", content: "line3" }]).content).toBe(
      "line1\nline2\nline3",
    );
  });

  it("prepends to start", () => {
    expect(applyEdits("line1\nline2", [{ insert: "start", content: "line0" }]).content).toBe(
      "line0\nline1\nline2",
    );
  });
});

describe("applyEdits — range mode", () => {
  it("replaces the block between from/to (inclusive)", () => {
    const source = ["function f() {", "  const x = 1;", "  return x;", "}"].join("\n");
    const result = applyEdits(source, [
      { from: "function f() {", to: "}", content: "function f() {\n  return 42;\n}" },
    ]);
    expect(result.content).toBe("function f() {\n  return 42;\n}");
  });

  it("throws when 'to' is not found after 'from'", () => {
    expect(() =>
      applyEdits("end\nstart\nstuff", [{ from: "start", to: "end", content: "x" }]),
    ).toThrow(/'to' marker not found after 'from'/);
  });
});

describe("applyEdits — CRLF normalization", () => {
  it("normalizes CRLF in source to LF", () => {
    const result = applyEdits("line 1\r\nline 2\r\nline 3", [{ old: "line 2", new: "LINE 2" }]);
    expect(result.content).toBe("line 1\nLINE 2\nline 3");
    expect(result.content).not.toContain("\r");
  });
});

describe("applyEdits — multi-edit", () => {
  it("applies multiple non-overlapping edits in document order", () => {
    const result = applyEdits("aaa\nbbb\nccc\nddd", [
      { old: "ccc", new: "CCC" },
      { old: "aaa", new: "AAA" },
    ]);
    expect(result.content).toBe("AAA\nbbb\nCCC\nddd");
    expect(result.changes.map((c) => c.line)).toEqual([1, 3]);
  });

  it("detects overlapping edits and throws", () => {
    expect(() =>
      applyEdits("abcdef", [
        { old: "abcd", new: "ABCD" },
        { old: "cdef", new: "CDEF" },
      ]),
    ).toThrow(/overlap/);
  });
});

describe("applyEdits — diagnostics", () => {
  it("no-match error carries the closest partial line + context", () => {
    const source = "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;";
    try {
      applyEdits(source, [{ old: "const beta = 2;\nconst NONEXISTENT = 99;", new: "x" }]);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EditError);
      expect((e as EditError).detail?.line).toBe(2);
      expect((e as EditError).message).toContain("re-read the file");
    }
  });

  it("empty edits array is a no-op", () => {
    expect(applyEdits("hello", [])).toEqual({ content: "hello", applied: 0, changes: [] });
  });
});
