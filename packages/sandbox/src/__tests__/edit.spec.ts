import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyEdits, editFile, EditError } from "../edit.js";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Pure Transform Tests ─────────────────────────────────────────────────────

describe("applyEdits", () => {
  // ── Replace Mode ──────────────────────────────────────────────────────────

  describe("replace mode — exact match (strategy 1)", () => {
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

  describe("replace mode — all: true", () => {
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
      const source = "foo  \nbar";
      const result = applyEdits(source, [{ old: "foo", new: "FOO", all: true }]);
      expect(result.content).toBe("FOO  \nbar");
      expect(result.applied).toBe(1);
    });
  });

  describe("replace mode — line-normalized match (strategy 2)", () => {
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

  describe("replace mode — indent-adjusted match (strategy 3)", () => {
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

  describe("replace mode — CRLF normalization", () => {
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

  // ── Delete Mode ───────────────────────────────────────────────────────────

  describe("delete mode", () => {
    it("deletes matched text with delete: true", () => {
      const source = "import { unused } from 'lib';\nimport { used } from 'lib2';\n\ncode();";
      const result = applyEdits(source, [{ old: "import { unused } from 'lib';\n", delete: true }]);
      expect(result.content).toBe("import { used } from 'lib2';\n\ncode();");
      expect(result.applied).toBe(1);
    });

    it("delete with all: true removes every occurrence", () => {
      const source = "// TODO\ncode();\n// TODO\nmore();";
      const result = applyEdits(source, [{ old: "// TODO\n", delete: true, all: true }]);
      expect(result.content).toBe("code();\nmore();");
      expect(result.applied).toBe(2);
    });

    it("delete mode is equivalent to new: ''", () => {
      const source = "aaa bbb ccc";
      const deleteResult = applyEdits(source, [{ old: " bbb", delete: true }]);
      const replaceResult = applyEdits(source, [{ old: " bbb", new: "" }]);
      expect(deleteResult.content).toBe(replaceResult.content);
      expect(deleteResult.content).toBe("aaa ccc");
    });

    it("throws when old is missing for delete mode", () => {
      expect(() => applyEdits("source", [{ delete: true }])).toThrow(EditError);
      try {
        applyEdits("source", [{ delete: true }]);
      } catch (e: any) {
        expect(e.message).toContain("old string is required for delete mode");
      }
    });

    it("deletes multi-line block", () => {
      const source =
        "header\n// BEGIN DEPRECATED\nold_func();\nold_other();\n// END DEPRECATED\nfooter";
      const result = applyEdits(source, [
        {
          old: "// BEGIN DEPRECATED\nold_func();\nold_other();\n// END DEPRECATED\n",
          delete: true,
        },
      ]);
      expect(result.content).toBe("header\nfooter");
    });
  });

  // ── Smart Line Deletion ──────────────────────────────────────────────────

  describe("smart line deletion", () => {
    it("deletes a middle line and its trailing newline", () => {
      const source = "line1\nline2\nline3";
      const result = applyEdits(source, [{ old: "line2", delete: true }]);
      expect(result.content).toBe("line1\nline3");
    });

    it("deletes the first line and its trailing newline", () => {
      const source = "line1\nline2\nline3";
      const result = applyEdits(source, [{ old: "line1", delete: true }]);
      expect(result.content).toBe("line2\nline3");
    });

    it("deletes the last line and consumes preceding newline", () => {
      const source = "line1\nline2\nline3";
      const result = applyEdits(source, [{ old: "line3", delete: true }]);
      expect(result.content).toBe("line1\nline2");
    });

    it("does not eat newline for partial-line match", () => {
      const source = "hello world\nnext line";
      const result = applyEdits(source, [{ old: " world", delete: true }]);
      expect(result.content).toBe("hello\nnext line");
    });

    it("applies to replace mode with empty new string", () => {
      const source = "a\nb\nc";
      const result = applyEdits(source, [{ old: "b", new: "" }]);
      expect(result.content).toBe("a\nc");
    });

    it("handles single-line file deletion", () => {
      const source = "only line";
      const result = applyEdits(source, [{ old: "only line", delete: true }]);
      expect(result.content).toBe("");
    });

    it("handles multi-line deletion at start of file", () => {
      const source = "remove1\nremove2\nkeep";
      const result = applyEdits(source, [{ old: "remove1\nremove2", delete: true }]);
      expect(result.content).toBe("keep");
    });
  });

  // ── Insert Mode (before/after) ────────────────────────────────────────────

  describe("insert mode — before/after anchor", () => {
    it("inserts content after anchor", () => {
      const source = "import { foo } from 'foo';\n\nfunction main() {}";
      const result = applyEdits(source, [
        {
          old: "import { foo } from 'foo';",
          insert: "after",
          content: "import { bar } from 'bar';",
        },
      ]);
      expect(result.content).toBe(
        "import { foo } from 'foo';\nimport { bar } from 'bar';\n\nfunction main() {}",
      );
    });

    it("inserts content before anchor", () => {
      const source = "import { foo } from 'foo';\n\nfunction main() {}";
      const result = applyEdits(source, [
        {
          old: "import { foo } from 'foo';",
          insert: "before",
          content: "import { bar } from 'bar';",
        },
      ]);
      expect(result.content).toBe(
        "import { bar } from 'bar';\nimport { foo } from 'foo';\n\nfunction main() {}",
      );
    });

    it("preserves anchor text unchanged", () => {
      const source = "const config = {};";
      const result = applyEdits(source, [
        { old: "const config = {};", insert: "after", content: "export default config;" },
      ]);
      expect(result.content).toContain("const config = {};");
      expect(result.content).toBe("const config = {};\nexport default config;");
    });

    it("inserts with indent adjustment (anchor is indented)", () => {
      const source = ["class Foo {", "  constructor() {}", "", "  uniqueMethod() {}", "}"].join(
        "\n",
      );
      const result = applyEdits(source, [
        {
          old: "  uniqueMethod() {}",
          insert: "before",
          content: "  helperMethod() {\n    return true;\n  }",
        },
      ]);
      expect(result.content).toBe(
        [
          "class Foo {",
          "  constructor() {}",
          "",
          "  helperMethod() {",
          "    return true;",
          "  }",
          "  uniqueMethod() {}",
          "}",
        ].join("\n"),
      );
    });

    it("inserts alongside replace edits in same call", () => {
      const source = "const x = 1;\nconst y = 2;\nconst z = 3;";
      const result = applyEdits(source, [
        { old: "const x = 1;", new: "const x = 10;" },
        { old: "const z = 3;", insert: "after", content: "const w = 4;" },
      ]);
      expect(result.content).toBe("const x = 10;\nconst y = 2;\nconst z = 3;\nconst w = 4;");
    });

    it("inserts after with all: true (insert after every occurrence)", () => {
      const source = "[SECTION]\ndata1\n[SECTION]\ndata2";
      const result = applyEdits(source, [
        { old: "[SECTION]", insert: "after", content: "# auto-generated", all: true },
      ]);
      expect(result.content).toBe(
        "[SECTION]\n# auto-generated\ndata1\n[SECTION]\n# auto-generated\ndata2",
      );
    });

    it("throws when content missing in insert mode", () => {
      expect(() => applyEdits("source", [{ old: "source", insert: "after" }])).toThrow(EditError);
      try {
        applyEdits("source", [{ old: "source", insert: "after" }]);
      } catch (e: any) {
        expect(e.message).toContain("content is required for insert mode");
      }
    });

    it("throws when old missing for insert before/after", () => {
      expect(() => applyEdits("source", [{ insert: "before", content: "new stuff" }])).toThrow(
        EditError,
      );
      try {
        applyEdits("source", [{ insert: "before", content: "new stuff" }]);
      } catch (e: any) {
        expect(e.message).toContain("old string is required as anchor");
      }
    });
  });

  // ── Insert Mode (start/end) ───────────────────────────────────────────────

  describe("insert mode — start/end", () => {
    it("appends content to end of file", () => {
      const source = "line 1\nline 2";
      const result = applyEdits(source, [{ insert: "end", content: "line 3" }]);
      expect(result.content).toBe("line 1\nline 2\nline 3");
    });

    it("prepends content to start of file", () => {
      const source = "line 1\nline 2";
      const result = applyEdits(source, [{ insert: "start", content: "line 0" }]);
      expect(result.content).toBe("line 0\nline 1\nline 2");
    });

    it("handles empty file (no spurious newlines)", () => {
      const result = applyEdits("", [{ insert: "end", content: "first line" }]);
      expect(result.content).toBe("first line");

      const result2 = applyEdits("", [{ insert: "start", content: "first line" }]);
      expect(result2.content).toBe("first line");
    });

    it("prepend + append in same call", () => {
      const source = "body";
      const result = applyEdits(source, [
        { insert: "start", content: "header" },
        { insert: "end", content: "footer" },
      ]);
      expect(result.content).toBe("header\nbody\nfooter");
    });

    it("insert end avoids double-newline when source has trailing newline", () => {
      const source = "line1\nline2\n";
      const result = applyEdits(source, [{ insert: "end", content: "line3" }]);
      expect(result.content).toBe("line1\nline2\nline3");
    });

    it("insert start avoids double-newline when content has trailing newline", () => {
      const source = "line2\nline3";
      const result = applyEdits(source, [{ insert: "start", content: "line1\n" }]);
      expect(result.content).toBe("line1\nline2\nline3");
    });

    it("throws when content missing for insert start/end", () => {
      expect(() => applyEdits("source", [{ insert: "end" }])).toThrow(EditError);
    });
  });

  // ── Range Mode ────────────────────────────────────────────────────────────

  describe("range mode", () => {
    it("replaces content between from and to markers (inclusive)", () => {
      const source = [
        "function calculate() {",
        "  const x = 1;",
        "  const y = 2;",
        "  return x + y;",
        "}",
      ].join("\n");

      const result = applyEdits(source, [
        {
          from: "function calculate() {",
          to: "}",
          content: "function calculate() {\n  return 42;\n}",
        },
      ]);

      expect(result.content).toBe("function calculate() {\n  return 42;\n}");
    });

    it("range with empty content deletes the block", () => {
      const source = "keep\n// --- START ---\nremove this\nand this\n// --- END ---\nalso keep";
      const result = applyEdits(source, [
        {
          from: "// --- START ---",
          to: "// --- END ---",
          content: "",
        },
      ]);
      expect(result.content).toBe("keep\n\nalso keep");
    });

    it("replaces function body while keeping surrounding code", () => {
      const source = [
        "const a = 1;",
        "",
        "function process(data) {",
        "  // lots of old logic",
        "  // that needs replacing",
        "  return data;",
        "}",
        "",
        "const b = 2;",
      ].join("\n");

      const result = applyEdits(source, [
        {
          from: "function process(data) {",
          to: "}",
          content: "function process(data) {\n  return transform(data);\n}",
        },
      ]);

      expect(result.content).toBe(
        [
          "const a = 1;",
          "",
          "function process(data) {",
          "  return transform(data);",
          "}",
          "",
          "const b = 2;",
        ].join("\n"),
      );
    });

    it("throws when to not found after from", () => {
      const source = "end marker\nstart marker\nstuff";
      expect(() =>
        applyEdits(source, [{ from: "start marker", to: "end marker", content: "replaced" }]),
      ).toThrow(EditError);
      try {
        applyEdits(source, [{ from: "start marker", to: "end marker", content: "replaced" }]);
      } catch (e: any) {
        expect(e.message).toContain("'to' marker not found after 'from'");
      }
    });

    it("throws when from not found", () => {
      const source = "some content";
      expect(() =>
        applyEdits(source, [{ from: "nonexistent", to: "content", content: "replaced" }]),
      ).toThrow(EditError);
      try {
        applyEdits(source, [{ from: "nonexistent", to: "content", content: "replaced" }]);
      } catch (e: any) {
        expect(e.message).toContain("no match found for from");
      }
    });

    it("validates that from, to, and content are all required", () => {
      expect(() => applyEdits("x", [{ from: "x", content: "y" } as any])).toThrow(/to is required/);
      expect(() => applyEdits("x", [{ to: "x", content: "y" } as any])).toThrow(/from is required/);
      expect(() => applyEdits("x", [{ from: "x", to: "x" } as any])).toThrow(/content is required/);
    });

    it("handles from and to with same text using unique surrounding context", () => {
      const source = "before [START]content[END] after";
      const result = applyEdits(source, [
        { from: "[START]", to: "[END]", content: "[START]replaced[END]" },
      ]);
      expect(result.content).toBe("before [START]replaced[END] after");
    });
  });

  // ── Multi-edit ────────────────────────────────────────────────────────────

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
        { old: "function foo() {\n  return 1;\n}", new: "function foo() {\n  return 2;\n}" },
        { old: "const x = 42;", new: "const x = 99;" },
      ]);
      expect(result.content).toContain("return 2;");
      expect(result.content).toContain("const x = 99;");
    });

    it("mixes modes: replace + insert + delete in same call", () => {
      const source = "line1\nline2\nline3\nline4\nline5";
      const result = applyEdits(source, [
        { old: "line1", new: "LINE1" },
        { old: "line3", insert: "after", content: "line3.5" },
        { old: "line5", delete: true },
      ]);
      // Smart deletion: "line5" is at end of file, preceding \n consumed
      expect(result.content).toBe("LINE1\nline2\nline3\nline3.5\nline4");
    });
  });

  // ── Error Cases ───────────────────────────────────────────────────────────

  describe("error cases", () => {
    it("throws on empty old string in replace mode", () => {
      expect(() => applyEdits("source", [{ old: "", new: "x" }])).toThrow(EditError);
      try {
        applyEdits("source", [{ old: "", new: "x" }]);
      } catch (e: any) {
        expect(e.editIndex).toBe(0);
        expect(e.message).toContain("cannot be empty");
      }
    });

    it("throws when new is missing in replace mode", () => {
      expect(() => applyEdits("source", [{ old: "source" }])).toThrow(EditError);
      try {
        applyEdits("source", [{ old: "source" }]);
      } catch (e: any) {
        expect(e.message).toContain("new string is required for replace mode");
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
      const source = "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;";
      try {
        applyEdits(source, [{ old: "const beta = 2;\nconst NONEXISTENT = 99;", new: "replaced" }]);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e).toBeInstanceOf(EditError);
        expect(e.message).toContain("First line appears near line 2");
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

  // ── Enhanced Error Diagnostics ────────────────────────────────────────────

  describe("enhanced error diagnostics", () => {
    it("error message includes surrounding context lines", () => {
      const source = [
        "line 1",
        "line 2",
        "function foo(x) {",
        "  return x + 1;",
        "}",
        "line 6",
      ].join("\n");

      try {
        // "function foo" appears in source so partial match will be found
        applyEdits(source, [{ old: "function foo(x) {\n  return WRONG;\n}", new: "replaced" }]);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.detail?.context).toBeDefined();
        expect(e.detail.context.length).toBeGreaterThan(0);
        // Should include surrounding lines
        const contextStr = e.detail.context.join("\n");
        expect(contextStr).toContain("function foo(x)");
      }
    });

    it("error message marks closest line with > indicator", () => {
      const source = "alpha\nbeta\ngamma\ndelta\nepsilon";
      try {
        applyEdits(source, [{ old: "gamma_typo\ndelta", new: "replaced" }]);
        expect.fail("Should have thrown");
      } catch (e: any) {
        // "gamma" appears in the first line of old, but not "gamma_typo"
        // No match at all since "gamma_typo" doesn't appear in any line
        expect(e.message).toContain("no match found");
      }
    });

    it("error includes hint to re-read file", () => {
      const source = "some content";
      try {
        applyEdits(source, [{ old: "nonexistent", new: "replaced" }]);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).toContain("re-read the file");
      }
    });

    it("shows context when partial match exists", () => {
      const source = [
        "// utils.ts",
        "export function add(a: number, b: number) {",
        "  return a + b;",
        "}",
        "",
        "export function multiply(a: number, b: number) {",
        "  return a * b;",
        "}",
      ].join("\n");

      try {
        // "export function add" is the shared substring that causes partial match
        applyEdits(source, [
          {
            old: "export function add(a: number, b: number) {\n  return WRONG;\n}",
            new: "replaced",
          },
        ]);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.detail?.line).toBe(2);
        expect(e.detail?.context).toBeDefined();
        const contextStr = e.detail.context.join("\n");
        expect(contextStr).toContain("export function add");
        // Should show the > marker
        expect(contextStr).toContain(" > ");
      }
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────────────────

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

  // ── Real-World Content Types ──────────────────────────────────────────────

  describe("TypeScript / JavaScript files", () => {
    it("adds a new import to a TS file", () => {
      const source = [
        'import { useState } from "react";',
        'import { Button } from "./components.js";',
        "",
        "export function App() {",
        "  return <Button />;",
        "}",
      ].join("\n");

      const result = applyEdits(source, [
        {
          old: 'import { Button } from "./components.js";',
          insert: "after",
          content: 'import { Input } from "./components.js";',
        },
      ]);

      expect(result.content).toContain('import { Input } from "./components.js";');
      expect(result.content.indexOf("Input")).toBeGreaterThan(result.content.indexOf("Button"));
    });

    it("renames a React component across a file", () => {
      const source = [
        "export function OldWidget({ title }: { title: string }) {",
        "  return <div className='OldWidget'>{title}</div>;",
        "}",
        "",
        "// Usage: <OldWidget title='test' />",
      ].join("\n");

      const result = applyEdits(source, [{ old: "OldWidget", new: "NewWidget", all: true }]);

      expect(result.content).not.toContain("OldWidget");
      expect(result.applied).toBe(3);
    });

    it("replaces a function body using range mode", () => {
      const source = [
        "export function fetchData(url: string) {",
        "  const response = await fetch(url);",
        "  const data = await response.json();",
        "  return data;",
        "} // fetchData",
      ].join("\n");

      const result = applyEdits(source, [
        {
          from: "export function fetchData(url: string) {",
          to: "} // fetchData",
          content: [
            "export function fetchData(url: string) {",
            "  return fetch(url).then(r => r.json());",
            "} // fetchData",
          ].join("\n"),
        },
      ]);

      expect(result.content).toBe(
        "export function fetchData(url: string) {\n  return fetch(url).then(r => r.json());\n} // fetchData",
      );
    });

    it("adds a method to a class", () => {
      const source = [
        "class UserService {",
        "  async getUser(id: string) {",
        "    return db.users.find(id);",
        "  }",
        "}",
      ].join("\n");

      const result = applyEdits(source, [
        {
          old: "  async getUser(id: string) {\n    return db.users.find(id);\n  }",
          insert: "after",
          content: "\n  async deleteUser(id: string) {\n    return db.users.delete(id);\n  }",
        },
      ]);

      expect(result.content).toContain("deleteUser");
      expect(result.content).toContain("getUser");
    });
  });

  describe("JSON files", () => {
    it("adds a new key to package.json", () => {
      const source = JSON.stringify(
        { name: "my-app", version: "1.0.0", dependencies: { react: "^18.0.0" } },
        null,
        2,
      );

      const result = applyEdits(source, [
        {
          old: '"react": "^18.0.0"',
          insert: "after",
          content: ',\n    "react-dom": "^18.0.0"',
        },
      ]);

      expect(result.content).toContain('"react-dom": "^18.0.0"');
    });

    it("updates a JSON value", () => {
      const source = JSON.stringify({ name: "old-name", version: "1.0.0" }, null, 2);
      const result = applyEdits(source, [{ old: '"old-name"', new: '"new-name"' }]);
      expect(result.content).toContain('"new-name"');
      expect(result.content).not.toContain('"old-name"');
    });

    it("removes a JSON key", () => {
      const source = '{\n  "keep": true,\n  "remove": false,\n  "also_keep": true\n}';
      const result = applyEdits(source, [{ old: '\n  "remove": false,', delete: true }]);
      expect(result.content).toBe('{\n  "keep": true,\n  "also_keep": true\n}');
    });
  });

  describe("YAML files", () => {
    it("adds a new entry to a YAML list", () => {
      const source = [
        "services:",
        "  web:",
        "    image: nginx",
        "    ports:",
        '      - "80:80"',
      ].join("\n");

      const result = applyEdits(source, [
        {
          old: '      - "80:80"',
          insert: "after",
          content: '      - "443:443"',
        },
      ]);

      expect(result.content).toContain('- "443:443"');
    });

    it("updates a YAML value", () => {
      const source = "name: my-service\nreplicas: 1\nimage: app:latest";
      const result = applyEdits(source, [{ old: "replicas: 1", new: "replicas: 3" }]);
      expect(result.content).toBe("name: my-service\nreplicas: 3\nimage: app:latest");
    });

    it("adds a new top-level section to YAML", () => {
      const source = "name: app\nversion: 1.0";
      const result = applyEdits(source, [
        {
          insert: "end",
          content: "\nmetadata:\n  author: test\n  license: MIT",
        },
      ]);
      expect(result.content).toContain("metadata:");
      expect(result.content).toContain("  author: test");
    });
  });

  describe("HTML files", () => {
    it("adds a class to an HTML element", () => {
      const source = '<div class="container">\n  <p>Hello World</p>\n</div>';
      const result = applyEdits(source, [
        { old: 'class="container"', new: 'class="container active"' },
      ]);
      expect(result.content).toContain('class="container active"');
    });

    it("inserts a new element inside a container", () => {
      const source = ["<ul>", "  <li>Item 1</li>", "  <li>Item 2</li>", "</ul>"].join("\n");

      const result = applyEdits(source, [
        {
          old: "  <li>Item 2</li>",
          insert: "after",
          content: "  <li>Item 3</li>",
        },
      ]);

      expect(result.content).toBe(
        "<ul>\n  <li>Item 1</li>\n  <li>Item 2</li>\n  <li>Item 3</li>\n</ul>",
      );
    });

    it("replaces an entire HTML section using range", () => {
      const source = [
        "<header>",
        "  <h1>Old Title</h1>",
        "  <nav>old nav</nav>",
        "</header>",
        "<main>content</main>",
      ].join("\n");

      const result = applyEdits(source, [
        {
          from: "<header>",
          to: "</header>",
          content: "<header>\n  <h1>New Title</h1>\n</header>",
        },
      ]);

      expect(result.content).toContain("New Title");
      expect(result.content).not.toContain("Old Title");
      expect(result.content).toContain("<main>content</main>");
    });
  });

  describe("CSS files", () => {
    it("adds a new CSS rule", () => {
      const source = ".container {\n  display: flex;\n}\n\n.item {\n  padding: 8px;\n}";
      const result = applyEdits(source, [
        {
          old: ".item {\n  padding: 8px;\n}",
          insert: "before",
          content: ".item:hover {\n  background: #eee;\n}\n",
        },
      ]);

      expect(result.content).toContain(".item:hover");
      expect(result.content.indexOf("item:hover")).toBeLessThan(result.content.indexOf(".item {"));
    });

    it("modifies a CSS property", () => {
      const source = ".btn {\n  color: red;\n  font-size: 14px;\n}";
      const result = applyEdits(source, [{ old: "color: red;", new: "color: blue;" }]);
      expect(result.content).toContain("color: blue;");
    });

    it("removes a CSS rule using range", () => {
      const source = [
        "/* keep */",
        ".keep { display: block; }",
        "",
        "/* remove */",
        ".remove {",
        "  color: red;",
        "  font-size: 12px;",
        "} /* end remove */",
        "",
        "/* also keep */",
        ".also-keep { margin: 0; }",
      ].join("\n");

      const result = applyEdits(source, [
        { from: "/* remove */", to: "} /* end remove */", content: "" },
      ]);

      expect(result.content).not.toContain(".remove");
      expect(result.content).toContain(".keep");
      expect(result.content).toContain(".also-keep");
    });
  });

  describe("Markdown files", () => {
    it("adds a section to a markdown doc", () => {
      const source =
        "# My Project\n\nSome intro text.\n\n## Installation\n\nnpm install my-project";
      const result = applyEdits(source, [
        {
          old: "## Installation",
          insert: "before",
          content: "## Features\n\n- Feature A\n- Feature B\n",
        },
      ]);

      expect(result.content).toContain("## Features");
      expect(result.content.indexOf("Features")).toBeLessThan(
        result.content.indexOf("Installation"),
      );
    });

    it("updates a markdown link", () => {
      const source = "Check the [docs](https://old-url.com) for more info.";
      const result = applyEdits(source, [
        { old: "https://old-url.com", new: "https://new-url.com" },
      ]);
      expect(result.content).toContain("https://new-url.com");
    });

    it("appends a new item to a markdown list", () => {
      const source = "## Todo\n\n- [x] Task 1\n- [ ] Task 2";
      const result = applyEdits(source, [
        { old: "- [ ] Task 2", insert: "after", content: "- [ ] Task 3" },
      ]);
      expect(result.content).toBe("## Todo\n\n- [x] Task 1\n- [ ] Task 2\n- [ ] Task 3");
    });
  });

  describe("TOML files", () => {
    it("adds a new TOML section", () => {
      const source = '[package]\nname = "my-crate"\nversion = "0.1.0"';
      const result = applyEdits(source, [
        {
          insert: "end",
          content: '\n[dependencies]\nserde = "1.0"',
        },
      ]);
      expect(result.content).toContain("[dependencies]");
      expect(result.content).toContain('serde = "1.0"');
    });

    it("updates a TOML value", () => {
      const source = '[package]\nname = "my-crate"\nversion = "0.1.0"\nedition = "2021"';
      const result = applyEdits(source, [{ old: 'version = "0.1.0"', new: 'version = "0.2.0"' }]);
      expect(result.content).toContain('version = "0.2.0"');
    });
  });

  describe("CSV-like files", () => {
    it("adds a new row to CSV", () => {
      const source = "name,age,city\nAlice,30,NYC\nBob,25,SF";
      const result = applyEdits(source, [{ insert: "end", content: "Charlie,28,LA" }]);
      expect(result.content).toBe("name,age,city\nAlice,30,NYC\nBob,25,SF\nCharlie,28,LA");
    });

    it("updates a CSV cell", () => {
      const source = "name,age,city\nAlice,30,NYC\nBob,25,SF";
      const result = applyEdits(source, [{ old: "Alice,30,NYC", new: "Alice,31,NYC" }]);
      expect(result.content).toContain("Alice,31,NYC");
    });

    it("adds a new column header and data", () => {
      const source = "name,age\nAlice,30\nBob,25";
      const result = applyEdits(source, [
        { old: "name,age", new: "name,age,city" },
        { old: "Alice,30", new: "Alice,30,NYC" },
        { old: "Bob,25", new: "Bob,25,SF" },
      ]);
      expect(result.content).toBe("name,age,city\nAlice,30,NYC\nBob,25,SF");
    });
  });

  describe("SQL files", () => {
    it("adds a column to a CREATE TABLE", () => {
      const source = [
        "CREATE TABLE users (",
        "  id SERIAL PRIMARY KEY,",
        "  name VARCHAR(255) NOT NULL,",
        "  email VARCHAR(255) UNIQUE",
        ");",
      ].join("\n");

      const result = applyEdits(source, [
        {
          old: "  email VARCHAR(255) UNIQUE",
          insert: "after",
          content: ",\n  created_at TIMESTAMP DEFAULT NOW()",
        },
      ]);

      expect(result.content).toContain("created_at TIMESTAMP");
    });

    it("replaces a WHERE clause", () => {
      const source = "SELECT * FROM users\nWHERE status = 'active'\nORDER BY name;";
      const result = applyEdits(source, [
        { old: "WHERE status = 'active'", new: "WHERE status = 'active' AND role = 'admin'" },
      ]);
      expect(result.content).toContain("AND role = 'admin'");
    });
  });

  describe("Dockerfile", () => {
    it("adds a new layer to Dockerfile", () => {
      const source = "FROM node:18-alpine\nWORKDIR /app\nCOPY package.json .\nRUN npm install";
      const result = applyEdits(source, [
        {
          old: "RUN npm install",
          insert: "before",
          content: "COPY tsconfig.json .",
        },
      ]);
      expect(result.content).toContain("COPY tsconfig.json");
      expect(result.content.indexOf("tsconfig")).toBeLessThan(
        result.content.indexOf("npm install"),
      );
    });

    it("updates base image", () => {
      const source = "FROM node:16-alpine\nWORKDIR /app";
      const result = applyEdits(source, [
        { old: "FROM node:16-alpine", new: "FROM node:20-alpine" },
      ]);
      expect(result.content).toContain("FROM node:20-alpine");
    });
  });

  describe("INI / .env files", () => {
    it("adds a new environment variable", () => {
      const source = "DATABASE_URL=postgres://localhost/db\nREDIS_URL=redis://localhost:6379";
      const result = applyEdits(source, [{ insert: "end", content: "API_KEY=secret123" }]);
      expect(result.content).toContain("API_KEY=secret123");
    });

    it("updates an existing env value", () => {
      const source = "NODE_ENV=development\nPORT=3000";
      const result = applyEdits(source, [{ old: "PORT=3000", new: "PORT=8080" }]);
      expect(result.content).toBe("NODE_ENV=development\nPORT=8080");
    });

    it("removes an env variable", () => {
      const source = "KEY1=val1\nDEBUG=true\nKEY2=val2";
      const result = applyEdits(source, [{ old: "\nDEBUG=true", delete: true }]);
      expect(result.content).toBe("KEY1=val1\nKEY2=val2");
    });
  });

  describe("XML files", () => {
    it("adds an XML element", () => {
      const source = [
        '<?xml version="1.0"?>',
        "<config>",
        "  <database>",
        "    <host>localhost</host>",
        "  </database>",
        "</config>",
      ].join("\n");

      const result = applyEdits(source, [
        {
          old: "    <host>localhost</host>",
          insert: "after",
          content: "    <port>5432</port>",
        },
      ]);

      expect(result.content).toContain("<port>5432</port>");
    });

    it("updates an XML attribute", () => {
      const source = '<widget id="old-id" class="active">\n  <label>Click me</label>\n</widget>';
      const result = applyEdits(source, [{ old: 'id="old-id"', new: 'id="new-id"' }]);
      expect(result.content).toContain('id="new-id"');
    });
  });

  describe("Python files", () => {
    it("adds a decorator to a function", () => {
      const source = [
        "class MyView:",
        "    def get(self, request):",
        "        return Response(data)",
      ].join("\n");

      const result = applyEdits(source, [
        {
          old: "    def get(self, request):",
          insert: "before",
          content: "    @login_required",
        },
      ]);

      expect(result.content).toContain("@login_required");
      expect(result.content.indexOf("@login_required")).toBeLessThan(
        result.content.indexOf("def get"),
      );
    });

    it("replaces a Python function body using range", () => {
      const source = [
        "def process(data):",
        "    result = []",
        "    for item in data:",
        "        result.append(item * 2)",
        "    return result",
        "",
        "def other():",
        "    pass",
      ].join("\n");

      const result = applyEdits(source, [
        {
          from: "def process(data):",
          to: "    return result",
          content: "def process(data):\n    return [item * 2 for item in data]",
        },
      ]);

      expect(result.content).toContain("return [item * 2 for item in data]");
      expect(result.content).toContain("def other():");
    });
  });

  describe("Rust files", () => {
    it("adds a derive attribute to a struct", () => {
      const source = ["struct Point {", "    x: f64,", "    y: f64,", "}"].join("\n");

      const result = applyEdits(source, [
        {
          old: "struct Point {",
          insert: "before",
          content: "#[derive(Debug, Clone, PartialEq)]",
        },
      ]);

      expect(result.content).toContain("#[derive(Debug, Clone, PartialEq)]");
      expect(result.content.indexOf("#[derive")).toBeLessThan(
        result.content.indexOf("struct Point"),
      );
    });

    it("adds a new field to a Rust struct", () => {
      const source = "struct Config {\n    host: String,\n    port: u16,\n}";
      const result = applyEdits(source, [
        {
          old: "    port: u16,",
          insert: "after",
          content: "    timeout: Duration,",
        },
      ]);
      expect(result.content).toContain("timeout: Duration");
    });
  });

  describe("Go files", () => {
    it("adds an import to a Go file", () => {
      const source = [
        "package main",
        "",
        'import "fmt"',
        "",
        "func main() {",
        '    fmt.Println("hello")',
        "}",
      ].join("\n");

      const result = applyEdits(source, [
        {
          old: 'import "fmt"',
          new: 'import (\n    "fmt"\n    "os"\n)',
        },
      ]);

      expect(result.content).toContain('"os"');
    });
  });

  describe("Shell scripts", () => {
    it("adds a new step to a shell script", () => {
      const source = "#!/bin/bash\nset -e\n\necho 'Building...'\nnpm run build";
      const result = applyEdits(source, [
        {
          old: "npm run build",
          insert: "before",
          content: "npm run lint",
        },
      ]);
      expect(result.content).toContain("npm run lint");
      expect(result.content.indexOf("lint")).toBeLessThan(result.content.indexOf("build"));
    });

    it("updates shebang line", () => {
      const source = "#!/bin/bash\necho 'hello'";
      const result = applyEdits(source, [{ old: "#!/bin/bash", new: "#!/usr/bin/env bash" }]);
      expect(result.content).toContain("#!/usr/bin/env bash");
    });
  });

  describe("gitignore / dotfiles", () => {
    it("adds patterns to .gitignore", () => {
      const source = "node_modules/\n.env\ndist/";
      const result = applyEdits(source, [{ insert: "end", content: "coverage/\n*.log" }]);
      expect(result.content).toContain("coverage/");
      expect(result.content).toContain("*.log");
    });

    it("removes a pattern from .gitignore", () => {
      const source = "node_modules/\n.env\ndist/";
      const result = applyEdits(source, [{ old: "\n.env", delete: true }]);
      expect(result.content).toBe("node_modules/\ndist/");
    });
  });

  describe("configuration files (nginx, apache, etc.)", () => {
    it("adds a location block to nginx config", () => {
      const source = [
        "server {",
        "    listen 80;",
        "    server_name example.com;",
        "",
        "    location / {",
        "        proxy_pass http://app:3000;",
        "    }",
        "}",
      ].join("\n");

      const result = applyEdits(source, [
        {
          old: "    location / {\n        proxy_pass http://app:3000;\n    }",
          insert: "after",
          content: "\n    location /api {\n        proxy_pass http://api:8080;\n    }",
        },
      ]);

      expect(result.content).toContain("location /api");
      expect(result.content).toContain("proxy_pass http://api:8080");
    });
  });

  describe("Makefile", () => {
    it("adds a new make target", () => {
      const source = "build:\n\tgo build -o app .\n\ntest:\n\tgo test ./...";
      const result = applyEdits(source, [
        {
          insert: "end",
          content: "\nclean:\n\trm -f app",
        },
      ]);
      expect(result.content).toContain("clean:");
      expect(result.content).toContain("\trm -f app");
    });
  });

  describe("Proto / GraphQL schema files", () => {
    it("adds a field to a GraphQL type", () => {
      const source = ["type User {", "  id: ID!", "  name: String!", "  email: String!", "}"].join(
        "\n",
      );

      const result = applyEdits(source, [
        {
          old: "  email: String!",
          insert: "after",
          content: "  avatar: String",
        },
      ]);

      expect(result.content).toContain("  avatar: String");
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

  it("supports insert mode via file I/O", async () => {
    const filePath = join(testDir, "config.yaml");
    await writeFile(filePath, "key: value\n", "utf-8");

    const result = await editFile(filePath, [{ insert: "end", content: "new_key: new_value" }]);

    expect(result.applied).toBe(1);
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("new_key: new_value");
  });

  it("supports range mode via file I/O", async () => {
    const filePath = join(testDir, "code.ts");
    await writeFile(filePath, "function old() {\n  // lots of code\n  return 1;\n}\n", "utf-8");

    const result = await editFile(filePath, [
      {
        from: "function old() {",
        to: "}",
        content: "function old() {\n  return 2;\n}",
      },
    ]);

    expect(result.applied).toBe(1);
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("function old() {\n  return 2;\n}\n");
  });

  it("supports delete mode via file I/O", async () => {
    const filePath = join(testDir, "code.ts");
    await writeFile(filePath, "keep\nremove\nkeep2\n", "utf-8");

    const result = await editFile(filePath, [{ old: "remove\n", delete: true }]);

    expect(result.applied).toBe(1);
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("keep\nkeep2\n");
  });
});
