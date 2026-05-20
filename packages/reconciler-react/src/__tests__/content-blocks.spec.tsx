import { describe, expect, it } from "vitest";
import React from "react";
import type { ContentBlock } from "@agentick/spec";
import { createContainer } from "../host/container.js";
import { createHostScope } from "../host/host-context.js";
import { createReconciler } from "../react/reconciler.js";
import { collect } from "../collect/collect.js";
import { createBuiltInRegistry } from "../collect/contributors/built-ins.js";

function renderAndCollect(element: React.ReactNode) {
  const container = createContainer({
    mountId: "blk",
    rootScope: createHostScope({ formatter: { id: "markdown", format: "markdown" } }),
  });
  const reconciler = createReconciler({ container, idPrefix: "blk" });
  const root = reconciler.createRoot();
  reconciler.render(element, root);
  const registry = createBuiltInRegistry();
  return collect({ roots: container.children, registry, rootScope: container.rootScope });
}

function contentOf(tree: ReturnType<typeof renderAndCollect>["tree"]): readonly ContentBlock[] {
  const first = tree.context.entries[0]!;
  if (first.kind === "section") return first.content;
  if (first.kind === "message") return first.content;
  throw new Error("expected section or message");
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

  it("<text> explicit content-block", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        "section",
        { id: "s" },
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
    const { diagnostics, tree } = renderAndCollect(
      React.createElement(
        "section",
        { id: "s" },
        // @ts-expect-error — intentionally missing source
        React.createElement("image", {}),
        React.createElement("code", { language: "typescript" }, "ok = 1"),
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
        // @ts-expect-error — language required
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
