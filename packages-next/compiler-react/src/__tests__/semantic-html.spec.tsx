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

  it("renders a full <table> with rows + cells", async () => {
    const Tpl = () => (
      <section id="x">
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th>count</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>alpha</td>
              <td>1</td>
            </tr>
            <tr>
              <td>beta</td>
              <td>2</td>
            </tr>
          </tbody>
        </table>
      </section>
    );
    const tree = await compileToTree(<Tpl />);
    const sec = tree.context.entries[0] as { content: readonly unknown[] };
    expect(sec.content).toHaveLength(1);
    const tableBlock = sec.content[0] as {
      semanticNode?: { semantic: string; children: readonly unknown[] };
    };
    expect(tableBlock.semanticNode?.semantic).toBe("table");
    // Top-level children of <table> are thead/tbody (modeled as
    // `semantic: "custom"` carrying their tag).
    const top = tableBlock.semanticNode!.children as readonly { semantic: string }[];
    expect(top.map((c) => c.semantic)).toEqual(["custom", "custom"]);

    // Markdown formatter renders this with pipe + dash row.
    const out = await render(<Tpl />);
    expect(out).toContain("name");
    expect(out).toContain("count");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });

  it("drops non-semantic descendants inside an inline semantic tag", async () => {
    // The semantic-html contract: block-level content inside an inline
    // semantic tag is a misuse — drop silently rather than crash.
    // `<section>` inside `<strong>` is the canonical example.
    const Tpl = () => (
      <section id="x">
        <p>
          before
          <strong>
            visible
            <section id="dropped">
              <p>this should NOT appear</p>
            </section>
            after
          </strong>
          tail
        </p>
      </section>
    );
    const out = await render(<Tpl />);
    expect(out).toContain("visible");
    expect(out).toContain("after");
    expect(out).toContain("before");
    expect(out).toContain("tail");
    // The dropped section's text should NOT appear.
    expect(out).not.toContain("this should NOT appear");
    // The dropped section's id should not show up as a separate entry.
    const tree = await compileToTree(<Tpl />);
    expect(tree.context.entries).toHaveLength(1);
    expect((tree.context.entries[0] as { id: string }).id).toBe("x");
  });
});
