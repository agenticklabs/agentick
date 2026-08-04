import { describe, expect, it } from "vitest";
import React from "react";
import type { ContentBlock } from "@agentick/spec";
import { createContainer } from "@agentick/compiler";
import { createHostScope } from "@agentick/compiler";
import { createCompiler } from "../react/compiler.js";
import { collect } from "@agentick/compiler";
import { createBuiltInRegistry } from "@agentick/compiler";

function renderAndCollect(element: React.ReactNode) {
  const container = createContainer({
    mountId: "blk",
    rootScope: createHostScope({ formatter: { id: "markdown", format: "markdown" } }),
  });
  const compiler = createCompiler({ container, idPrefix: "blk" });
  const root = compiler.createRoot();
  compiler.render(element, root);
  const registry = createBuiltInRegistry();
  return collect({ roots: container.children, registry, rootScope: container.rootScope });
}

/**
 * ADR 94 — every entry is a `MessageEntry` now. A free-floating `<section>`
 * is an anonymous `grounding` message and a `<message>` is itself, so the
 * first entry's content reads the same way regardless of role.
 *
 * The subject of this file is what the BLOCK CONTRIBUTORS produce, which is
 * what a section's `sectionNode` sidecar carries — the collect walk hands the
 * structure to the formatter pass without lowering it, so under a `<section>`
 * wrapper the contributors' blocks live one level in. Unwrapping here keeps
 * every assertion about the contributor rather than about the lowering (that
 * rule is pinned in formatters/__tests__/section-lowering.spec.ts).
 */
function contentOf(tree: ReturnType<typeof renderAndCollect>["tree"]): readonly ContentBlock[] {
  const first = tree.context.entries[0];
  if (first === undefined) throw new Error("expected an entry");
  const [only] = first.content;
  const section = (only as { sectionNode?: { content: readonly ContentBlock[] } } | undefined)
    ?.sectionNode;
  return section ? section.content : first.content;
}

describe("content blocks — inside <section>", () => {
  it("<image> with url source", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        "section",
        { id: "s" },
        React.createElement("image", {
          source: { type: "url", url: "https://x.test/a.png" },
          altText: "a",
        }),
      ),
    );
    const blocks = contentOf(tree);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "image",
      source: { type: "url", url: "https://x.test/a.png" },
      altText: "a",
    });
  });

  it("<code language='ts'> folds children to text", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        "section",
        { id: "s" },
        React.createElement("code", { language: "typescript" }, "const x = 1;"),
      ),
    );
    expect(contentOf(tree)[0]).toMatchObject({
      type: "code",
      language: "typescript",
      text: "const x = 1;",
    });
  });

  it("<json data={...}> serializes data directly", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        "section",
        { id: "s" },
        React.createElement("json", { data: { ok: true, n: 7 } }),
      ),
    );
    expect(contentOf(tree)[0]).toMatchObject({
      type: "json",
      data: { ok: true, n: 7 },
    });
  });

  it("<document> + <audio> + <video>", () => {
    const src = { type: "url", url: "https://x.test/file" } as const;
    const { tree } = renderAndCollect(
      React.createElement(
        "section",
        { id: "s" },
        React.createElement("document", { source: src, title: "Doc" }),
        React.createElement("audio", { source: src, transcript: "hi" }),
        React.createElement("video", { source: src }),
      ),
    );
    const types = contentOf(tree).map((b) => b.type);
    expect(types).toEqual(["document", "audio", "video"]);
  });

  it("<reasoning> folds children to text", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        "section",
        { id: "s" },
        React.createElement("reasoning", null, "step 1: consider X"),
      ),
    );
    expect(contentOf(tree)[0]).toMatchObject({
      type: "reasoning",
      text: "step 1: consider X",
    });
  });

  it("<xml-block> + <csv> + <html>", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        "section",
        { id: "s" },
        React.createElement("xml-block", null, "<a/>"),
        React.createElement("csv", { headers: ["a", "b"] }, "1,2\n3,4"),
        React.createElement("html", null, "<p>hi</p>"),
      ),
    );
    const blocks = contentOf(tree);
    expect(blocks.map((b) => b.type)).toEqual(["xml", "csv", "html"]);
    expect((blocks[1] as { headers?: readonly string[] }).headers).toEqual(["a", "b"]);
  });

  it("<text> explicit content-block keeps its own id", () => {
    // Wrapper is `<message>`, not `<section>`: this test's subject is the
    // `<text>` contributor's BLOCK-LEVEL id, and ADR 94's `lowerSection`
    // deliberately coalesces a section's plain-text run into one block
    // re-stamped with the SECTION's id. Under a section wrapper the
    // assertion would be testing the lowering, not the contributor — that
    // rule is pinned in formatters/__tests__/section-lowering.spec.ts.
    const { tree } = renderAndCollect(
      React.createElement(
        "message",
        { role: "user" },
        React.createElement("text", { id: "t1" }, "explicit"),
      ),
    );
    expect(contentOf(tree)[0]).toMatchObject({
      type: "text",
      text: "explicit",
      id: "t1",
    });
  });
});

describe("content blocks — event blocks inside <message role='event'>", () => {
  it("<user_action> with action + children text", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        "message",
        { role: "event" },
        React.createElement(
          "user_action",
          { action: "click", target: "submit-btn" },
          "user clicked Submit",
        ),
      ),
    );
    expect(contentOf(tree)[0]).toMatchObject({
      type: "user_action",
      action: "click",
      target: "submit-btn",
      text: "user clicked Submit",
    });
  });

  it("<system_event>", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        "message",
        { role: "event" },
        React.createElement(
          "system_event",
          { event: "deploy", source: "ci", data: { tag: "v1.2.0" } },
          "Deployed v1.2.0",
        ),
      ),
    );
    expect(contentOf(tree)[0]).toMatchObject({
      type: "system_event",
      event: "deploy",
      source: "ci",
      data: { tag: "v1.2.0" },
      text: "Deployed v1.2.0",
    });
  });

  it("<state_change>", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        "message",
        { role: "event" },
        React.createElement(
          "state_change",
          { entity: "ticket", field: "status", from: "open", to: "closed" },
          "Ticket closed",
        ),
      ),
    );
    expect(contentOf(tree)[0]).toMatchObject({
      type: "state_change",
      entity: "ticket",
      field: "status",
      from: "open",
      to: "closed",
      text: "Ticket closed",
    });
  });
});

describe("content blocks — custom + diagnostics", () => {
  it("<custom> with tag + attrs", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        "section",
        { id: "s" },
        React.createElement("custom", { tag: "checkpoint", attrs: { phase: "ingest" } }, "saved"),
      ),
    );
    expect(contentOf(tree)[0]).toMatchObject({
      type: "custom",
      tag: "checkpoint",
      attrs: { phase: "ingest" },
      content: "saved",
    });
  });

  it("missing required prop emits a warning diagnostic and skips", () => {
    // `<image>` and `<code>` collide with React's HTML/SVG intrinsics and
    // can't be augmented to match v2's prop shape — see
    // src/react/jsx-intrinsics.d.ts for the omission rationale. Tests for
    // these contributors use React.createElement directly.
    const { diagnostics, tree } = renderAndCollect(
      React.createElement(
        "section",
        { id: "s" },
        // Intentionally missing `source` — emits MISSING_SOURCE.
        React.createElement("image", {}),
        React.createElement(
          "code",
          { language: "typescript" } as Record<string, unknown>,
          "ok = 1",
        ),
      ),
    );
    expect(diagnostics.some((d) => d.code === "MISSING_SOURCE")).toBe(true);
    const blocks = contentOf(tree);
    // Image was skipped; code still landed.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("code");
  });

  it("<code> without language emits diagnostic", () => {
    const { diagnostics } = renderAndCollect(
      React.createElement(
        "section",
        { id: "s" },
        // Intentionally missing `language` — emits MISSING_LANGUAGE.
        React.createElement("code", null, "no lang"),
      ),
    );
    expect(diagnostics.some((d) => d.code === "MISSING_LANGUAGE")).toBe(true);
  });
});

describe("content blocks — composing inside <message>", () => {
  it("mixing text + image + code in one message", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        "message",
        { role: "user" },
        "Look at this: ",
        React.createElement("image", {
          source: { type: "url", url: "https://x.test/a.png" },
        }),
        " and the snippet ",
        React.createElement("code", { language: "typescript" }, "const x = 1"),
      ),
    );
    const blocks = contentOf(tree);
    const types = blocks.map((b) => b.type);
    expect(types).toEqual(["text", "image", "text", "code"]);
  });

  it("<content> folds persisted blocks in place, between authored siblings", () => {
    // Replaying a stored message as children — the alternative is building the
    // `content` array by hand, which shadows every child and decides the dialect
    // at construction time.
    const persisted: ContentBlock[] = [{ type: "text", text: "persisted" }];
    const { tree } = renderAndCollect(
      React.createElement(
        "message",
        { role: "user" },
        React.createElement("text", { text: "before" }),
        React.createElement("content", { blocks: persisted }),
        React.createElement("text", { text: "after" }),
      ),
    );
    expect(contentOf(tree).map((b) => (b as { text?: string }).text)).toEqual([
      "before",
      "persisted",
      "after",
    ]);
  });
});

describe("<message> — `content` prop precedence (v1-compat)", () => {
  it("non-empty `content` prop wins over children", () => {
    const prebuilt: ContentBlock[] = [
      { type: "text", text: "from prop" },
      { type: "code", language: "typescript", text: "const x = 1" },
    ];
    const { tree } = renderAndCollect(
      React.createElement(
        "message",
        { role: "user", content: prebuilt },
        // Children should be ignored when prop is non-empty.
        "from children",
        React.createElement("image", {
          source: { type: "url", url: "https://x.test/a.png" },
        }),
      ),
    );
    const blocks = contentOf(tree);
    expect(blocks.map((b) => b.type)).toEqual(["text", "code"]);
    expect((blocks[0] as { text: string }).text).toBe("from prop");
  });

  it("empty `content` prop falls through to children", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        "message",
        { role: "user", content: [] as ContentBlock[] },
        "fallback text",
      ),
    );
    const blocks = contentOf(tree);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "text", text: "fallback text" });
  });

  it("omitted `content` prop collects from children as before", () => {
    const { tree } = renderAndCollect(React.createElement("message", { role: "user" }, "hello"));
    expect(contentOf(tree)).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("content blocks — JSON firewall", () => {
  it("all block types survive JSON round-trip", () => {
    const src = { type: "url", url: "https://x.test/" } as const;
    const { tree } = renderAndCollect(
      React.createElement(
        "section",
        { id: "s" },
        React.createElement("image", { source: src }),
        React.createElement("code", { language: "go" }, "package main"),
        React.createElement("json", { data: { ok: true } }),
        React.createElement("document", { source: src }),
        React.createElement("audio", { source: src }),
        React.createElement("video", { source: src }),
        React.createElement("reasoning", null, "thinking…"),
        React.createElement("custom", { tag: "marker" }, "x"),
      ),
    );
    const round = JSON.parse(JSON.stringify(tree));
    expect(round).toEqual(tree);
  });
});
