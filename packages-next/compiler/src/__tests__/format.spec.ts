/**
 * `format(tree, opts?)` — RenderedTree → string via formatters-next.
 *
 * Verifies:
 *   - default formatter is markdownFormatter
 *   - sections render their content (no inline header — section
 *     identity lives in id/title/metadata)
 *   - messages prefix the role
 *   - heading helpers round-trip through the formatter into markdown
 *   - code/json blocks render as fenced markdown
 *   - non-markdown formatters reachable via opts.formatter
 */

import type { RenderedTree } from "@agentick/spec-next";
import { textFormatter, xmlFormatter } from "@agentick/formatters-next";
import { describe, expect, it } from "vitest";

import {
  codeBlock,
  format,
  headerBlock,
  jsonBlock,
  messageEntry,
  sectionEntry,
  textBlock,
} from "../index.js";

function tree(
  entries: RenderedTree["context"]["entries"],
  content?: RenderedTree["content"],
): RenderedTree {
  return {
    specVersion: "2026-05-08",
    context: { entries },
    ...(content ? { content } : {}),
  };
}

describe("format(tree)", () => {
  it("renders a single section's body via the default markdown formatter", () => {
    const out = format(
      tree([sectionEntry({ id: "intro" }, [headerBlock(1, "Hello"), textBlock("world.")])]),
    );
    expect(out).toMatch(/# Hello/);
    expect(out).toMatch(/world\./);
  });

  it("messages prefix the role", () => {
    const out = format(tree([messageEntry({ role: "user" }, [textBlock("hi there")])]));
    expect(out.startsWith("user:")).toBe(true);
    expect(out).toMatch(/hi there/);
  });

  it("renders multiple entries separated by blank lines", () => {
    const out = format(
      tree([
        sectionEntry({ id: "a" }, [textBlock("first")]),
        sectionEntry({ id: "b" }, [textBlock("second")]),
      ]),
    );
    const parts = out.split("\n\n");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("first");
    expect(parts[1]).toContain("second");
  });

  it("renders code blocks as markdown fenced code", () => {
    const out = format(tree([sectionEntry({ id: "x" }, [codeBlock("let x = 1;", "typescript")])]));
    expect(out).toContain("```typescript\nlet x = 1;\n```");
  });

  it("renders json blocks as fenced JSON", () => {
    const out = format(tree([sectionEntry({ id: "x" }, [jsonBlock({ a: 1 })])]));
    expect(out).toContain("```json");
    // markdownFormatter uses compact JSON.stringify (no indent).
    expect(out).toContain('"a":1');
  });

  it("renders heading semantic blocks via the markdown formatter (no pre-rendered hashes)", () => {
    // The IR carries a semantic heading; the formatter chooses syntax.
    // Markdown formatter emits `## Title`.
    const out = format(tree([sectionEntry({ id: "x" }, [headerBlock(2, "Title")])]));
    expect(out).toContain("## Title");
  });

  it("xml formatter override produces XML tags instead of markdown", () => {
    const out = format(tree([sectionEntry({ id: "x" }, [headerBlock(1, "Hi")])]), {
      formatter: xmlFormatter,
    });
    expect(out).toContain("<h1>");
    expect(out).toContain("Hi");
    expect(out).not.toContain("# Hi");
  });

  it("text formatter override strips all markup", () => {
    const out = format(tree([sectionEntry({ id: "x" }, [headerBlock(1, "Plain")])]), {
      formatter: textFormatter,
    });
    expect(out).toContain("Plain");
    expect(out).not.toContain("#");
    expect(out).not.toContain("<h1>");
  });

  it("renders root-level tree.content after all entries", () => {
    const out = format(
      tree([sectionEntry({ id: "x" }, [textBlock("entry-body")])], [textBlock("root-body")]),
    );
    const idxEntry = out.indexOf("entry-body");
    const idxRoot = out.indexOf("root-body");
    expect(idxEntry).toBeGreaterThanOrEqual(0);
    expect(idxRoot).toBeGreaterThan(idxEntry);
  });

  it("empty tree renders empty string", () => {
    expect(format(tree([]))).toBe("");
  });
});
