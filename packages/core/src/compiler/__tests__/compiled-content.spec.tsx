/**
 * Compiled Content Tests
 *
 * Tests for verifying the compiled structure that goes to the model.
 * @jsxImportSource react
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { FiberCompiler } from "../fiber-compiler";
import { markdownRenderer } from "../../renderers";
import type { CompiledStructure, CompiledSection } from "../types";
import { createMockCom, createMockTickState } from "../../testing";

// Use React.createElement to avoid JSX pragma issues
const h = React.createElement;

// Helper to get section by id
function getSection(compiled: CompiledStructure, id: string): CompiledSection | undefined {
  return compiled.sections.get(id);
}

// Helper to render section content as string
function renderSectionContent(section: CompiledSection): string {
  const renderer = section.renderer ?? markdownRenderer;
  const formatted = renderer.format(section.content);
  return formatted
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}

// Content component wrappers that don't pass children to React
// These create leaf nodes with content in props (using `text` to avoid React reconciling children)
const Text = (text: string) => h("Text", { text });
const Code = (code: string, language?: string) => h("Code", { code, language });
const Img = (src: string, alt?: string) => h("Image", { src, alt });
const JsonBlock = (data: unknown) => h("Json", { data });

describe("Compiled Content", () => {
  let com: ReturnType<typeof createMockCom>;
  let compiler: FiberCompiler;
  let tickState: any;

  beforeEach(() => {
    com = createMockCom();
    compiler = new FiberCompiler(com);
    tickState = createMockTickState();
  });

  // ============================================================
  // Section Collection
  // ============================================================

  describe("section collection", () => {
    it("should collect a single section with id", async () => {
      const App = () => h("Section", { id: "main" }, Text("Hello World"));

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.sections.size).toBe(1);
      const section = getSection(compiled, "main");
      expect(section).toBeDefined();
      expect(section!.id).toBe("main");
    });

    it("should collect section title", async () => {
      const App = () => h("Section", { id: "intro", title: "Introduction" }, Text("Content here"));

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "intro");

      expect(section!.title).toBe("Introduction");
    });

    it("should collect section visibility", async () => {
      const App = () =>
        h(
          React.Fragment,
          null,
          h("Section", { id: "visible", visibility: "model" }, Text("For model")),
          h("Section", { id: "logged", visibility: "log" }, Text("For logs")),
        );

      const compiled = await compiler.compile(h(App), tickState);

      expect(getSection(compiled, "visible")!.visibility).toBe("model");
      expect(getSection(compiled, "logged")!.visibility).toBe("log");
    });

    it("should collect section audience", async () => {
      const App = () =>
        h(
          React.Fragment,
          null,
          h("Section", { id: "for-model", audience: "model" }, Text("System instructions")),
          h("Section", { id: "for-user", audience: "user" }, Text("User-facing content")),
          h("Section", { id: "for-all", audience: "all" }, Text("Universal content")),
        );

      const compiled = await compiler.compile(h(App), tickState);

      expect(getSection(compiled, "for-model")!.audience).toBe("model");
      expect(getSection(compiled, "for-user")!.audience).toBe("user");
      expect(getSection(compiled, "for-all")!.audience).toBe("all");
    });

    it("should collect section tags", async () => {
      const App = () =>
        h("Section", { id: "tagged", tags: ["important", "system"] }, Text("Tagged content"));

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "tagged");

      expect(section!.tags).toEqual(["important", "system"]);
    });

    it("should collect section metadata", async () => {
      const App = () =>
        h(
          "Section",
          { id: "meta", metadata: { priority: 1, source: "user" } },
          Text("With metadata"),
        );

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "meta");

      expect(section!.metadata).toEqual({ priority: 1, source: "user" });
    });

    it("should merge sections with same id", async () => {
      const App = () =>
        h(
          React.Fragment,
          null,
          h("Section", { id: "merged" }, Text("First part")),
          h("Section", { id: "merged" }, Text("Second part")),
        );

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.sections.size).toBe(1);
      const section = getSection(compiled, "merged");
      expect(section!.content.length).toBe(2);
    });

    it("should collect multiple distinct sections", async () => {
      const App = () =>
        h(
          React.Fragment,
          null,
          h("Section", { id: "header" }, Text("Header")),
          h("Section", { id: "body" }, Text("Body")),
          h("Section", { id: "footer" }, Text("Footer")),
        );

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.sections.size).toBe(3);
      expect(getSection(compiled, "header")).toBeDefined();
      expect(getSection(compiled, "body")).toBeDefined();
      expect(getSection(compiled, "footer")).toBeDefined();
    });
  });

  // ============================================================
  // Content Blocks
  // ============================================================

  describe("content blocks", () => {
    it("should collect Text content", async () => {
      const App = () => h("Section", { id: "text-test" }, Text("Hello World"));

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "text-test");

      expect(section!.content.length).toBe(1);
      expect(section!.content[0].type).toBe("text");
      expect(section!.content[0].text).toBe("Hello World");
    });

    it("should collect Code content", async () => {
      const App = () => h("Section", { id: "code-test" }, Code("const x = 42;", "typescript"));

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "code-test");

      expect(section!.content.length).toBe(1);
      expect(section!.content[0].type).toBe("code");
      expect((section!.content[0] as any).text).toBe("const x = 42;");
      expect((section!.content[0] as any).language).toBe("typescript");
    });

    it("should collect Image content", async () => {
      const App = () =>
        h("Section", { id: "image-test" }, Img("https://example.com/img.png", "Example"));

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "image-test");

      expect(section!.content.length).toBe(1);
      expect(section!.content[0].type).toBe("image");
      expect((section!.content[0] as any).source).toEqual({
        type: "url",
        url: "https://example.com/img.png",
      });
      expect((section!.content[0] as any).altText).toBe("Example");
    });

    it("should collect Json content", async () => {
      const data = { name: "Test", value: 123 };
      const App = () => h("Section", { id: "json-test" }, JsonBlock(data));

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "json-test");

      expect(section!.content.length).toBe(1);
      expect(section!.content[0].type).toBe("json");
      expect((section!.content[0] as any).data).toEqual(data);
    });

    it("should collect multiple content blocks in order", async () => {
      const App = () =>
        h(
          "Section",
          { id: "multi-content" },
          Text("Introduction"),
          Code('console.log("hi")', "js"),
          Text("Conclusion"),
        );

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "multi-content");

      expect(section!.content.length).toBe(3);
      expect(section!.content[0].type).toBe("text");
      expect(section!.content[1].type).toBe("code");
      expect(section!.content[2].type).toBe("text");
    });
  });

  // ============================================================
  // Content Rendering
  // ============================================================

  describe("content rendering", () => {
    it("should render text as plain text", async () => {
      const App = () => h("Section", { id: "render-text" }, Text("Simple text content"));

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "render-text");
      const rendered = renderSectionContent(section!);

      expect(rendered).toBe("Simple text content");
    });

    it("should pass through code blocks as native content", async () => {
      // Native code blocks (from <Code> component) pass through unchanged
      // Markdown conversion happens at the adapter level, not in the renderer
      const App = () => h("Section", { id: "render-code" }, Code('print("hello")', "python"));

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "render-code");
      const renderer = section!.renderer ?? markdownRenderer;
      const formatted = renderer.format(section!.content);

      expect(formatted.length).toBe(1);
      expect(formatted[0].type).toBe("code");
      expect((formatted[0] as any).text).toBe('print("hello")');
      expect((formatted[0] as any).language).toBe("python");
    });

    it("should pass through image blocks as native content", async () => {
      // Native image blocks (from <Image> component) pass through unchanged
      const App = () =>
        h("Section", { id: "render-image" }, Img("https://example.com/pic.jpg", "A picture"));

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "render-image");
      const renderer = section!.renderer ?? markdownRenderer;
      const formatted = renderer.format(section!.content);

      expect(formatted.length).toBe(1);
      expect(formatted[0].type).toBe("image");
      expect((formatted[0] as any).source).toEqual({
        type: "url",
        url: "https://example.com/pic.jpg",
      });
    });

    it("should pass through json blocks as native content", async () => {
      // Native json blocks (from <Json> component) pass through unchanged
      const App = () => h("Section", { id: "render-json" }, JsonBlock({ key: "value" }));

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "render-json");
      const renderer = section!.renderer ?? markdownRenderer;
      const formatted = renderer.format(section!.content);

      expect(formatted.length).toBe(1);
      expect(formatted[0].type).toBe("json");
      expect((formatted[0] as any).data).toEqual({ key: "value" });
    });

    it("should join multiple blocks with double newlines", async () => {
      const App = () => h("Section", { id: "render-multi" }, Text("First"), Text("Second"));

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "render-multi");
      const rendered = renderSectionContent(section!);

      expect(rendered).toBe("First\n\nSecond");
    });
  });

  // ============================================================
  // Timeline Entries
  // ============================================================

  describe("timeline entries", () => {
    it("should collect Entry with role", async () => {
      const App = () => h("Entry", { role: "user" }, Text("User message"));

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.timelineEntries.length).toBe(1);
      expect(compiled.timelineEntries[0].role).toBe("user");
    });

    it("should collect Entry with id", async () => {
      const App = () => h("Entry", { id: "msg-1", role: "assistant" }, Text("Response"));

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.timelineEntries[0].id).toBe("msg-1");
    });

    it("should collect multiple entries in order", async () => {
      const App = () =>
        h(
          React.Fragment,
          null,
          h("Entry", { role: "user" }, Text("Hello")),
          h("Entry", { role: "assistant" }, Text("Hi there")),
          h("Entry", { role: "user" }, Text("How are you?")),
        );

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.timelineEntries.length).toBe(3);
      expect(compiled.timelineEntries[0].role).toBe("user");
      expect(compiled.timelineEntries[1].role).toBe("assistant");
      expect(compiled.timelineEntries[2].role).toBe("user");
    });

    it("should collect Entry with system role", async () => {
      const App = () => h("Entry", { role: "system" }, Text("You are a helpful assistant."));

      const compiled = await compiler.compile(h(App), tickState);

      // System entries are routed to `compiled.system` (rebuilt each tick), not timelineEntries
      expect(compiled.system.length).toBe(1);
      expect(compiled.system[0].role).toBe("system");
    });

    it("should collect Entry with tool role", async () => {
      const App = () => h("Entry", { role: "tool" }, JsonBlock({ result: "success" }));

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.timelineEntries[0].role).toBe("tool");
    });
  });

  // ============================================================
  // Tools
  // ============================================================

  describe("tools", () => {
    it("should collect Tool with name and handler", async () => {
      const handler = vi.fn();
      const App = () => h("Tool", { name: "get_weather", handler });

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.tools.length).toBe(1);
      expect(compiled.tools[0].name).toBe("get_weather");
      expect(compiled.tools[0].handler).toBe(handler);
    });

    it("should collect Tool with description", async () => {
      const App = () =>
        h("Tool", {
          name: "search",
          description: "Search the web for information",
          handler: () => {},
        });

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.tools[0].description).toBe("Search the web for information");
    });

    it("should collect Tool with schema", async () => {
      const schema = {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      };

      const App = () => h("Tool", { name: "search", schema, handler: () => {} });

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.tools[0].schema).toEqual(schema);
    });

    it("should collect multiple tools", async () => {
      const App = () =>
        h(
          React.Fragment,
          null,
          h("Tool", { name: "tool_a", handler: () => "a" }),
          h("Tool", { name: "tool_b", handler: () => "b" }),
          h("Tool", { name: "tool_c", handler: () => "c" }),
        );

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.tools.length).toBe(3);
      expect(compiled.tools.map((t) => t.name)).toEqual(["tool_a", "tool_b", "tool_c"]);
    });
  });

  // ============================================================
  // Ephemeral Content
  // ============================================================

  describe("ephemeral content", () => {
    it("should collect Ephemeral content", async () => {
      const App = () => h("Ephemeral", null, Text("Temporary content"));

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.ephemeral.length).toBe(1);
      expect(compiled.ephemeral[0].content.length).toBe(1);
    });

    it("should collect Ephemeral with position", async () => {
      const App = () =>
        h(
          React.Fragment,
          null,
          h("Ephemeral", { position: "before" }, Text("Before main")),
          h("Ephemeral", { position: "after" }, Text("After main")),
        );

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.ephemeral[0].position).toBe("before");
      expect(compiled.ephemeral[1].position).toBe("after");
    });

    it("should collect Ephemeral with order", async () => {
      const App = () =>
        h(
          React.Fragment,
          null,
          h("Ephemeral", { order: 2 }, Text("Second")),
          h("Ephemeral", { order: 1 }, Text("First")),
        );

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.ephemeral[0].order).toBe(2);
      expect(compiled.ephemeral[1].order).toBe(1);
    });
  });

  // ============================================================
  // Nested Components
  // ============================================================

  describe("nested components", () => {
    it("should collect content from nested custom components", async () => {
      const Header = () => h("Section", { id: "header" }, Text("Welcome"));
      const Body = () => h("Section", { id: "body" }, Text("Main content"));

      const App = () => h(React.Fragment, null, h(Header), h(Body));

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.sections.size).toBe(2);
      expect(getSection(compiled, "header")).toBeDefined();
      expect(getSection(compiled, "body")).toBeDefined();
    });

    it("should collect deeply nested content", async () => {
      const DeepText = () => Text("Deep inside");
      const Level2 = () => h(DeepText);
      const Level1 = () => h(Level2);
      const App = () => h("Section", { id: "deep" }, h(Level1));

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "deep");

      expect(section!.content.length).toBe(1);
      expect(section!.content[0].text).toBe("Deep inside");
    });

    it("should handle conditional content", async () => {
      const showExtra = true;
      const App = () =>
        h(
          "Section",
          { id: "conditional" },
          Text("Always shown"),
          showExtra ? Text("Conditionally shown") : null,
        );

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "conditional");

      expect(section!.content.length).toBe(2);
    });

    it("should handle array mapped content", async () => {
      const items = ["Apple", "Banana", "Cherry"];
      const App = () =>
        h("Section", { id: "list" }, ...items.map((item, i) => h("Text", { key: i, text: item })));

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "list");

      expect(section!.content.length).toBe(3);
      expect(section!.content.map((c) => c.text)).toEqual(items);
    });
  });

  // ============================================================
  // Complete Prompt Assembly
  // ============================================================

  describe("complete prompt assembly", () => {
    it("should compile a realistic agent structure", async () => {
      const toolHandler = vi.fn();

      const App = () =>
        h(
          React.Fragment,
          null,
          // System prompt
          h("Section", { id: "system" }, Text("You are a helpful assistant.")),
          // Tools
          h("Tool", {
            name: "calculate",
            description: "Perform calculations",
            schema: { type: "object", properties: { expression: { type: "string" } } },
            handler: toolHandler,
          }),
          // Conversation history
          h("Entry", { role: "user" }, Text("What is 2 + 2?")),
          h("Entry", { role: "assistant" }, Text("Let me calculate that for you.")),
          // Current context
          h("Section", { id: "context" }, Text("Current time: 2024-01-15")),
        );

      const compiled = await compiler.compile(h(App), tickState);

      // Verify structure
      expect(compiled.sections.size).toBe(2);
      expect(compiled.tools.length).toBe(1);
      expect(compiled.timelineEntries.length).toBe(2);

      // Verify section content
      const systemSection = getSection(compiled, "system");
      expect(renderSectionContent(systemSection!)).toBe("You are a helpful assistant.");

      // Verify tool
      expect(compiled.tools[0].name).toBe("calculate");
      expect(compiled.tools[0].handler).toBe(toolHandler);

      // Verify conversation
      expect(compiled.timelineEntries[0].role).toBe("user");
      expect(compiled.timelineEntries[1].role).toBe("assistant");
    });

    it("should preserve iteration order for model input", async () => {
      const App = () =>
        h(
          "Section",
          { id: "instructions" },
          Text("Follow these rules:"),
          Text("1. Be helpful"),
          Text("2. Be concise"),
        );

      const compiled = await compiler.compile(h(App), tickState);
      const section = getSection(compiled, "instructions");
      const rendered = renderSectionContent(section!);

      // Verify order is preserved
      const lines = rendered.split("\n\n");
      expect(lines[0]).toBe("Follow these rules:");
      expect(lines[1]).toBe("1. Be helpful");
      expect(lines[2]).toBe("2. Be concise");
    });
  });
});
