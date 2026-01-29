/**
 * Integration tests for semantic-first compilation and rendering.
 *
 * These tests verify the full pipeline:
 * 1. JSX elements → FiberCompiler (via content block mappers) → Semantic structure
 * 2. Semantic structure → Renderer → Formatted text (markdown/XML)
 *
 * This ensures the compiler builds semantic structure correctly and
 * renderers format it appropriately.
 */

import { Text } from "../../jsx/components/content";
import { H1, H2, H3 } from "../../jsx/components/semantic";
import {
  initializeContentBlockMappers,
  type ContentBlockMapper,
} from "../../compiler/content-block-registry";
import { MarkdownRenderer } from "../markdown";
import { XMLRenderer } from "../xml";
import type { SemanticContentBlock } from "../base";

// Create a test registry to map JSX elements to SemanticContentBlock
const testMappers = new Map<any, ContentBlockMapper>();
initializeContentBlockMappers((type, mapper) => {
  testMappers.set(type, mapper);
});

/**
 * Helper to compile a JSX element to SemanticContentBlock using the registry
 */
function compileJSX(element: any): SemanticContentBlock | null {
  const mapper = testMappers.get(element.type);
  if (!mapper) {
    throw new Error(`No mapper found for type: ${element.type}`);
  }
  return mapper(element);
}

describe("Semantic-first compilation and rendering", () => {
  const markdownRenderer = new MarkdownRenderer();
  const xmlRenderer = new XMLRenderer();

  describe("Text block with inline formatting", () => {
    it("should compile and render strong text", () => {
      // JSX: <Text>Hello <strong>world</strong></Text>
      const jsx = (
        <Text>
          Hello <strong>world</strong>
        </Text>
      );

      const block = compileJSX(jsx);
      expect(block).not.toBeNull();
      expect(block!.semanticNode).toBeDefined();
      expect(block!.semanticNode!.children).toHaveLength(2);
      expect(block!.semanticNode!.children![0]).toEqual({ text: "Hello " });
      expect(block!.semanticNode!.children![1]).toEqual({
        semantic: "strong",
        children: [{ text: "world" }],
      });

      const markdownResult = markdownRenderer.format([block!]);
      const xmlResult = xmlRenderer.format([block!]);

      expect(markdownResult[0].type).toBe("text");
      expect((markdownResult[0] as any).text).toBe("Hello **world**");

      expect(xmlResult[0].type).toBe("text");
      expect((xmlResult[0] as any).text).toBe("Hello <strong>world</strong>");
    });

    it("should handle nested formatting", () => {
      // JSX: <Text>Text with <strong>bold and <em>italic</em></strong></Text>
      const jsx = (
        <Text>
          Text with{" "}
          <strong>
            bold and <em>italic</em>
          </strong>
        </Text>
      );

      const block = compileJSX(jsx);
      expect(block).not.toBeNull();

      const markdownResult = markdownRenderer.format([block!]);
      const xmlResult = xmlRenderer.format([block!]);

      expect((markdownResult[0] as any).text).toBe("Text with **bold and *italic***");
      expect((xmlResult[0] as any).text).toBe(
        "Text with <strong>bold and <em>italic</em></strong>",
      );
    });

    it("should handle inline code", () => {
      // JSX: <Text>Use <inlineCode>console.log()</inlineCode> to debug</Text>
      const jsx = (
        <Text>
          Use <inlineCode>console.log()</inlineCode> to debug
        </Text>
      );

      const block = compileJSX(jsx);
      expect(block).not.toBeNull();
      expect(block!.semanticNode!.children).toHaveLength(3);
      expect(block!.semanticNode!.children![1]).toEqual({
        semantic: "code",
        children: [{ text: "console.log()" }],
      });

      const markdownResult = markdownRenderer.format([block!]);
      const xmlResult = xmlRenderer.format([block!]);

      expect((markdownResult[0] as any).text).toBe("Use `console.log()` to debug");
      expect((xmlResult[0] as any).text).toBe("Use <code>console.log()</code> to debug");
    });

    it("should handle multiple inline formats", () => {
      // JSX: <Text>Plain <strong>bold</strong> <em>italic</em> <inlineCode>code</inlineCode> text</Text>
      const jsx = (
        <Text>
          Plain <strong>bold</strong> <em>italic</em> <inlineCode>code</inlineCode> text
        </Text>
      );

      const block = compileJSX(jsx);
      expect(block).not.toBeNull();

      const markdownResult = markdownRenderer.format([block!]);
      const xmlResult = xmlRenderer.format([block!]);

      expect((markdownResult[0] as any).text).toBe("Plain **bold** *italic* `code` text");
      expect((xmlResult[0] as any).text).toBe(
        "Plain <strong>bold</strong> <em>italic</em> <code>code</code> text",
      );
    });
  });

  describe("Paragraph with inline formatting", () => {
    it("should compile and render paragraph with formatting", () => {
      // JSX: <Paragraph>This is a paragraph with <em>emphasis</em></Paragraph>
      const jsx = (
        <p>
          This is a paragraph with <em>emphasis</em>
        </p>
      );

      const block = compileJSX(jsx);
      expect(block).not.toBeNull();
      expect(block!.semantic).toBeDefined();
      expect(block!.semantic!.type).toBe("paragraph");
      expect(block!.semanticNode).toBeDefined(); // Should have semantic tree for nested formatting

      const markdownResult = markdownRenderer.format([block!]);
      const xmlResult = xmlRenderer.format([block!]);

      expect((markdownResult[0] as any).text).toBe("This is a paragraph with *emphasis*");
      expect((xmlResult[0] as any).text).toBe("<p>This is a paragraph with <em>emphasis</em></p>");
    });
  });

  describe("Headings with inline formatting", () => {
    it("should compile and render H1", () => {
      // JSX: <H1>Title</H1>
      const jsx = <H1>Title</H1>;

      const block = compileJSX(jsx);
      expect(block).not.toBeNull();
      expect(block!.semantic).toBeDefined();
      expect(block!.semantic!.type).toBe("heading");
      expect(block!.semantic!.level).toBe(1);

      const markdownResult = markdownRenderer.format([block!]);
      const xmlResult = xmlRenderer.format([block!]);

      expect((markdownResult[0] as any).text).toBe("# Title");
      expect((xmlResult[0] as any).text).toBe("<h1>Title</h1>");
    });

    it("should compile and render H2 with inline formatting", () => {
      // JSX: <H2>Title with <strong>bold</strong></H2>
      const jsx = (
        <H2>
          Title with <strong>bold</strong>
        </H2>
      );

      const block = compileJSX(jsx);
      expect(block).not.toBeNull();
      expect(block!.semantic!.level).toBe(2);
      expect(block!.semanticNode).toBeDefined();

      const markdownResult = markdownRenderer.format([block!]);
      const xmlResult = xmlRenderer.format([block!]);

      expect((markdownResult[0] as any).text).toBe("## Title with **bold**");
      expect((xmlResult[0] as any).text).toBe("<h2>Title with <strong>bold</strong></h2>");
    });

    it("should compile and render H3", () => {
      // JSX: <H3>Subtitle</H3>
      const jsx = <H3>Subtitle</H3>;

      const block = compileJSX(jsx);
      expect(block).not.toBeNull();
      expect(block!.semantic!.level).toBe(3);

      const markdownResult = markdownRenderer.format([block!]);
      const xmlResult = xmlRenderer.format([block!]);

      expect((markdownResult[0] as any).text).toBe("### Subtitle");
      expect((xmlResult[0] as any).text).toBe("<h3>Subtitle</h3>");
    });
  });

  describe("Real-world examples", () => {
    it("should handle scratchpad tool example", () => {
      const jsx = (
        <Text>
          <p>
            You have a <inlineCode>scratchpad</inlineCode> tool for taking notes during this
            conversation.
          </p>
        </Text>
      );

      const block = compileJSX(jsx);
      expect(block).not.toBeNull();

      const markdownResult = markdownRenderer.format([block!]);
      const xmlResult = xmlRenderer.format([block!]);

      expect((markdownResult[0] as any).text).toBe(
        "You have a `scratchpad` tool for taking notes during this conversation.",
      );
      expect((xmlResult[0] as any).text).toBe(
        "<p>You have a <code>scratchpad</code> tool for taking notes during this conversation.</p>",
      );
    });

    it("should handle complex nested formatting", () => {
      // JSX: <Text>Use <strong><inlineCode>npm</inlineCode> install</strong> to install packages</Text>
      const jsx = (
        <Text>
          Use{" "}
          <strong>
            <inlineCode>npm</inlineCode> install
          </strong>{" "}
          to install packages
        </Text>
      );

      const block = compileJSX(jsx);
      expect(block).not.toBeNull();

      const markdownResult = markdownRenderer.format([block!]);
      const xmlResult = xmlRenderer.format([block!]);

      expect((markdownResult[0] as any).text).toBe("Use **`npm` install** to install packages");
      expect((xmlResult[0] as any).text).toBe(
        "Use <strong><code>npm</code> install</strong> to install packages",
      );
    });
  });

  describe("Media blocks - structural vs semantic", () => {
    it("should pass through Image component at root level (structural)", () => {
      // Capitalized <Image> component creates native ImageBlock (structural)
      // This would be tested via content-block-registry which creates native ImageBlock
      // For now, we test that formatStandard passes through image blocks
      const imageBlock: SemanticContentBlock = {
        type: "image",
        source: { type: "url", url: "https://example.com/photo.jpg" },
        altText: "A photo",
      };

      const markdownResult = markdownRenderer.format([imageBlock]);

      // Should pass through as native ImageBlock (not converted to text)
      expect(markdownResult[0]).toEqual(imageBlock);
      expect(markdownResult[0].type).toBe("image");
    });

    it("should convert <img> to markdown when nested inside Text (semantic)", () => {
      // JSX: <Text>Check this: <img src="..." alt="..." /></Text>
      // Lowercase <img> becomes a semantic node, renderer converts to ![alt](src)
      const jsx = (
        <Text>
          Check this: <img src="https://example.com/photo.jpg" alt="A photo" />
        </Text>
      );

      const block = compileJSX(jsx);
      expect(block).not.toBeNull();

      const markdownResult = markdownRenderer.format([block!]);

      // Should be converted to markdown image syntax
      expect((markdownResult[0] as any).text).toBe(
        "Check this: ![A photo](https://example.com/photo.jpg)",
      );
    });

    it("should convert <audio> to markdown when nested inside Text", () => {
      const jsx = (
        <Text>
          Listen here: <audio src="https://example.com/sound.mp3" />
        </Text>
      );

      const block = compileJSX(jsx);
      expect(block).not.toBeNull();

      const markdownResult = markdownRenderer.format([block!]);
      expect((markdownResult[0] as any).text).toBe(
        "Listen here: [Audio: https://example.com/sound.mp3]",
      );
    });

    it("should convert <video> to markdown when nested inside Text", () => {
      const jsx = (
        <Text>
          Watch: <video src="https://example.com/video.mp4" />
        </Text>
      );

      const block = compileJSX(jsx);
      expect(block).not.toBeNull();

      const markdownResult = markdownRenderer.format([block!]);
      expect((markdownResult[0] as any).text).toBe("Watch: [Video: https://example.com/video.mp4]");
    });
  });
});
