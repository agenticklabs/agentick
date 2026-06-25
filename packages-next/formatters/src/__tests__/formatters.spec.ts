/**
 * Unit tests for the reference formatters.
 *
 * Pure functions, so each test is a direct input → output assertion
 * against `SemanticContentBlock[]`.
 */

import { describe, expect, it } from "vitest";

import type { SemanticContentBlock, SemanticNode } from "@agentick/spec-next";
import { createFormatter, markdownFormatter, textFormatter, xmlFormatter } from "../index.js";

function textBlock(text: string): SemanticContentBlock {
  return { type: "text", text } as SemanticContentBlock;
}

function semantic(node: SemanticNode): SemanticContentBlock {
  return { type: "text", text: "", semanticNode: node } as SemanticContentBlock;
}

describe("createFormatter", () => {
  it("attaches identity metadata", () => {
    const fmt = createFormatter({
      id: "test.json",
      format: "json",
      render: (blocks) => [...blocks],
    });
    expect(fmt.__identity.id).toBe("test.json");
    expect(fmt.__identity.format).toBe("json");
  });

  it("optional version is preserved", () => {
    const fmt = createFormatter({
      id: "test.v",
      format: "markdown",
      version: "1.2.3",
      render: () => [],
    });
    expect(fmt.__identity.version).toBe("1.2.3");
  });
});

describe("markdownFormatter", () => {
  it("passes plain TextBlocks through unchanged", () => {
    const out = markdownFormatter([textBlock("hello")]);
    expect(out).toEqual([{ type: "text", text: "hello" }]);
  });

  it("fences code blocks", () => {
    const blocks: SemanticContentBlock[] = [
      { type: "code", language: "ts", text: "let x = 1;" } as SemanticContentBlock,
    ];
    const out = markdownFormatter(blocks);
    expect(out[0]).toEqual({
      type: "text",
      text: "```ts\nlet x = 1;\n```",
    });
  });

  it("compact-stringifies json blocks", () => {
    const blocks: SemanticContentBlock[] = [
      { type: "json", data: { ok: true } } as SemanticContentBlock,
    ];
    const out = markdownFormatter(blocks);
    expect((out[0] as { text: string }).text).toBe("```json\n" + '{"ok":true}' + "\n```");
  });

  it("formats <strong> as bold", () => {
    const out = markdownFormatter([semantic({ semantic: "strong", children: [{ text: "go" }] })]);
    expect((out[0] as { text: string }).text).toBe("**go**");
  });

  it("formats nested semantic tree", () => {
    const out = markdownFormatter([
      semantic({
        children: [
          { text: "hello " },
          { semantic: "strong", children: [{ text: "world" }] },
          { text: ", " },
          { semantic: "em", children: [{ text: "now" }] },
        ],
      }),
    ]);
    expect((out[0] as { text: string }).text).toBe("hello **world**, *now*");
  });

  it("renders heading with level prop", () => {
    const out = markdownFormatter([
      semantic({
        semantic: "heading",
        props: { level: 2 },
        children: [{ text: "Hi" }],
      }),
    ]);
    expect((out[0] as { text: string }).text).toBe("## Hi\n\n");
  });

  it("renders unordered list", () => {
    const out = markdownFormatter([
      semantic({
        semantic: "list",
        children: [
          { semantic: "list-item", children: [{ text: "a" }] },
          { semantic: "list-item", children: [{ text: "b" }] },
        ],
      }),
    ]);
    expect((out[0] as { text: string }).text).toBe("- a\n- b\n\n");
  });

  it("passes native blocks through (image)", () => {
    const img: SemanticContentBlock = {
      type: "image",
      source: { type: "url", url: "x" },
    } as SemanticContentBlock;
    const out = markdownFormatter([img]);
    expect(out[0]).toBe(img);
  });
});

describe("xmlFormatter", () => {
  it("wraps semantic strong with <strong> tags", () => {
    const out = xmlFormatter([semantic({ semantic: "strong", children: [{ text: "x" }] })]);
    expect((out[0] as { text: string }).text).toBe("<strong>x</strong>");
  });

  it("escapes XML special chars in TextBlock text", () => {
    const out = xmlFormatter([textBlock('a & b "c"')]);
    expect((out[0] as { text: string }).text).toBe("a &amp; b &quot;c&quot;");
  });

  it("renders headings with h1-h6 tags", () => {
    const out = xmlFormatter([
      semantic({
        semantic: "heading",
        props: { level: 3 },
        children: [{ text: "Hi" }],
      }),
    ]);
    expect((out[0] as { text: string }).text).toBe("<h3>Hi</h3>");
  });

  it("renders ordered list as <ol>", () => {
    const out = xmlFormatter([
      semantic({
        semantic: "list",
        props: { ordered: true },
        children: [{ semantic: "list-item", children: [{ text: "a" }] }],
      }),
    ]);
    expect((out[0] as { text: string }).text).toBe("<ol><li>a</li></ol>");
  });

  it("wraps code blocks in <code language=...>", () => {
    const out = xmlFormatter([
      { type: "code", language: "ts", text: "const x = 1;" } as SemanticContentBlock,
    ]);
    expect((out[0] as { text: string }).text).toBe('<code language="ts">const x = 1;</code>');
  });
});

describe("textFormatter", () => {
  it("strips semantic markup", () => {
    const out = textFormatter([
      semantic({
        children: [{ text: "Hello " }, { semantic: "strong", children: [{ text: "world" }] }],
      }),
    ]);
    expect((out[0] as { text: string }).text).toBe("Hello world");
  });

  it("flattens code to bare text", () => {
    const out = textFormatter([
      { type: "code", language: "ts", text: "x" } as SemanticContentBlock,
    ]);
    expect((out[0] as { text: string }).text).toBe("x");
  });

  it("turns links into 'text (href)'", () => {
    const out = textFormatter([
      semantic({
        semantic: "link",
        props: { href: "https://x" },
        children: [{ text: "go" }],
      }),
    ]);
    expect((out[0] as { text: string }).text).toBe("go (https://x)");
  });
});

describe("builtInFormatters", () => {
  it("includes markdown, xml, text formatters keyed by their id", async () => {
    const { builtInFormatters } = await import("../index.js");
    const reg = builtInFormatters();
    expect(reg.get("formatter.markdown")).toBe(markdownFormatter);
    expect(reg.get("formatter.xml")).toBe(xmlFormatter);
    expect(reg.get("formatter.text")).toBe(textFormatter);
  });
});
