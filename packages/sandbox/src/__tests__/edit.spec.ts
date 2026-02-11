import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyEdits, editFile, EditError } from "../edit";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Pure Transform Tests ─────────────────────────────────────────────────────

describe("applyEdits", () => {
  describe("exact match (strategy 1)", () => {
    it("replaces a unique match", () => {
      const source = "function foo() {\n  return 1;\n}";
      const result = applyEdits(source, [{ old: "return 1;", new: "return 2;" }]);
      expect(result.content).toBe("function foo() {\n  return 2;\n}");
      expect(result.applied).toBe(1);
      expect(result.changes).toEqual([{ line: 2, removed: 1, added: 1 }]);
    });

    it("replaces multi-line exact match", () => {
      const source = "a\nb\nc\nd";
      const result = applyEdits(source, [{ old: "b\nc", new: "B\nC" }]);
      expect(result.content).toBe("a\nB\nC\nd");
      expect(result.applied).toBe(1);
    });

    it("handles insert before (prepend to old)", () => {
      const source = "import { foo } from 'foo';\n\nfunction main() {}";
      const result = applyEdits(source, [
        {
          old: "import { foo } from 'foo';",
          new: "import { bar } from 'bar';\nimport { foo } from 'foo';",
        },
      ]);
      expect(result.content).toBe(
        "import { bar } from 'bar';\nimport { foo } from 'foo';\n\nfunction main() {}",
      );
    });

    it("handles insert after (append to old)", () => {
      const source = "line A\nline C";
      const result = applyEdits(source, [{ old: "line A", new: "line A\nline B" }]);
      expect(result.content).toBe("line A\nline B\nline C");
    });

    it("handles delete (empty new)", () => {
      const source = "keep\n// TODO: remove\nfunction unused() {}\nkeep2";
      const result = applyEdits(source, [
        { old: "// TODO: remove\nfunction unused() {}\n", new: "" },
      ]);
      expect(result.content).toBe("keep\nkeep2");
    });

    it("throws on ambiguous match (multiple occurrences)", () => {
      const source = "foo\nbar\nfoo\nbaz";
      expect(() => applyEdits(source, [{ old: "foo", new: "FOO" }])).toThrow(EditError);
      try {
        applyEdits(source, [{ old: "foo", new: "FOO" }]);
      } catch (e: any) {
        expect(e.editIndex).toBe(0);
        expect(e.message).toContain("2 matches found");
        expect(e.message).toContain("lines 1, 3");
      }
    });
  });

  describe("all: true", () => {
    it("replaces all occurrences (rename variable)", () => {
      const source = "const oldName = 1;\nconsole.log(oldName);\nreturn oldName;";
      const result = applyEdits(source, [{ old: "oldName", new: "newName", all: true }]);
      expect(result.content).toBe("const newName = 1;\nconsole.log(newName);\nreturn newName;");
      expect(result.applied).toBe(3);
    });

    it("is a no-op when no matches found (not an error)", () => {
      const source = "const x = 1;";
      const result = applyEdits(source, [{ old: "nonexistent", new: "replacement", all: true }]);
      expect(result.content).toBe(source);
      expect(result.applied).toBe(0);
    });

    it("only uses exact match (no fallback strategies)", () => {
      // Source has trailing whitespace that would match via strategy 2
      const source = "foo  \nbar";
      const result = applyEdits(source, [{ old: "foo", new: "FOO", all: true }]);
      // "foo" matches exactly inside "foo  " so it should work
      expect(result.content).toBe("FOO  \nbar");
      expect(result.applied).toBe(1);
    });
  });

  describe("line-normalized match (strategy 2)", () => {
    it("matches when source has trailing whitespace", () => {
      const source = "function foo() {  \n  return 1;   \n}";
      const result = applyEdits(source, [
        { old: "function foo() {\n  return 1;\n}", new: "function bar() {\n  return 2;\n}" },
      ]);
      expect(result.content).toBe("function bar() {\n  return 2;\n}");
      expect(result.applied).toBe(1);
    });

    it("matches when old has trailing whitespace but source doesn't", () => {
      const source = "function foo() {\n  return 1;\n}";
      const result = applyEdits(source, [
        { old: "function foo() {  \n  return 1;   \n}", new: "function bar() {\n  return 2;\n}" },
      ]);
      expect(result.content).toBe("function bar() {\n  return 2;\n}");
    });
  });

  describe("indent-adjusted match (strategy 3)", () => {
    it("matches when LLM provides unindented version of indented code", () => {
      const source = ["class Foo {", "  method() {", "    return 1;", "  }", "}"].join("\n");

      const result = applyEdits(source, [
        {
          old: "method() {\n  return 1;\n}",
          new: "method() {\n  return 2;\n}",
        },
      ]);

      expect(result.content).toBe(
        ["class Foo {", "  method() {", "    return 2;", "  }", "}"].join("\n"),
      );
    });

    it("adjusts new string indentation to match source", () => {
      const source = ["class Foo {", "    bar() {", "        return 1;", "    }", "}"].join("\n");

      // LLM provides with 0 indent
      const result = applyEdits(source, [
        {
          old: "bar() {\n    return 1;\n}",
          new: "bar() {\n    return 2;\n    console.log('done');\n}",
        },
      ]);

      expect(result.content).toBe(
        [
          "class Foo {",
          "    bar() {",
          "        return 2;",
          "        console.log('done');",
          "    }",
          "}",
        ].join("\n"),
      );
    });

    it("handles deeper nesting", () => {
      const source = [
        "module.exports = {",
        "  plugins: [",
        "    new Plugin({",
        "      option: true,",
        "    }),",
        "  ],",
        "};",
      ].join("\n");

      const result = applyEdits(source, [
        {
          old: "new Plugin({\n  option: true,\n}),",
          new: "new Plugin({\n  option: false,\n  extra: 'yes',\n}),",
        },
      ]);

      expect(result.content).toBe(
        [
          "module.exports = {",
          "  plugins: [",
          "    new Plugin({",
          "      option: false,",
          "      extra: 'yes',",
          "    }),",
          "  ],",
          "};",
        ].join("\n"),
      );
    });
  });

  describe("CRLF normalization", () => {
    it("normalizes CRLF in source to LF", () => {
      const source = "line 1\r\nline 2\r\nline 3";
      const result = applyEdits(source, [{ old: "line 2", new: "LINE 2" }]);
      expect(result.content).toBe("line 1\nLINE 2\nline 3");
      expect(result.content).not.toContain("\r");
    });

    it("normalizes CRLF in edit strings", () => {
      const source = "line 1\nline 2\nline 3";
      const result = applyEdits(source, [{ old: "line 2\r\n", new: "LINE 2\r\n" }]);
      expect(result.content).toContain("LINE 2");
    });
  });

  describe("multi-edit", () => {
    it("applies multiple non-overlapping edits", () => {
      const source = "aaa\nbbb\nccc\nddd";
      const result = applyEdits(source, [
        { old: "aaa", new: "AAA" },
        { old: "ccc", new: "CCC" },
      ]);
      expect(result.content).toBe("AAA\nbbb\nCCC\nddd");
      expect(result.applied).toBe(2);
      expect(result.changes).toHaveLength(2);
    });

    it("applies edits in correct order regardless of edit array order", () => {
      const source = "first\nsecond\nthird";
      // Give edits in reverse order
      const result = applyEdits(source, [
        { old: "third", new: "THIRD" },
        { old: "first", new: "FIRST" },
      ]);
      expect(result.content).toBe("FIRST\nsecond\nTHIRD");
    });

    it("detects overlapping edits and throws", () => {
      const source = "abcdef";
      expect(() =>
        applyEdits(source, [
          { old: "abcd", new: "ABCD" },
          { old: "cdef", new: "CDEF" },
        ]),
      ).toThrow(EditError);

      try {
        applyEdits(source, [
          { old: "abcd", new: "ABCD" },
          { old: "cdef", new: "CDEF" },
        ]);
      } catch (e: any) {
        expect(e.message).toContain("overlap");
      }
    });

    it("handles adjacent (non-overlapping) edits", () => {
      const source = "aabbcc";
      const result = applyEdits(source, [
        { old: "aa", new: "AA" },
        { old: "bb", new: "BB" },
        { old: "cc", new: "CC" },
      ]);
      expect(result.content).toBe("AABBCC");
      expect(result.applied).toBe(3);
    });

    it("mixes exact and fuzzy strategies across edits", () => {
      const source = "  function foo() {\n    return 1;\n  }\n\nconst x = 42;";
      const result = applyEdits(source, [
        // This uses indent-adjusted match (old has no indent)
        { old: "function foo() {\n  return 1;\n}", new: "function foo() {\n  return 2;\n}" },
        // This uses exact match
        { old: "const x = 42;", new: "const x = 99;" },
      ]);
      expect(result.content).toContain("return 2;");
      expect(result.content).toContain("const x = 99;");
    });
  });

  describe("error cases", () => {
    it("throws on empty old string", () => {
      expect(() => applyEdits("source", [{ old: "", new: "x" }])).toThrow(EditError);
      try {
        applyEdits("source", [{ old: "", new: "x" }]);
      } catch (e: any) {
        expect(e.editIndex).toBe(0);
        expect(e.message).toContain("cannot be empty");
      }
    });

    it("throws with diagnostics when no match found", () => {
      const source = "function foo() {\n  return 1;\n}";
      try {
        applyEdits(source, [{ old: "function bar() {\n  return 1;\n}", new: "replaced" }]);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e).toBeInstanceOf(EditError);
        expect(e.editIndex).toBe(0);
        expect(e.message).toContain("no match found");
      }
    });

    it("includes closest line hint in error when first line partially matches", () => {
      // First line "const beta = 2;" exists in source, but the full two-line match fails
      const source = "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;";
      try {
        applyEdits(source, [{ old: "const beta = 2;\nconst NONEXISTENT = 99;", new: "replaced" }]);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e).toBeInstanceOf(EditError);
        expect(e.message).toContain("first line appears near line 2");
        expect(e.detail?.line).toBe(2);
      }
    });

    it("includes editIndex for second edit failure", () => {
      const source = "aaa\nbbb";
      try {
        applyEdits(source, [
          { old: "aaa", new: "AAA" },
          { old: "zzz", new: "ZZZ" },
        ]);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.editIndex).toBe(1);
      }
    });
  });

  describe("edge cases", () => {
    it("returns unchanged content for empty edits array", () => {
      const source = "hello";
      const result = applyEdits(source, []);
      expect(result.content).toBe("hello");
      expect(result.applied).toBe(0);
      expect(result.changes).toEqual([]);
    });

    it("handles single-line source", () => {
      const result = applyEdits("hello world", [{ old: "hello", new: "goodbye" }]);
      expect(result.content).toBe("goodbye world");
    });

    it("handles replacement with empty string (delete)", () => {
      const result = applyEdits("keep delete keep", [{ old: " delete", new: "" }]);
      expect(result.content).toBe("keep keep");
    });

    it("handles replacement that changes line count", () => {
      const source = "a\nb\nc";
      const result = applyEdits(source, [{ old: "b", new: "b1\nb2\nb3" }]);
      expect(result.content).toBe("a\nb1\nb2\nb3\nc");
      expect(result.changes[0]).toEqual({ line: 2, removed: 1, added: 3 });
    });

    it("handles source with empty lines", () => {
      const source = "a\n\nb\n\nc";
      const result = applyEdits(source, [{ old: "b", new: "B" }]);
      expect(result.content).toBe("a\n\nB\n\nc");
    });

    it("changes array is in document order", () => {
      const source = "aaa\nbbb\nccc\nddd\neee";
      const result = applyEdits(source, [
        { old: "eee", new: "EEE" },
        { old: "aaa", new: "AAA" },
        { old: "ccc", new: "CCC" },
      ]);
      expect(result.changes.map((c) => c.line)).toEqual([1, 3, 5]);
    });
  });
});

// ── File I/O Tests ───────────────────────────────────────────────────────────

describe("editFile", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `edit-file-test-${randomBytes(6).toString("hex")}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("reads, edits, and writes file atomically", async () => {
    const filePath = join(testDir, "test.ts");
    await writeFile(filePath, "const x = 1;\nconst y = 2;\n", "utf-8");

    const result = await editFile(filePath, [{ old: "const x = 1;", new: "const x = 42;" }]);

    expect(result.applied).toBe(1);

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("const x = 42;\nconst y = 2;\n");
  });

  it("does not write file when no edits applied", async () => {
    const filePath = join(testDir, "test.ts");
    await writeFile(filePath, "const x = 1;\n", "utf-8");

    const result = await editFile(filePath, [
      { old: "nonexistent", new: "replacement", all: true },
    ]);

    expect(result.applied).toBe(0);
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("const x = 1;\n");
  });

  it("no temp file remains after successful write", async () => {
    const filePath = join(testDir, "test.ts");
    await writeFile(filePath, "hello", "utf-8");

    await editFile(filePath, [{ old: "hello", new: "world" }]);

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(testDir);
    expect(files).toEqual(["test.ts"]);
  });

  it("propagates EditError from applyEdits", async () => {
    const filePath = join(testDir, "test.ts");
    await writeFile(filePath, "hello", "utf-8");

    await expect(editFile(filePath, [{ old: "", new: "x" }])).rejects.toThrow(EditError);
  });
});
