import { describe, expect, it } from "vitest";
import React from "react";
import { jsonSchema } from "@agentick/spec";
import { markdownFormatter } from "@agentick/formatters";
import { Output } from "../react/components/index.js";
import { createContainer } from "@agentick/compiler";
import { createHostScope } from "@agentick/compiler";
import { createCompiler } from "../react/compiler.js";
import { collect } from "@agentick/compiler";
import { createBuiltInRegistry } from "@agentick/compiler";
import { flush } from "../testing/flush.js";

function renderAndCollect(element: React.ReactNode) {
  const container = createContainer({
    mountId: "test",
    rootScope: createHostScope({ formatter: { id: "markdown", format: "markdown" } }),
  });
  const compiler = createCompiler({ container, idPrefix: "t" });
  const root = compiler.createRoot();
  compiler.render(element, root);
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
  it("collects a free-floating section as a grounding message with a stable id", () => {
    const { tree, diagnostics } = renderAndCollect(
      React.createElement("section", { id: "s.todos", title: "Todos" }, "1. ship compiler"),
    );
    expect(tree.context.entries).toHaveLength(1);
    const entry = tree.context.entries[0]!;
    // ADR 94 — `SectionEntry` is gone. A free-floating `<section>` is an
    // anonymous `grounding` message at its own tree position, and `title` is
    // no longer an entry field. Collect carries the section's STRUCTURE in a
    // `sectionNode` sidecar; the formatter pass turns it into the leading
    // `# ` heading, coalesced with the body into ONE text block that carries
    // the section's stable id + `metadata.section` stamp.
    expect(entry.kind).toBe("message");
    expect(entry.role).toBe("grounding");
    expect(entry.id).toBe("s.todos");
    expect(entry.content).toEqual([
      {
        type: "text",
        text: "",
        sectionNode: {
          id: "s.todos",
          title: "Todos",
          content: [{ type: "text", text: "1. ship compiler" }],
        },
      },
    ]);
    expect(markdownFormatter(entry.content)).toEqual([
      {
        type: "text",
        text: "# Todos\n1. ship compiler",
        id: "s.todos",
        metadata: { section: "s.todos" },
      },
    ]);
    expect(entry.renderedWith?.id).toBe("markdown");
    // `features` still reports "sections" — now computed from grounding entries.
    expect(tree.features).toContain("sections");
    // A bare section ahead of any <System> earns the migration hint (ADR 94).
    expect(diagnostics.map((d) => d.code)).toContain("SECTION_WITHOUT_SYSTEM");
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
      <>
        {/* @ts-expect-error — role is required; missing it triggers MISSING_ROLE diagnostic */}
        <message id="m1">no role</message>
        <message role="user">hi</message>
      </>,
    );
    expect(diagnostics.some((d) => d.code === "MISSING_ROLE")).toBe(true);
    // The valid message still lands in the tree.
    const messages = tree.context.entries.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(1);
  });

  it("falls back to stable hostId when section id prop is absent", () => {
    const { tree } = renderAndCollect(React.createElement("section", null, "anonymous section"));
    expect(tree.context.entries).toHaveLength(1);
    const entry = tree.context.entries[0]!;
    // ADR 94 — the derived id rides the grounding message the section became.
    expect(entry.role).toBe("grounding");
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
      // @ts-expect-error — `name` is required; missing it triggers MISSING_NAME.
      <tool inputSchema={{ type: "object" }} />,
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

  it("the <Output> component forwards §B2 terminal-tool props (name/description/strategy/schema)", () => {
    const schema = jsonSchema({ type: "object", properties: { answer: { type: "string" } } });
    const { tree } = renderAndCollect(
      React.createElement(Output, {
        id: "out.answer",
        name: "deliver_answer",
        description: "call this when done",
        strategy: "tool",
        schema,
      }),
    );
    expect(tree.declarations?.outputs).toHaveLength(1);
    const decl = tree.declarations!.outputs![0]!;
    expect(decl.name).toBe("deliver_answer");
    expect(decl.description).toBe("call this when done");
    expect(decl.strategy).toBe("tool");
    expect(decl.schema).toBe(schema);
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
        // ProviderOptions is an empty seed; the "openai" slot exists
        // only when @agentick/model-openai is imported (module
        // augmentation). This test verifies threading, not the slot
        // type — cast through unknown.
        providerOptions: { openai: { user: "abc" } } as unknown as Record<string, unknown>,
      }),
    );
    expect(tree.config?.model).toEqual({ kind: "by-id", id: "gpt-4o" });
    expect(tree.config?.temperature).toBe(0.7);
    expect((tree.providerOptions as Record<string, unknown> | undefined)?.openai).toEqual({
      user: "abc",
    });
    expect(tree.features).toContain("provider-options");
  });
});

describe("collect — composition", () => {
  it("function components are transparent", () => {
    function System({ children }: { children: React.ReactNode }) {
      return React.createElement("message", { role: "system" }, children);
    }
    const { tree } = renderAndCollect(React.createElement(System, null, "You are helpful."));
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
    const compiler = createCompiler({ container, idPrefix: "m_order" });
    const root = compiler.createRoot();

    function App({ count }: { count: number }) {
      return React.createElement(
        React.Fragment,
        null,
        ...Array.from({ length: count }, (_, i) =>
          React.createElement("section", { key: `s${i}`, id: `s${i}` }, `body-${i}`),
        ),
      );
    }
    compiler.render(React.createElement(App, { count: 3 }), root);
    await flush();
    const registry = createBuiltInRegistry();
    const first = collect({ roots: container.children, registry, rootScope: container.rootScope });
    // ADR 94 — each section is a `grounding` message at its own position, so
    // declarative order is now read off the entry ids directly.
    expect(first.tree.context.entries.map((e) => `${e.role}:${e.id}`)).toEqual([
      "grounding:s0",
      "grounding:s1",
      "grounding:s2",
    ]);

    compiler.render(React.createElement(App, { count: 1 }), root);
    await flush();
    const second = collect({ roots: container.children, registry, rootScope: container.rootScope });
    expect(second.tree.context.entries.map((e) => `${e.role}:${e.id}`)).toEqual(["grounding:s0"]);
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
