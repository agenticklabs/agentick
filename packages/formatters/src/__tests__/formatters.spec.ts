/**
 * Unit tests for the reference formatters.
 *
 * Pure functions, so each test is a direct input → output assertion
 * against `SemanticContentBlock[]`.
 */

import { describe, expect, it } from "vitest";

import type { SemanticContentBlock, SemanticNode } from "@agentick/spec";
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

describe("custom content blocks — the tag is the whole point", () => {
  // `CustomContentBlock` declares `tag` and `attrs` as REQUIRED fields, so a
  // formatter that drops them returns the one thing the block did not carry.
  // EVERY dialect emits the tag now, including markdown: CommonMark specifies
  // raw HTML blocks, so "markdown has no tag syntax" was never true — and this
  // formatter already emits `<kbd>` and `<var>`. While markdown dropped it, the
  // escape hatch was unreachable in the only dialect anyone renders.
  const block = {
    type: "custom" as const,
    tag: "memory-kind",
    content: "episodic recall",
    attrs: { kind: "episodic", weight: "0.8" },
  };

  // The drop is on the COLLAPSE path (`blocksToText`) — what `formatTree` calls
  // to fold a slot's blocks into one string — not on `render`.
  const xmlText = (b: unknown) => xmlFormatter.blocksToText!([b as never]);
  const mdText = (b: unknown) => markdownFormatter.blocksToText!([b as never]);

  it("xml emits the custom tag with its attributes", () => {
    expect(xmlText(block)).toBe(
      '<memory-kind kind="episodic" weight="0.8">episodic recall</memory-kind>',
    );
  });

  it("xml escapes attribute values", () => {
    expect(xmlText({ ...block, attrs: { note: 'a "quoted" & <raw>' } })).toContain(
      'note="a &quot;quoted&quot; &amp; &lt;raw&gt;"',
    );
  });

  it("xml honours selfClosing", () => {
    expect(xmlText({ ...block, content: "", selfClosing: true })).toBe(
      '<memory-kind kind="episodic" weight="0.8" />',
    );
  });

  it("markdown emits the custom tag too", () => {
    expect(mdText(block)).toBe(
      '<memory-kind kind="episodic" weight="0.8">episodic recall</memory-kind>',
    );
  });

  it("markdown escapes attribute values, and leaves content verbatim", () => {
    // Attribute position is attribute position in any dialect — a raw quote,
    // `<` or `&` there is a malformed tag. Content is markdown and stays as
    // written; escaping `<` there would break every other construct.
    expect(mdText({ ...block, attrs: { note: 'a "quoted" & <raw>' } })).toBe(
      '<memory-kind note="a &quot;quoted&quot; &amp; &lt;raw&gt;">episodic recall</memory-kind>',
    );
    expect(mdText({ ...block, content: "keep <this> & that" })).toContain("keep <this> & that");
  });

  it("markdown honours selfClosing", () => {
    expect(mdText({ ...block, content: "", selfClosing: true })).toBe(
      '<memory-kind kind="episodic" weight="0.8" />',
    );
  });

  // The SEMANTIC-NODE path — what a nested `<custom>` becomes, since only the
  // outermost one is a block. It emitted `<tag>` but silently dropped `attrs`
  // and `selfClosing`, the mirror image of the block-case bug: one fix made the
  // block match the node on the TAG, and nobody noticed the node had never
  // handled the rest. `renderAttrs` is now shared so they cannot drift again.
  const node = {
    semantic: "custom" as const,
    props: { tag: "memory-kind", attrs: { kind: "episodic" } },
    children: [{ text: "episodic recall" }],
  };
  // A semantic node reaches a formatter as a block carrying `semanticNode`, and
  // only on the RENDER path — the formatter itself is callable; `blocksToText`
  // is the separate collapse path that sees already-formatted blocks.
  const rendered = (f: typeof xmlFormatter, n: unknown): string => {
    const out = f([{ type: "text", text: "", semanticNode: n } as never]);
    return out.map((b) => (b as { text?: string }).text ?? "").join("");
  };
  const xmlNode = (n: unknown) => rendered(xmlFormatter, n);
  const mdNode = (n: unknown) => rendered(markdownFormatter, n);

  it("xml carries attributes on a NESTED custom node, not just a block", () => {
    expect(xmlNode(node)).toContain('<memory-kind kind="episodic">');
  });

  it("markdown carries them too", () => {
    expect(mdNode(node)).toContain('<memory-kind kind="episodic">');
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
