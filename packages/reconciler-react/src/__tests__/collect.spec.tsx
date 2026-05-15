import { describe, expect, it } from "vitest";
import React from "react";
import { createContainer } from "../host/container.js";
import { createHostScope } from "../host/host-context.js";
import { createReconciler } from "../react/reconciler.js";
import { collect } from "../collect/collect.js";
import { createBuiltInRegistry } from "../collect/contributors/built-ins.js";
import { flush } from "../testing/flush.js";

function renderAndCollect(element: React.ReactNode) {
  const container = createContainer({
    mountId: "test",
    rootScope: createHostScope({ formatter: { id: "markdown", format: "markdown" } }),
  });
  const reconciler = createReconciler({ container, idPrefix: "t" });
  const root = reconciler.createRoot();
  reconciler.render(element, root);
  const registry = createBuiltInRegistry();
  return collect({ roots: container.children, registry, rootScope: container.rootScope });
}

describe("collect — minimum RenderedTree", () => {
  it("empty tree produces just specVersion + empty context", () => {
    const { tree } = renderAndCollect(React.createElement(React.Fragment));
    expect(tree.specVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(tree.context.entries).toEqual([]);
  });
});

describe("collect — structural primitives", () => {
  it("collects sections with stable ids from props", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        "section",
        { id: "s.todos", title: "Todos" },
        "1. ship reconciler",
      ),
    );
    expect(tree.context.entries).toHaveLength(1);
    const entry = tree.context.entries[0]!;
    if (entry.kind !== "section") throw new Error("expected section");
    expect(entry.id).toBe("s.todos");
    expect(entry.title).toBe("Todos");
    expect(entry.content).toEqual([{ type: "text", text: "1. ship reconciler" }]);
    expect(entry.renderedWith?.id).toBe("markdown");
    expect(tree.features).toContain("sections");
  });

  it("collects messages with role and content", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        React.Fragment,
        null,
        React.createElement("message", { role: "system" }, "You are helpful."),
        React.createElement("message", { role: "user" }, "Hi."),
      ),
    );
    expect(tree.context.entries).toHaveLength(2);
    const [sys, user] = tree.context.entries;
    if (sys?.kind !== "message" || user?.kind !== "message") {
      throw new Error("expected messages");
    }
    expect(sys.role).toBe("system");
    expect(sys.content).toEqual([{ type: "text", text: "You are helpful." }]);
    expect(user.role).toBe("user");
  });

  it("missing message role emits a warning diagnostic and skips", () => {
    const { tree, diagnostics } = renderAndCollect(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "message",
          // intentionally missing role
          { id: "m1" } as React.ComponentProps<"message">,
          "no role",
        ),
        React.createElement("message", { role: "user" }, "hi"),
      ),
    );
    expect(diagnostics.some((d) => d.code === "MISSING_ROLE")).toBe(true);
    // The valid message still lands in the tree.
    const messages = tree.context.entries.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(1);
  });

  it("falls back to stable hostId when section id prop is absent", () => {
    const { tree } = renderAndCollect(
      React.createElement("section", null, "anonymous section"),
    );
    expect(tree.context.entries).toHaveLength(1);
    const entry = tree.context.entries[0]!;
    if (entry.kind !== "section") throw new Error("expected section");
    expect(entry.id).toMatch(/^section\.t#/);
  });
});

describe("collect — declarations", () => {
  it("collects tool declarations and feature flag", () => {
    const { tree } = renderAndCollect(
      React.createElement("tool", {
        id: "t.add",
        name: "add",
        description: "Add two numbers",
        inputSchema: { type: "object" },
        exposure: ["model", "dispatch"],
        handlerRef: "handlers/add",
      }),
    );
    expect(tree.declarations?.tools).toHaveLength(1);
    const tool = tree.declarations!.tools![0]!;
    expect(tool.name).toBe("add");
    expect(tool.exposure).toEqual(["model", "dispatch"]);
    expect(tool.handlerRef).toBe("handlers/add");
    expect(tree.features).toContain("tool-declarations");
  });

  it("missing tool name emits diagnostic", () => {
    const { diagnostics } = renderAndCollect(
      // @ts-expect-error — intentionally invalid
      React.createElement("tool", { inputSchema: { type: "object" } }),
    );
    expect(diagnostics.some((d) => d.code === "MISSING_NAME")).toBe(true);
  });

  it("collects resource and output declarations", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        React.Fragment,
        null,
        React.createElement("resource", {
          id: "res.cv",
          uri: "file://cv.pdf",
          mimeType: "application/pdf",
        }),
        React.createElement("output", { id: "out.summary", mode: "json" }),
      ),
    );
    expect(tree.declarations?.resources).toHaveLength(1);
    expect(tree.declarations?.outputs).toHaveLength(1);
    expect(tree.features).toContain("outputs");
  });

  it("collects MCP declarations", () => {
    const { tree } = renderAndCollect(
      React.createElement("mcp", {
        id: "mcp.local",
        serverName: "tools",
        transport: "stdio",
        config: { command: "node", args: ["server.js"] },
        exposes: ["tools"],
      }),
    );
    expect(tree.declarations?.mcp).toHaveLength(1);
    expect(tree.features).toContain("mcp-declarations");
  });
});

describe("collect — model + provider options", () => {
  it("captures model selection and provider options", () => {
    const { tree } = renderAndCollect(
      React.createElement("model", {
        id: "gpt-4o",
        temperature: 0.7,
        maxOutputTokens: 1024,
        providerOptions: { openai: { user: "abc" } },
      }),
    );
    expect(tree.config?.model).toEqual({ kind: "by-id", id: "gpt-4o" });
    expect(tree.config?.temperature).toBe(0.7);
    expect(tree.providerOptions?.openai).toEqual({ user: "abc" });
    expect(tree.features).toContain("provider-options");
  });
});

describe("collect — composition", () => {
  it("function components are transparent", () => {
    function System({ children }: { children: React.ReactNode }) {
      return React.createElement("message", { role: "system" }, children);
    }
    const { tree } = renderAndCollect(
      React.createElement(System, null, "You are helpful."),
    );
    expect(tree.context.entries).toHaveLength(1);
    const entry = tree.context.entries[0]!;
    if (entry.kind !== "message") throw new Error("expected message");
    expect(entry.role).toBe("system");
  });

  it("Fragment passes through to its children", () => {
    const { tree } = renderAndCollect(
      React.createElement(
        React.Fragment,
        null,
        React.createElement("section", { id: "a" }, "A"),
        React.createElement("section", { id: "b" }, "B"),
      ),
    );
    expect(tree.context.entries).toHaveLength(2);
  });

  it("re-renders preserve declarative order", async () => {
    const container = createContainer({
      mountId: "m_order",
      rootScope: createHostScope({ formatter: { id: "markdown" } }),
    });
    const reconciler = createReconciler({ container, idPrefix: "m_order" });
    const root = reconciler.createRoot();

    function App({ count }: { count: number }) {
      return React.createElement(
        React.Fragment,
        null,
        ...Array.from({ length: count }, (_, i) =>
          React.createElement("section", { key: `s${i}`, id: `s${i}` }, `body-${i}`),
        ),
      );
    }
    reconciler.render(React.createElement(App, { count: 3 }), root);
    await flush();
    const registry = createBuiltInRegistry();
    const first = collect({ roots: container.children, registry, rootScope: container.rootScope });
    expect(first.tree.context.entries.map((e) => (e.kind === "section" ? e.id : ""))).toEqual([
      "s0",
      "s1",
      "s2",
    ]);

    reconciler.render(React.createElement(App, { count: 1 }), root);
    await flush();
    const second = collect({ roots: container.children, registry, rootScope: container.rootScope });
    expect(second.tree.context.entries.map((e) => (e.kind === "section" ? e.id : ""))).toEqual([
      "s0",
    ]);
  });
});

describe("collect — free-root content", () => {
  it("text at the top of the tree becomes free-root content", () => {
    const { tree } = renderAndCollect(
      React.createElement(React.Fragment, null, "loose text at the root"),
    );
    expect(tree.content).toEqual([{ type: "text", text: "loose text at the root" }]);
    expect(tree.features).toContain("free-root-content");
  });
});
