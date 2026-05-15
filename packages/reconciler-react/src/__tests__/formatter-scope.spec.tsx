import { describe, expect, it } from "vitest";
import React from "react";
import { createContainer } from "../host/container.js";
import { createHostScope } from "../host/host-context.js";
import { createReconciler } from "../react/reconciler.js";
import { collect } from "../collect/collect.js";
import { createBuiltInRegistry } from "../collect/contributors/built-ins.js";
import {
  FormatScope,
  Markdown,
  XML,
  PlainText,
} from "../react/components/format-scope.js";

/**
 * Render an element + collect with the markdown-default root scope.
 * Returns the collected tree.
 */
function renderAndCollect(element: React.ReactNode) {
  const container = createContainer({
    mountId: "fmt",
    rootScope: createHostScope({ formatter: { id: "markdown", format: "markdown" } }),
  });
  const reconciler = createReconciler({ container, idPrefix: "fmt" });
  const root = reconciler.createRoot();
  reconciler.render(element, root);
  const registry = createBuiltInRegistry();
  return collect({ roots: container.children, registry, rootScope: container.rootScope });
}

describe("FormatScope (and Markdown / XML / PlainText sugar)", () => {
  it("emits no IR fragment of its own — purely a scope provider", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        Markdown,
        null,
        React.createElement("message", { role: "user" }, "hi"),
      ),
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
    const reconciler = createReconciler({ container, idPrefix: "fmt2" });
    const fiberRoot = reconciler.createRoot();
    reconciler.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "section",
          { id: "s.outer" },
          "outer body",
        ),
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
    const [outer, inner] = tree.context.entries;
    if (outer?.kind !== "section" || inner?.kind !== "section") {
      throw new Error("expected two sections");
    }
    expect(outer.renderedWith?.id).toBe("xml");
    expect(inner.renderedWith?.id).toBe("markdown");
  });

  it("XML swaps to xml", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        XML,
        null,
        React.createElement("section", { id: "s" }, "body"),
      ),
    );
    const s = tree.context.entries[0]!;
    if (s.kind !== "section") throw new Error("expected section");
    expect(s.renderedWith?.id).toBe("xml");
    expect(s.renderedWith?.format).toBe("xml");
  });

  it("PlainText swaps to text", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        PlainText,
        null,
        React.createElement("section", { id: "s" }, "body"),
      ),
    );
    const s = tree.context.entries[0]!;
    if (s.kind !== "section") throw new Error("expected section");
    expect(s.renderedWith?.id).toBe("text");
    expect(s.renderedWith?.format).toBe("text");
  });

  it("nested scopes — innermost wins", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        Markdown,
        null,
        React.createElement(
          XML,
          null,
          React.createElement("section", { id: "s.inner" }, "deep"),
        ),
      ),
    );
    const s = tree.context.entries[0]!;
    if (s.kind !== "section") throw new Error("expected section");
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
        React.createElement(
          XML,
          null,
          React.createElement("section", { id: "s.xml" }, "xml body"),
        ),
      ),
    );
    const [a, b] = tree.context.entries;
    if (a?.kind !== "section" || b?.kind !== "section") {
      throw new Error("expected two sections");
    }
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
    const [s, m] = tree.context.entries;
    if (s?.kind !== "section" || m?.kind !== "message") {
      throw new Error("expected section + message");
    }
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
    const s = tree.context.entries[0]!;
    if (s.kind !== "section") throw new Error("expected section");
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
    const s = tree.context.entries[0]!;
    if (s.kind !== "section") throw new Error("expected section");
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
    const s = tree.context.entries[0]!;
    if (s.kind !== "section") throw new Error("expected section");
    expect(s.content).toEqual([{ type: "text", text: "wrapped text" }]);
  });
});
