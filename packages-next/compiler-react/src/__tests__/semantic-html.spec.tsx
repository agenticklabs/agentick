/**
 * Walker integration with the semantic-html dispatch:
 *   - Inline emphasis (<strong>, <em>, <mark>, <u>, …) produces a
 *     SemanticContentBlock with a nested SemanticNode tree.
 *   - Nested semantic tags compose into nested children.
 *   - Block-level descendants of inline tags are dropped (contract).
 *   - List + table tags map to the correct semantic type.
 *   - Links carry `props.href`; ordered/unordered list distinction works.
 *   - h1-h6 produce headings via the semantic-html path (semantic IR,
 *     formatter chooses syntax).
 *   - The markdown formatter renders the produced IR correctly.
 */

import { xmlFormatter } from "@agentick/formatters-next";
import React from "react";
import { describe, expect, it } from "vitest";

import { compileToTree, render } from "../index.js";

describe("walker — semantic-html intrinsics", () => {
  it("emits a SemanticContentBlock for inline <strong>", async () => {
    const Tpl = () => (
      <section id="x">
        <p>
          plain <strong>bold</strong> text
        </p>
      </section>
    );
    const tree = await compileToTree(<Tpl />);
    const sec = tree.context.entries[0] as { content: readonly unknown[] };
    // Section content: <p> wraps inline content into one semantic block
    // with children = [text, strong-node, text].
    expect(sec.content).toHaveLength(1);
    const block = sec.content[0] as { semanticNode?: { semantic: string; children: unknown[] } };
    expect(block.semanticNode?.semantic).toBe("paragraph");
    expect(block.semanticNode?.children?.length).toBeGreaterThan(0);
  });

  it("nests <em> inside <strong>", async () => {
    const Tpl = () => (
      <section id="x">
        <p>
          <strong>
            outer <em>inner</em> end
          </strong>
        </p>
      </section>
    );
    const out = await render(<Tpl />);
    // Markdown emits **outer *inner* end** inside a paragraph.
    expect(out).toMatch(/\*\*outer \*inner\* end\*\*/);
  });

  it("h2 produces a heading via the semantic path (markdown # syntax)", async () => {
    const Tpl = () => (
      <section id="x">
        <h2>Title</h2>
      </section>
    );
    const out = await render(<Tpl />);
    expect(out).toContain("## Title");
  });

  it("unordered list (<ul><li>) renders as markdown list", async () => {
    const Tpl = () => (
      <section id="x">
        <ul>
          <li>one</li>
          <li>two</li>
        </ul>
      </section>
    );
    const out = await render(<Tpl />);
    expect(out).toMatch(/- one/);
    expect(out).toMatch(/- two/);
  });

  it("ordered list (<ol><li>) renders as numbered markdown", async () => {
    const Tpl = () => (
      <section id="x">
        <ol>
          <li>first</li>
          <li>second</li>
        </ol>
      </section>
    );
    const out = await render(<Tpl />);
    expect(out).toMatch(/1\. first/);
    expect(out).toMatch(/2\. second/);
  });

  it("anchor (<a href>) carries href via propsMapper", async () => {
    const Tpl = () => (
      <section id="x">
        <p>
          see <a href="https://example.com">the docs</a>
        </p>
      </section>
    );
    const tree = await compileToTree(<Tpl />);
    const sec = tree.context.entries[0] as { content: readonly unknown[] };
    const para = (sec.content[0] as { semanticNode: { children: unknown[] } }).semanticNode;
    const linkNode = para.children.find(
      (c): c is { semantic: string; props: { href: string } } =>
        typeof c === "object" && c !== null && (c as { semantic?: string }).semantic === "link",
    );
    expect(linkNode?.props.href).toBe("https://example.com");
  });

  it("XML formatter renders semantic tags as XML elements", async () => {
    const Tpl = () => (
      <section id="x">
        <p>
          <strong>bold</strong>
        </p>
      </section>
    );
    const out = await render(<Tpl />, { formatter: xmlFormatter });
    expect(out).toContain("<strong>");
    expect(out).toContain("bold");
  });

  it("renders <blockquote> via semantic path", async () => {
    const Tpl = () => (
      <section id="x">
        <blockquote>quoted text</blockquote>
      </section>
    );
    const out = await render(<Tpl />);
    expect(out).toMatch(/^> quoted text/m);
  });
});
