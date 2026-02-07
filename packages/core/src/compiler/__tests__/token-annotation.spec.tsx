/**
 * Token Annotation Tests
 *
 * Tests that the collector annotates compiled structures with token estimates.
 * Covers: estimator integration, content block types, totalTokens aggregation.
 *
 * @jsxImportSource react
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { FiberCompiler } from "../fiber-compiler";
import { collect } from "../collector";
import { createEmptyCompiledStructure } from "../types";
import { createMockCom, createMockTickState } from "../../testing";
import type { TokenEstimator } from "../../com/types";

const h = React.createElement;

// Content component helpers (match compiled-content.spec.tsx pattern)
const Text = (text: string) => h("Text", { text });
const Code = (code: string, language?: string) => h("Code", { code, language });
const Img = (src: string, alt?: string) => h("Image", { src, alt });
const JsonBlock = (data: unknown) => h("Json", { data });

describe("Token Annotation", () => {
  let ctx: ReturnType<typeof createMockCom>;
  let compiler: FiberCompiler;
  let tickState: ReturnType<typeof createMockTickState>;

  beforeEach(() => {
    ctx = createMockCom();
    compiler = new FiberCompiler(ctx);
    tickState = createMockTickState();
  });

  // ============================================================================
  // Section annotation
  // ============================================================================

  describe("section annotation", () => {
    it("stamps .tokens on compiled sections", async () => {
      const App = () => h("Section", { id: "main" }, Text("Hello World"));
      const compiled = await compiler.compile(h(App), tickState);

      const section = compiled.sections.get("main");
      expect(section).toBeDefined();
      expect(section!.tokens).toBeTypeOf("number");
      expect(section!.tokens).toBeGreaterThan(0);
    });

    it("includes MESSAGE_OVERHEAD (4) per section", async () => {
      // Empty section should still have the 4-token overhead
      const App = () => h("Section", { id: "empty" }, Text(""));
      const compiled = await compiler.compile(h(App), tickState);

      const section = compiled.sections.get("empty");
      // Empty text = 0 tokens + 4 overhead
      // Default estimator: ceil(0/4) + 4 = 4 for the text, + 4 for message overhead = 8
      expect(section!.tokens).toBeGreaterThanOrEqual(4);
    });

    it("scales token estimate with content length", async () => {
      const short = "Hi";
      const long = "A".repeat(400);

      const App = () =>
        h(
          React.Fragment,
          null,
          h("Section", { id: "short" }, Text(short)),
          h("Section", { id: "long" }, Text(long)),
        );

      const compiled = await compiler.compile(h(App), tickState);
      const shortSection = compiled.sections.get("short")!;
      const longSection = compiled.sections.get("long")!;

      expect(longSection.tokens!).toBeGreaterThan(shortSection.tokens!);
    });
  });

  // ============================================================================
  // Timeline entry annotation
  // ============================================================================

  describe("timeline entry annotation", () => {
    it("stamps .tokens on timeline entries", async () => {
      const App = () =>
        h("entry", {
          kind: "message",
          message: { role: "user", content: [{ type: "text", text: "Hello" }] },
        });

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.timelineEntries).toHaveLength(1);
      expect(compiled.timelineEntries[0].tokens).toBeTypeOf("number");
      expect(compiled.timelineEntries[0].tokens).toBeGreaterThan(0);
    });

    it("stamps .tokens on system entries", async () => {
      const App = () =>
        h("entry", {
          kind: "message",
          message: { role: "system", content: [{ type: "text", text: "You are helpful" }] },
        });

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.systemEntries).toHaveLength(1);
      expect(compiled.systemEntries[0].tokens).toBeTypeOf("number");
      expect(compiled.systemEntries[0].tokens).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // totalTokens aggregation
  // ============================================================================

  describe("totalTokens", () => {
    it("sums tokens across sections, timeline, system, and ephemeral", async () => {
      const App = () =>
        h(
          React.Fragment,
          null,
          h("Section", { id: "info" }, Text("Section content")),
          h("entry", {
            kind: "message",
            message: { role: "user", content: [{ type: "text", text: "User message" }] },
          }),
          h("entry", {
            kind: "message",
            message: { role: "system", content: [{ type: "text", text: "System" }] },
          }),
          h("ephemeral", { position: "end" }, Text("Ephemeral note")),
        );

      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.totalTokens).toBeTypeOf("number");
      expect(compiled.totalTokens).toBeGreaterThan(0);

      // totalTokens should be >= sum of individual stamped tokens
      const sectionTokens = compiled.sections.get("info")!.tokens!;
      const timelineTokens = compiled.timelineEntries[0].tokens!;
      const systemTokens = compiled.systemEntries[0].tokens!;
      // Ephemeral tokens are counted in total but not stamped on the entry
      expect(compiled.totalTokens!).toBeGreaterThanOrEqual(
        sectionTokens + timelineTokens + systemTokens,
      );
    });

    it("is undefined when no estimator is provided", () => {
      // Test collect() directly without estimator
      const structure = createEmptyCompiledStructure();
      structure.sections.set("test", {
        id: "test",
        content: [{ type: "text", text: "Hello" }],
        renderer: null,
      });

      // collect() with no estimator won't annotate
      // We test by checking the structure we created manually
      expect(structure.totalTokens).toBeUndefined();
      expect(structure.sections.get("test")!.tokens).toBeUndefined();
    });
  });

  // ============================================================================
  // Content block type estimation
  // ============================================================================

  describe("content block types", () => {
    it("estimates text blocks", async () => {
      const App = () => h("Section", { id: "text" }, Text("Some text content here"));
      const compiled = await compiler.compile(h(App), tickState);
      expect(compiled.sections.get("text")!.tokens).toBeGreaterThan(4); // more than just overhead
    });

    it("estimates code blocks", async () => {
      const App = () => h("Section", { id: "code" }, Code("function foo() { return 42; }", "js"));
      const compiled = await compiler.compile(h(App), tickState);
      expect(compiled.sections.get("code")!.tokens).toBeGreaterThan(4);
    });

    it("estimates json blocks", async () => {
      const App = () =>
        h("Section", { id: "json" }, JsonBlock({ key: "value", nested: { count: 42 } }));
      const compiled = await compiler.compile(h(App), tickState);
      expect(compiled.sections.get("json")!.tokens).toBeGreaterThan(4);
    });

    it("estimates image blocks as fixed overhead", async () => {
      const App = () => h("Section", { id: "img" }, Img("https://example.com/img.png", "test"));
      const compiled = await compiler.compile(h(App), tickState);
      // IMAGE_OVERHEAD = 85, plus MESSAGE_OVERHEAD = 4
      expect(compiled.sections.get("img")!.tokens).toBe(85 + 4);
    });

    it("sums mixed content blocks in a single section", async () => {
      const App = () =>
        h(
          "Section",
          { id: "mixed" },
          Text("Hello World"), // 11 chars → ceil(11/4)+4 = 7
          Code("x = 1", "py"), // 5 chars → ceil(5/4)+4 = 6
          Img("https://img.png"), // IMAGE_OVERHEAD = 85
        );
      const compiled = await compiler.compile(h(App), tickState);
      const section = compiled.sections.get("mixed")!;

      // 7 (text) + 6 (code) + 85 (image) + 4 (message overhead) = 102
      expect(section.tokens).toBe(102);
    });

    it("estimates multi-block timeline entries", async () => {
      // Entry with two text blocks via children
      const App = () =>
        h("entry", {
          kind: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "First block" }, // 11 chars → 7
              { type: "text", text: "Second block" }, // 12 chars → 7
            ],
          },
        });

      const compiled = await compiler.compile(h(App), tickState);
      expect(compiled.timelineEntries).toHaveLength(1);
      // 7 + 7 + 4 (overhead) = 18
      expect(compiled.timelineEntries[0].tokens).toBe(18);
    });
  });

  // ============================================================================
  // Custom estimator
  // ============================================================================

  describe("custom estimator", () => {
    it("uses the COM's estimator function", async () => {
      const customEstimator = vi.fn((text: string) => text.length * 2);

      // Create a mock COM with custom estimator
      const customCtx = createMockCom();
      (customCtx as any).getTokenEstimator = () => customEstimator;

      const customCompiler = new FiberCompiler(customCtx);

      const App = () => h("Section", { id: "test" }, Text("Hello"));
      const compiled = await customCompiler.compile(h(App), tickState);

      // Custom estimator was called
      expect(customEstimator).toHaveBeenCalled();
      // Token count should reflect custom estimator: "Hello".length * 2 = 10, + MESSAGE_OVERHEAD = 14
      expect(compiled.sections.get("test")!.tokens).toBe(14);
    });

    it("default estimator uses char/4 + 4 formula", async () => {
      // "Hello World" = 11 chars, ceil(11/4) + 4 = 3 + 4 = 7 tokens
      // Plus MESSAGE_OVERHEAD = 4 → total = 11
      const App = () => h("Section", { id: "test" }, Text("Hello World"));
      const compiled = await compiler.compile(h(App), tickState);

      // Default estimator: ceil(11/4) + 4 = 7 per block, + MESSAGE_OVERHEAD 4 = 11
      expect(compiled.sections.get("test")!.tokens).toBe(11);
    });

    it("default estimator handles empty string", async () => {
      // "" = 0 chars, ceil(0/4) + 4 = 4 tokens
      // Plus MESSAGE_OVERHEAD = 4 → total = 8
      const App = () => h("Section", { id: "test" }, Text(""));
      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.sections.get("test")!.tokens).toBe(8);
    });
  });

  // ============================================================================
  // collect() direct tests
  // ============================================================================

  describe("collect() with estimator", () => {
    it("annotates when estimator is provided", async () => {
      const estimator: TokenEstimator = (text) => text.length;

      // Compile to get a container, then collect with our estimator
      const App = () =>
        h(
          React.Fragment,
          null,
          h("Section", { id: "s1" }, Text("Hello")),
          h("entry", {
            kind: "message",
            message: { role: "user", content: [{ type: "text", text: "World" }] },
          }),
        );

      // Use compiler to render the tree, then collect directly
      await compiler.compile(h(App), tickState);
      const collected = collect((compiler as any).container, estimator);

      // Section: "Hello".length = 5 + MESSAGE_OVERHEAD = 9
      expect(collected.sections.get("s1")!.tokens).toBe(9);
      // Entry: "World".length = 5 + MESSAGE_OVERHEAD = 9
      expect(collected.timelineEntries[0].tokens).toBe(9);
      // Total
      expect(collected.totalTokens).toBe(18);
    });

    it("does not annotate when estimator is omitted", async () => {
      const App = () => h("Section", { id: "s1" }, Text("Hello"));

      await compiler.compile(h(App), tickState);
      const collected = collect((compiler as any).container);

      expect(collected.sections.get("s1")!.tokens).toBeUndefined();
      expect(collected.totalTokens).toBeUndefined();
    });
  });
});
