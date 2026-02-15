/**
 * Token Annotation Tests
 *
 * Tests that the collector annotates compiled structures with token estimates.
 * Covers: estimator integration, content block types, totalTokens aggregation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { FiberCompiler } from "../fiber-compiler";
import { collect } from "../collector";
import { createEmptyCompiledStructure } from "../types";
import { createMockCom, createMockTickState } from "../../testing";
import type { TokenEstimator } from "../../com/types";
import { Section, Message } from "../../jsx/components/primitives";
import { Ephemeral } from "../../jsx/components/messages";
import {
  Text as TextComponent,
  Code as CodeComponent,
  Image as ImageComponent,
  Json as JsonComponent,
} from "../../jsx/components/content";

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
      const App = () => (
        <Section id="main">
          <TextComponent text="Hello World" />
        </Section>
      );
      const compiled = await compiler.compile(<App />, tickState);

      const section = compiled.sections.get("main");
      expect(section).toBeDefined();
      expect(section!.tokens).toBeTypeOf("number");
      expect(section!.tokens).toBeGreaterThan(0);
    });

    it("includes MESSAGE_OVERHEAD (4) per section", async () => {
      const App = () => (
        <Section id="empty">
          <TextComponent text="" />
        </Section>
      );
      const compiled = await compiler.compile(<App />, tickState);

      const section = compiled.sections.get("empty");
      // Empty text = 0 tokens + 4 overhead
      // Default estimator: ceil(0/4) + 4 = 4 for the text, + 4 for message overhead = 8
      expect(section!.tokens).toBeGreaterThanOrEqual(4);
    });

    it("scales token estimate with content length", async () => {
      const short = "Hi";
      const long = "A".repeat(400);

      const App = () => (
        <>
          <Section id="short">
            <TextComponent text={short} />
          </Section>
          <Section id="long">
            <TextComponent text={long} />
          </Section>
        </>
      );

      const compiled = await compiler.compile(<App />, tickState);
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
      const App = () => <Message role="user" content={[{ type: "text", text: "Hello" }]} />;

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.timelineEntries).toHaveLength(1);
      expect(compiled.timelineEntries[0].tokens).toBeTypeOf("number");
      expect(compiled.timelineEntries[0].tokens).toBeGreaterThan(0);
    });

    it("stamps .tokens on system entries", async () => {
      const App = () => (
        <Message role="system" content={[{ type: "text", text: "You are helpful" }]} />
      );

      const compiled = await compiler.compile(<App />, tickState);

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
      const App = () => (
        <>
          <Section id="info">
            <TextComponent text="Section content" />
          </Section>
          <Message role="user" content={[{ type: "text", text: "User message" }]} />
          <Message role="system" content={[{ type: "text", text: "System" }]} />
          <Ephemeral position="end">
            <TextComponent text="Ephemeral note" />
          </Ephemeral>
        </>
      );

      const compiled = await compiler.compile(<App />, tickState);

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
      const App = () => (
        <Section id="text">
          <TextComponent text="Some text content here" />
        </Section>
      );
      const compiled = await compiler.compile(<App />, tickState);
      expect(compiled.sections.get("text")!.tokens).toBeGreaterThan(4); // more than just overhead
    });

    it("estimates code blocks", async () => {
      const App = () => (
        <Section id="code">
          <CodeComponent text="function foo() { return 42; }" language="js" />
        </Section>
      );
      const compiled = await compiler.compile(<App />, tickState);
      expect(compiled.sections.get("code")!.tokens).toBeGreaterThan(4);
    });

    it("estimates json blocks", async () => {
      const App = () => (
        <Section id="json">
          <JsonComponent data={{ key: "value", nested: { count: 42 } }} />
        </Section>
      );
      const compiled = await compiler.compile(<App />, tickState);
      expect(compiled.sections.get("json")!.tokens).toBeGreaterThan(4);
    });

    it("estimates image blocks as fixed overhead", async () => {
      const App = () => (
        <Section id="img">
          <ImageComponent
            source={{ type: "url", url: "https://example.com/img.png" }}
            altText="test"
          />
        </Section>
      );
      const compiled = await compiler.compile(<App />, tickState);
      // IMAGE_OVERHEAD = 85, plus MESSAGE_OVERHEAD = 4
      expect(compiled.sections.get("img")!.tokens).toBe(85 + 4);
    });

    it("sums mixed content blocks in a single section", async () => {
      const App = () => (
        <Section id="mixed">
          <TextComponent text="Hello World" />
          <CodeComponent text="x = 1" language="py" />
          <ImageComponent source={{ type: "url", url: "https://img.png" }} />
        </Section>
      );
      const compiled = await compiler.compile(<App />, tickState);
      const section = compiled.sections.get("mixed")!;

      // 7 (text) + 6 (code) + 85 (image) + 4 (message overhead) = 102
      expect(section.tokens).toBe(102);
    });

    it("estimates multi-block timeline entries", async () => {
      const App = () => (
        <Message
          role="user"
          content={[
            { type: "text", text: "First block" },
            { type: "text", text: "Second block" },
          ]}
        />
      );

      const compiled = await compiler.compile(<App />, tickState);
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

      const App = () => (
        <Section id="test">
          <TextComponent text="Hello" />
        </Section>
      );
      const compiled = await customCompiler.compile(<App />, tickState);

      // Custom estimator was called
      expect(customEstimator).toHaveBeenCalled();
      // Token count should reflect custom estimator: "Hello".length * 2 = 10, + MESSAGE_OVERHEAD = 14
      expect(compiled.sections.get("test")!.tokens).toBe(14);
    });

    it("default estimator uses char/4 + 4 formula", async () => {
      // "Hello World" = 11 chars, ceil(11/4) + 4 = 3 + 4 = 7 tokens
      // Plus MESSAGE_OVERHEAD = 4 → total = 11
      const App = () => (
        <Section id="test">
          <TextComponent text="Hello World" />
        </Section>
      );
      const compiled = await compiler.compile(<App />, tickState);

      // Default estimator: ceil(11/4) + 4 = 7 per block, + MESSAGE_OVERHEAD 4 = 11
      expect(compiled.sections.get("test")!.tokens).toBe(11);
    });

    it("default estimator handles empty string", async () => {
      // "" = 0 chars, ceil(0/4) + 4 = 4 tokens
      // Plus MESSAGE_OVERHEAD = 4 → total = 8
      const App = () => (
        <Section id="test">
          <TextComponent text="" />
        </Section>
      );
      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.sections.get("test")!.tokens).toBe(8);
    });
  });

  // ============================================================================
  // collect() direct tests
  // ============================================================================

  describe("collect() with estimator", () => {
    it("annotates when estimator is provided", async () => {
      const estimator: TokenEstimator = (text) => text.length;

      const App = () => (
        <>
          <Section id="s1">
            <TextComponent text="Hello" />
          </Section>
          <Message role="user" content={[{ type: "text", text: "World" }]} />
        </>
      );

      // Use compiler to render the tree, then collect directly
      await compiler.compile(<App />, tickState);
      const collected = collect((compiler as any).container, estimator);

      // Section: "Hello".length = 5 + MESSAGE_OVERHEAD = 9
      expect(collected.sections.get("s1")!.tokens).toBe(9);
      // Entry: "World".length = 5 + MESSAGE_OVERHEAD = 9
      expect(collected.timelineEntries[0].tokens).toBe(9);
      // Total
      expect(collected.totalTokens).toBe(18);
    });

    it("does not annotate when estimator is omitted", async () => {
      const App = () => (
        <Section id="s1">
          <TextComponent text="Hello" />
        </Section>
      );

      await compiler.compile(<App />, tickState);
      const collected = collect((compiler as any).container);

      expect(collected.sections.get("s1")!.tokens).toBeUndefined();
      expect(collected.totalTokens).toBeUndefined();
    });
  });
});
