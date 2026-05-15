import { describe, expect, it } from "vitest";
import React from "react";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ReconcilerHarness } from "../harness/reconciler-harness.js";
import { stubBridges } from "../bridges/stub-bridges.js";
import { Markdown, XML } from "../react/components/format-scope.js";

async function makeHarness(scope = `rts-${Math.random()}`) {
  const harness = new ReconcilerHarness(
    scope,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

describe("renderToString — basic markdown serialization", () => {
  it("serializes a single section to ## title + body", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m1",
      sessionId: "s",
      element: React.createElement(
        "section",
        { id: "s.intro", title: "Intro" },
        "Welcome.",
      ),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload, diagnostics } = await harness.renderToString({
      mountId: "m1",
      query: "",
    });
    expect(diagnostics).toEqual([]);
    expect(payload.mimeType).toBe("text/markdown");
    expect(payload.text).toContain("## Intro");
    expect(payload.text).toContain("Welcome.");
  });

  it("serializes a message with role prefix", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m2",
      sessionId: "s",
      element: React.createElement("message", { role: "user" }, "Hello"),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload } = await harness.renderToString({ mountId: "m2", query: "" });
    expect(payload.text).toContain("**user:** Hello");
  });

  it("concatenates multiple entries with blank-line separator", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m3",
      sessionId: "s",
      element: React.createElement(
        React.Fragment,
        null,
        React.createElement("message", { role: "system" }, "You help."),
        React.createElement("section", { id: "s", title: "Tools" }, "echo"),
      ),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload } = await harness.renderToString({ mountId: "m3", query: "" });
    expect(payload.text).toContain("**system:** You help.");
    expect(payload.text).toContain("## Tools");
    expect(payload.text).toContain("echo");
  });
});

describe("renderToString — XML format", () => {
  it("uses xml tags when the in-scope formatter is xml", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_xml",
      sessionId: "s",
      element: React.createElement(
        XML,
        null,
        React.createElement("section", { id: "s", title: "T" }, "body"),
      ),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload } = await harness.renderToString({ mountId: "m_xml", query: "" });
    expect(payload.text).toContain('<section id="s" title="T">');
    expect(payload.text).toContain("</section>");
  });

  it("escapes xml special chars", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_xml_esc",
      sessionId: "s",
      element: React.createElement(
        XML,
        null,
        React.createElement(
          "section",
          { id: "s.<>&", title: 'A&B"' },
          "body",
        ),
      ),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload } = await harness.renderToString({
      mountId: "m_xml_esc",
      query: "",
    });
    expect(payload.text).toContain('id="s.&lt;&gt;&amp;"');
    expect(payload.text).toContain('title="A&amp;B&quot;"');
  });

  it("explicit formatter override per call", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_override",
      sessionId: "s",
      element: React.createElement("section", { id: "s" }, "body"),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload } = await harness.renderToString({
      mountId: "m_override",
      query: "",
      formatter: { id: "xml", format: "xml" },
    });
    expect(payload.text).toContain('<section id="s">');
    expect(payload.mimeType).toBe("application/xml");
  });
});

describe("renderToString — content-block serialization", () => {
  it("code blocks render as fenced code in markdown", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_code",
      sessionId: "s",
      element: React.createElement(
        "section",
        { id: "s" },
        React.createElement("code", { language: "typescript" }, "const x = 1;"),
      ),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload } = await harness.renderToString({ mountId: "m_code", query: "" });
    expect(payload.text).toContain("```typescript");
    expect(payload.text).toContain("const x = 1;");
    expect(payload.text).toContain("```");
  });

  it("images render as ![alt](src) in markdown", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_img",
      sessionId: "s",
      element: React.createElement(
        "section",
        { id: "s" },
        React.createElement("image", {
          source: { type: "url", url: "https://x.test/a.png" },
          altText: "alt text",
        }),
      ),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload } = await harness.renderToString({ mountId: "m_img", query: "" });
    expect(payload.text).toContain("![alt text](https://x.test/a.png)");
  });

  it("json renders as fenced json", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_json",
      sessionId: "s",
      element: React.createElement(
        "section",
        { id: "s" },
        React.createElement("json", { data: { ok: true } }),
      ),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload } = await harness.renderToString({ mountId: "m_json", query: "" });
    expect(payload.text).toContain("```json");
    expect(payload.text).toContain('{"ok":true}');
  });
});

describe("renderToString — query filtering", () => {
  function buildTree() {
    return React.createElement(
      React.Fragment,
      null,
      React.createElement("section", { id: "intro", title: "Intro" }, "Welcome."),
      React.createElement("section", { id: "rules", title: "Rules" }, "Be kind."),
      React.createElement("message", { role: "user", id: "m1" }, "Hello"),
    );
  }

  it('empty query → renders the whole tree', async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "q_all",
      sessionId: "s",
      element: buildTree(),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload } = await harness.renderToString({ mountId: "q_all", query: "" });
    expect(payload.text).toContain("Intro");
    expect(payload.text).toContain("Rules");
    expect(payload.text).toContain("**user:** Hello");
  });

  it('"id:X" filters to a single entry', async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "q_id",
      sessionId: "s",
      element: buildTree(),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload } = await harness.renderToString({
      mountId: "q_id",
      query: "id:rules",
    });
    expect(payload.text).toContain("Rules");
    expect(payload.text).toContain("Be kind.");
    expect(payload.text).not.toContain("Intro");
    expect(payload.text).not.toContain("Welcome.");
    expect(payload.text).not.toContain("**user:**");
  });

  it('"section:X" narrows by entry kind', async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "q_section",
      sessionId: "s",
      element: buildTree(),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload } = await harness.renderToString({
      mountId: "q_section",
      query: "section:intro",
    });
    expect(payload.text).toContain("Welcome.");
    expect(payload.text).not.toContain("Hello");
  });

  it('"message:X" narrows by entry kind', async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "q_message",
      sessionId: "s",
      element: buildTree(),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload } = await harness.renderToString({
      mountId: "q_message",
      query: "message:m1",
    });
    expect(payload.text).toContain("**user:** Hello");
    expect(payload.text).not.toContain("Intro");
  });

  it("unknown query yields empty output (no matching entries)", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "q_unknown",
      sessionId: "s",
      element: buildTree(),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const { payload } = await harness.renderToString({
      mountId: "q_unknown",
      query: "weird-app-query",
    });
    expect(payload.text).toBe("");
  });
});

describe("renderToString — operation lifecycle", () => {
  it("emits requested + terminal events into the journal", async () => {
    const journal = new MemoryJournal();
    const harness = new ReconcilerHarness("rts-lc", journal, new LocalEventBus(), new LocalInbox());
    await harness.ready;
    await harness.mount({
      mountId: "m_lc",
      sessionId: "s",
      element: React.createElement("section", { id: "s" }, "x"),
      bridges: stubBridges(),
    });
    await harness.renderToString({ mountId: "m_lc", query: "" });
    const names = new Set<string>();
    for await (const ev of journal.read({}, "beginning")) names.add(`${ev.name}.${ev.phase}`);
    expect(names.has("reconciler:command:render-to-string.requested")).toBe(true);
    expect(names.has("reconciler:command:render-to-string.terminal")).toBe(true);
  });

  it("rejects with NotMounted for an unknown mountId", async () => {
    const harness = await makeHarness();
    await expect(
      harness.renderToString({ mountId: "ghost", query: "" }),
    ).rejects.toMatchObject({ _tag: "NotMounted" });
  });
});

describe("renderToString — JSON firewall", () => {
  it("the payload is JSON-serializable", async () => {
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_json_safe",
      sessionId: "s",
      element: React.createElement(
        "section",
        { id: "s", title: "T" },
        React.createElement("code", { language: "typescript" }, "x"),
      ),
      bridges: stubBridges(),
      defaultFormatter: { id: "markdown", format: "markdown" },
    });
    const result = await harness.renderToString({ mountId: "m_json_safe", query: "" });
    const round = JSON.parse(JSON.stringify(result));
    expect(round).toEqual(result);
  });
});
