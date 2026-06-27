/**
 * Semantic-HTML dispatch table + `semanticNode` / `semanticBlock`
 * constructors. Pure-function tests; the per-framework walker
 * integration is exercised separately (compiler-react-next).
 */

import { describe, expect, it } from "vitest";

import {
  getSemanticHtmlEntry,
  isSemanticHtmlTag,
  SEMANTIC_HTML_TAGS,
  semanticBlock,
  semanticNode,
} from "../index.js";

describe("semanticNode", () => {
  it("composes a leaf node (no props, no children)", () => {
    expect(semanticNode("em", [])).toEqual({ semantic: "em", children: [] });
  });

  it("includes children", () => {
    const node = semanticNode("strong", [{ text: "hi" }]);
    expect(node).toEqual({ semantic: "strong", children: [{ text: "hi" }] });
  });

  it("attaches props when provided", () => {
    const node = semanticNode("heading", [{ text: "Title" }], { level: 2 });
    expect(node).toEqual({
      semantic: "heading",
      children: [{ text: "Title" }],
      props: { level: 2 },
    });
  });

  it("omits props when undefined", () => {
    expect(semanticNode("paragraph", [])).not.toHaveProperty("props");
  });
});

describe("semanticBlock", () => {
  it("wraps a SemanticNode into a SemanticContentBlock", () => {
    const node = semanticNode("strong", [{ text: "x" }]);
    expect(semanticBlock(node)).toEqual({
      type: "text",
      text: "",
      semanticNode: node,
    });
  });
});

describe("SEMANTIC_HTML_TAGS dispatch table", () => {
  it("recognizes inline emphasis tags", () => {
    expect(SEMANTIC_HTML_TAGS.get("strong")?.semantic).toBe("strong");
    expect(SEMANTIC_HTML_TAGS.get("b")?.semantic).toBe("strong");
    expect(SEMANTIC_HTML_TAGS.get("em")?.semantic).toBe("em");
    expect(SEMANTIC_HTML_TAGS.get("i")?.semantic).toBe("em");
    expect(SEMANTIC_HTML_TAGS.get("mark")?.semantic).toBe("mark");
  });

  it("synthesizes heading level from h1-h6", () => {
    for (const n of [1, 2, 3, 4, 5, 6] as const) {
      const entry = SEMANTIC_HTML_TAGS.get(`h${n}`);
      expect(entry?.semantic).toBe("heading");
      expect(entry?.propsMapper?.({})).toEqual({ level: n });
    }
  });

  it("maps links and reads href", () => {
    const entry = SEMANTIC_HTML_TAGS.get("a");
    expect(entry?.semantic).toBe("link");
    expect(entry?.propsMapper?.({ href: "https://x" })).toEqual({ href: "https://x" });
    expect(entry?.propsMapper?.({})).toBeUndefined();
  });

  it("differentiates ordered vs unordered list", () => {
    expect(SEMANTIC_HTML_TAGS.get("ul")?.propsMapper?.({})).toEqual({ ordered: false });
    expect(SEMANTIC_HTML_TAGS.get("ol")?.propsMapper?.({})).toEqual({ ordered: true });
    expect(SEMANTIC_HTML_TAGS.get("li")?.semantic).toBe("list-item");
  });

  it("models table sub-elements as `semantic: custom` carrying their tag", () => {
    for (const t of ["thead", "tbody", "tr", "td", "th"]) {
      const entry = SEMANTIC_HTML_TAGS.get(t);
      expect(entry?.semantic).toBe("custom");
      expect(entry?.propsMapper?.({})).toEqual({ tag: t });
    }
    expect(SEMANTIC_HTML_TAGS.get("table")?.semantic).toBe("table");
  });

  it("handles inline img with src/alt", () => {
    const entry = SEMANTIC_HTML_TAGS.get("img");
    expect(entry?.semantic).toBe("image");
    expect(entry?.propsMapper?.({ src: "x.png", alt: "the x" })).toEqual({
      src: "x.png",
      alt: "the x",
    });
    expect(entry?.propsMapper?.({})).toBeUndefined();
  });

  it("includes void / separator tags without children", () => {
    expect(SEMANTIC_HTML_TAGS.get("br")?.semantic).toBe("line-break");
    expect(SEMANTIC_HTML_TAGS.get("hr")?.semantic).toBe("horizontal-rule");
  });

  it("does NOT claim lowercase `<code>` (reserved for the CodeBlock helper)", () => {
    expect(SEMANTIC_HTML_TAGS.has("code")).toBe(false);
  });
});

describe("isSemanticHtmlTag / getSemanticHtmlEntry helpers", () => {
  it("returns true for semantic tags", () => {
    expect(isSemanticHtmlTag("strong")).toBe(true);
    expect(isSemanticHtmlTag("p")).toBe(true);
    expect(isSemanticHtmlTag("h3")).toBe(true);
  });

  it("returns false for unknown / reserved tags", () => {
    expect(isSemanticHtmlTag("section")).toBe(false);
    expect(isSemanticHtmlTag("code")).toBe(false);
    expect(isSemanticHtmlTag("recipe-card")).toBe(false);
  });

  it("getSemanticHtmlEntry returns undefined for non-matching", () => {
    expect(getSemanticHtmlEntry("section")).toBeUndefined();
  });
});
