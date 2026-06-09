/**
 * Semantic HTML contributors — verifies:
 *   - Walker emits `semantic-node` fragments for `<strong>`, `<h1>`,
 *     `<ul>`, `<a>`, `<img>`, etc.
 *   - Coalescing: contiguous text + semantic-node children of a
 *     `<message>` / `<section>` fold into ONE TextBlock with sidecar.
 *   - Native content blocks (Image, Code) break the run.
 *   - Pure-text content stays as plain TextBlock (no sidecar).
 *   - End-to-end through markdown / xml / text formatters produces the
 *     expected output strings.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { ReconcilerHarness } from "../harness/reconciler-harness.js";
import { stubBridges } from "@agentick/reconciler-next";

async function makeHarness() {
  const h = new ReconcilerHarness(
    "h_sem",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await h.ready;
  return h;
}

function getMessage(tree: { context: { entries: readonly { kind: string }[] } }) {
  const m = tree.context.entries[0]!;
  if (m.kind !== "message") throw new Error("expected message entry");
  return m as unknown as {
    kind: "message";
    content: readonly { type: string; text?: string }[];
  };
}

describe("semantic HTML — coalescing", () => {
  it("pure text run produces one plain TextBlock (no sidecar)", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_plain",
      sessionId: "s",
      element: React.createElement("message", { role: "user" }, "Hello world"),
      bridges: stubBridges(),
    });
    const { tree } = await harness.renderTree({
      mountId: "m_plain",
      sessionId: "s",
    });
    const msg = getMessage(tree);
    expect(msg.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("text + inline semantic folds into one TextBlock", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_inline",
      sessionId: "s",
      element: React.createElement(
        "message",
        { role: "user" },
        "Hello ",
        React.createElement("strong", null, "world"),
        "!",
      ),
      bridges: stubBridges(),
    });
    const { tree } = await harness.renderTree({
      mountId: "m_inline",
      sessionId: "s",
    });
    const msg = getMessage(tree);
    // After the formatter pass, the sidecar has been resolved to a
    // markdown string in a single TextBlock.
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toEqual({
      type: "text",
      text: "Hello **world**!",
    });
  });

  it("native content block breaks the run into separate blocks", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_break",
      sessionId: "s",
      element: React.createElement(
        "message",
        { role: "user" },
        "Hello ",
        React.createElement("strong", null, "world"),
        React.createElement("image", {
          source: { type: "url", url: "https://x.test/a.png" },
        }),
        "After.",
      ),
      bridges: stubBridges(),
    });
    const { tree } = await harness.renderTree({
      mountId: "m_break",
      sessionId: "s",
    });
    const msg = getMessage(tree);
    expect(msg.content).toHaveLength(3);
    expect((msg.content[0] as { type: string }).type).toBe("text");
    expect((msg.content[0] as { text: string }).text).toBe("Hello **world**");
    expect((msg.content[1] as { type: string }).type).toBe("image");
    expect(msg.content[2]).toEqual({ type: "text", text: "After." });
  });

  it("paragraph + emphasis renders with markdown line breaks", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_para",
      sessionId: "s",
      element: React.createElement(
        "message",
        { role: "user" },
        React.createElement("p", null, "Hello ", React.createElement("em", null, "world"), "!"),
      ),
      bridges: stubBridges(),
    });
    const { tree } = await harness.renderTree({
      mountId: "m_para",
      sessionId: "s",
    });
    const msg = getMessage(tree);
    expect((msg.content[0] as { text: string }).text).toBe("Hello *world*!\n\n");
  });
});

describe("semantic HTML — element coverage", () => {
  it("h1 renders with one hash", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_h1",
      sessionId: "s",
      element: React.createElement(
        "message",
        { role: "user" },
        React.createElement("h1", null, "Title"),
      ),
      bridges: stubBridges(),
    });
    const { tree } = await harness.renderTree({ mountId: "m_h1", sessionId: "s" });
    const msg = getMessage(tree);
    expect((msg.content[0] as { text: string }).text).toBe("# Title\n\n");
  });

  it("h3 carries level=3", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_h3",
      sessionId: "s",
      element: React.createElement(
        "message",
        { role: "user" },
        React.createElement("h3", null, "Sub"),
      ),
      bridges: stubBridges(),
    });
    const { tree } = await harness.renderTree({ mountId: "m_h3", sessionId: "s" });
    const msg = getMessage(tree);
    expect((msg.content[0] as { text: string }).text).toBe("### Sub\n\n");
  });

  it("unordered list", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_ul",
      sessionId: "s",
      element: React.createElement(
        "message",
        { role: "user" },
        React.createElement(
          "ul",
          null,
          React.createElement("li", null, "alpha"),
          React.createElement("li", null, "beta"),
        ),
      ),
      bridges: stubBridges(),
    });
    const { tree } = await harness.renderTree({ mountId: "m_ul", sessionId: "s" });
    const msg = getMessage(tree);
    expect((msg.content[0] as { text: string }).text).toBe("- alpha\n- beta\n\n");
  });

  it("ordered list", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_ol",
      sessionId: "s",
      element: React.createElement(
        "message",
        { role: "user" },
        React.createElement(
          "ol",
          null,
          React.createElement("li", null, "first"),
          React.createElement("li", null, "second"),
        ),
      ),
      bridges: stubBridges(),
    });
    const { tree } = await harness.renderTree({ mountId: "m_ol", sessionId: "s" });
    const msg = getMessage(tree);
    expect((msg.content[0] as { text: string }).text).toBe("1. first\n2. second\n\n");
  });

  it("link carries href into the markdown output", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_a",
      sessionId: "s",
      element: React.createElement(
        "message",
        { role: "user" },
        "See ",
        React.createElement("a", { href: "https://x.test" }, "the docs"),
        ".",
      ),
      bridges: stubBridges(),
    });
    const { tree } = await harness.renderTree({ mountId: "m_a", sessionId: "s" });
    const msg = getMessage(tree);
    expect((msg.content[0] as { text: string }).text).toBe("See [the docs](https://x.test).");
  });

  it("img tag becomes inline markdown image", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_img",
      sessionId: "s",
      element: React.createElement(
        "message",
        { role: "user" },
        "Look: ",
        React.createElement("img", { src: "https://x.test/p.png", alt: "pic" }),
      ),
      bridges: stubBridges(),
    });
    const { tree } = await harness.renderTree({ mountId: "m_img", sessionId: "s" });
    const msg = getMessage(tree);
    expect((msg.content[0] as { text: string }).text).toBe("Look: ![pic](https://x.test/p.png)");
  });

  it("blockquote", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_bq",
      sessionId: "s",
      element: React.createElement(
        "message",
        { role: "user" },
        React.createElement("blockquote", null, "a wise saying"),
      ),
      bridges: stubBridges(),
    });
    const { tree } = await harness.renderTree({ mountId: "m_bq", sessionId: "s" });
    const msg = getMessage(tree);
    expect((msg.content[0] as { text: string }).text).toBe("> a wise saying\n\n");
  });
});

describe("semantic HTML — format scope", () => {
  it("xml formatter scope renders semantic tree as XML", async () => {
    const { XML } = await import("../react/components/format-scope.js");
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_xml",
      sessionId: "s",
      element: React.createElement(
        XML,
        null,
        React.createElement(
          "message",
          { role: "user" },
          "Hello ",
          React.createElement("strong", null, "world"),
          "!",
        ),
      ),
      bridges: stubBridges(),
    });
    const { tree } = await harness.renderTree({ mountId: "m_xml", sessionId: "s" });
    const msg = getMessage(tree);
    expect((msg.content[0] as { text: string }).text).toBe("Hello <strong>world</strong>!");
  });

  it("plain-text scope strips semantic markup", async () => {
    const { PlainText } = await import("../react/components/format-scope.js");
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_text",
      sessionId: "s",
      element: React.createElement(
        PlainText,
        null,
        React.createElement(
          "message",
          { role: "user" },
          "Hello ",
          React.createElement("strong", null, "world"),
          "!",
        ),
      ),
      bridges: stubBridges(),
    });
    const { tree } = await harness.renderTree({ mountId: "m_text", sessionId: "s" });
    const msg = getMessage(tree);
    expect((msg.content[0] as { text: string }).text).toBe("Hello world!");
  });
});
