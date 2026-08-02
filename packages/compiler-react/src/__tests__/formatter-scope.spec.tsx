import { describe, expect, it } from "vitest";
import React from "react";
import type { MessageEntry } from "@agentick/spec";
import { markdownFormatter } from "@agentick/formatters";
import { createContainer } from "@agentick/compiler";
import { createHostScope } from "@agentick/compiler";
import { createCompiler } from "../react/compiler.js";
import { collect } from "@agentick/compiler";
import { createBuiltInRegistry } from "@agentick/compiler";
import { FormatScope, Markdown, XML, PlainText } from "../react/components/format-scope.js";

/**
 * Render an element + collect with the markdown-default root scope.
 * Returns the collected tree.
 */
function renderAndCollect(element: React.ReactNode) {
  const container = createContainer({
    mountId: "fmt",
    rootScope: createHostScope({ formatter: { id: "markdown", format: "markdown" } }),
  });
  const compiler = createCompiler({ container, idPrefix: "fmt" });
  const root = compiler.createRoot();
  compiler.render(element, root);
  const registry = createBuiltInRegistry();
  return collect({ roots: container.children, registry, rootScope: container.rootScope });
}

/**
 * ADR 94 — a free-floating `<section>` is a `grounding` message, not a
 * `SectionEntry`. `renderedWith` is still stamped from the in-scope `section`
 * format purpose onto the entry the section became, so every scope-resolution
 * claim below survives verbatim; only the `kind === "section"` narrowing had
 * to move to a role check.
 */
const grounding = (entry: MessageEntry | undefined): MessageEntry => {
  if (entry?.role !== "grounding") throw new Error("expected a grounding entry");
  return entry;
};

describe("FormatScope (and Markdown / XML / PlainText sugar)", () => {
  it("emits no IR fragment of its own — purely a scope provider", () => {
    const { tree } = renderAndCollect(
      React.createElement(Markdown, null, React.createElement("message", { role: "user" }, "hi")),
    );
    // Only the message entry, no extra fragment for Markdown/format.
    expect(tree.context.entries).toHaveLength(1);
    const m = tree.context.entries[0]!;
    if (m.kind !== "message") throw new Error("expected message");
    expect(m.role).toBe("user");
  });

  it("Markdown swaps the formatter for descendants' content", () => {
    const root = createHostScope({ formatter: { id: "xml", format: "xml" } });
    const container = createContainer({ mountId: "fmt2", rootScope: root });
    const compiler = createCompiler({ container, idPrefix: "fmt2" });
    const fiberRoot = compiler.createRoot();
    compiler.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement("section", { id: "s.outer" }, "outer body"),
        React.createElement(
          Markdown,
          null,
          React.createElement("section", { id: "s.inner" }, "inner body"),
        ),
      ),
      fiberRoot,
    );
    const registry = createBuiltInRegistry();
    const { tree } = collect({
      roots: container.children,
      registry,
      rootScope: container.rootScope,
    });
    const [outer, inner] = [grounding(tree.context.entries[0]), grounding(tree.context.entries[1])];
    expect(outer.renderedWith?.id).toBe("xml");
    expect(inner.renderedWith?.id).toBe("markdown");
  });

  it("XML swaps to xml", () => {
    const { tree } = renderAndCollect(
      React.createElement(XML, null, React.createElement("section", { id: "s" }, "body")),
    );
    const s = grounding(tree.context.entries[0]);
    expect(s.renderedWith?.id).toBe("xml");
    expect(s.renderedWith?.format).toBe("xml");
  });

  it("PlainText swaps to text", () => {
    const { tree } = renderAndCollect(
      React.createElement(PlainText, null, React.createElement("section", { id: "s" }, "body")),
    );
    const s = grounding(tree.context.entries[0]);
    expect(s.renderedWith?.id).toBe("text");
    expect(s.renderedWith?.format).toBe("text");
  });

  it("nested scopes — innermost wins", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        Markdown,
        null,
        React.createElement(XML, null, React.createElement("section", { id: "s.inner" }, "deep")),
      ),
    );
    const s = grounding(tree.context.entries[0]);
    expect(s.renderedWith?.id).toBe("xml");
  });

  it("sibling scopes are isolated", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          Markdown,
          null,
          React.createElement("section", { id: "s.md" }, "md body"),
        ),
        React.createElement(XML, null, React.createElement("section", { id: "s.xml" }, "xml body")),
      ),
    );
    const a = grounding(tree.context.entries[0]);
    const b = grounding(tree.context.entries[1]);
    expect(a.renderedWith?.id).toBe("markdown");
    expect(b.renderedWith?.id).toBe("xml");
  });

  it("purpose-scoped FormatScope only swaps the named purpose", () => {
    // Default formatter is markdown. <FormatScope formatter=xml purpose=section>
    // should make sections render as xml but messages stay as markdown.
    const { tree } = renderAndCollect(
      React.createElement(
        FormatScope,
        { formatter: { id: "xml", format: "xml" }, purpose: "section" },
        React.createElement(
          React.Fragment,
          null,
          React.createElement("section", { id: "s.purp" }, "section body"),
          React.createElement("message", { role: "user" }, "message body"),
        ),
      ),
    );
    const s = grounding(tree.context.entries[0]);
    const m = tree.context.entries[1];
    if (m?.role !== "user") throw new Error("expected a user message");
    // ADR 94 — `renderedWith` on the grounding entry still comes from the
    // `section` format purpose, so purpose scoping is unaffected by the
    // section-entry deletion.
    expect(s.renderedWith?.id).toBe("xml");
    expect(m.renderedWith?.id).toBe("markdown"); // unchanged
  });

  it("missing formatter prop passes through the parent scope (lenient)", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        "format" as unknown as React.JSXElementConstructor<unknown>,
        {} as unknown as React.Attributes,
        React.createElement("section", { id: "s.untouched" }, "body"),
      ),
    );
    const s = grounding(tree.context.entries[0]);
    expect(s.renderedWith?.id).toBe("markdown");
  });

  it("user-defined formatter via FormatScope works (custom formatter id)", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        FormatScope,
        { formatter: { id: "custom-yaml", format: "yaml" } },
        React.createElement("section", { id: "s.yaml" }, "body"),
      ),
    );
    const s = grounding(tree.context.entries[0]);
    expect(s.renderedWith?.id).toBe("custom-yaml");
    expect(s.renderedWith?.format).toBe("yaml");
  });

  it("scope provider inside a section folds content-block children correctly", () => {
    // <section><Markdown><text>...</text></Markdown></section>
    // The Markdown wrapper should be transparent to the section's
    // content fold. Currently <text> isn't a contributor — folding
    // produces no blocks for the inner subtree. The test is here to
    // pin the regression: section contributors must keep working even
    // when their inline children pass through a scope provider.
    const { tree } = renderAndCollect(
      React.createElement(
        "section",
        { id: "s.wrap" },
        React.createElement(Markdown, null, "wrapped text"),
      ),
    );
    const s = grounding(tree.context.entries[0]);
    // ADR 94 — collect carries the section's structure and the formatter pass
    // lowers it, so the folded blocks are inside the `sectionNode` sidecar.
    // The claim under test is unchanged: the wrapper is transparent, the text
    // still lands — and it still lands after lowering.
    expect(s.content).toEqual([
      {
        type: "text",
        text: "",
        sectionNode: { id: "s.wrap", content: [{ type: "text", text: "wrapped text" }] },
      },
    ]);
    expect(markdownFormatter(s.content)).toEqual([
      { type: "text", text: "wrapped text", id: "s.wrap", metadata: { section: "s.wrap" } },
    ]);
  });
});
