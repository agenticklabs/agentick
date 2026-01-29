/**
 * Markdown Renderer Tests
 *
 * Tests for the MarkdownRenderer class, including flavor-specific rendering.
 */

import { describe, it, expect } from "vitest";
import { MarkdownRenderer } from "./markdown";
import type { SemanticContentBlock } from "./base";

describe("MarkdownRenderer", () => {
  describe("formatNode", () => {
    it("should format basic text", () => {
      const renderer = new MarkdownRenderer();
      const node = { text: "Hello world" };
      expect(renderer.formatNode(node)).toBe("Hello world");
    });

    it("should format strong text", () => {
      const renderer = new MarkdownRenderer();
      const node = { semantic: "strong" as const, text: "bold" };
      expect(renderer.formatNode(node)).toBe("**bold**");
    });

    it("should format emphasis text", () => {
      const renderer = new MarkdownRenderer();
      const node = { semantic: "em" as const, text: "italic" };
      expect(renderer.formatNode(node)).toBe("*italic*");
    });

    it("should format inline code", () => {
      const renderer = new MarkdownRenderer();
      const node = { semantic: "code" as const, text: "const x = 1" };
      expect(renderer.formatNode(node)).toBe("`const x = 1`");
    });

    it("should format strikethrough", () => {
      const renderer = new MarkdownRenderer();
      const node = { semantic: "strikethrough" as const, text: "deleted" };
      expect(renderer.formatNode(node)).toBe("~~deleted~~");
    });

    it("should format links", () => {
      const renderer = new MarkdownRenderer();
      const node = {
        semantic: "link" as const,
        text: "Click here",
        props: { href: "https://example.com" },
      };
      expect(renderer.formatNode(node)).toBe("[Click here](https://example.com)");
    });

    it("should format images", () => {
      const renderer = new MarkdownRenderer();
      const node = {
        semantic: "image" as const,
        props: { alt: "Logo", src: "/logo.png" },
      };
      expect(renderer.formatNode(node)).toBe("![Logo](/logo.png)");
    });

    it("should format blockquotes", () => {
      const renderer = new MarkdownRenderer();
      const node = { semantic: "blockquote" as const, text: "Line 1\nLine 2" };
      expect(renderer.formatNode(node)).toBe("> Line 1\n> Line 2");
    });

    it("should handle nested children", () => {
      const renderer = new MarkdownRenderer();
      const node = {
        semantic: "strong" as const,
        children: [{ text: "nested " }, { text: "content" }],
      };
      expect(renderer.formatNode(node)).toBe("**nested content**");
    });
  });

  describe("formatSemantic", () => {
    it("should format headings", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: "Title",
        semantic: { type: "heading", level: 1 },
      };
      const result = renderer.formatSemantic(block);
      expect(result).toEqual({ type: "text", text: "# Title" });
    });

    it("should format h2 headings", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: "Subtitle",
        semantic: { type: "heading", level: 2 },
      };
      const result = renderer.formatSemantic(block);
      expect(result).toEqual({ type: "text", text: "## Subtitle" });
    });

    it("should format horizontal rule", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: "",
        semantic: { type: "horizontal-rule" },
      };
      const result = renderer.formatSemantic(block);
      expect(result).toEqual({ type: "text", text: "\n---\n" });
    });

    it("should format line break", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: "",
        semantic: { type: "line-break" },
      };
      const result = renderer.formatSemantic(block);
      expect(result).toEqual({ type: "text", text: "\n" });
    });
  });

  describe("list formatting", () => {
    it("should format unordered lists", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: "",
        semantic: {
          type: "list",
          structure: {
            ordered: false,
            items: ["Item 1", "Item 2", "Item 3"],
          },
        },
      };
      const result = renderer.formatSemantic(block);
      expect(result?.type).toBe("text");
      expect((result as any).text).toBe("- Item 1\n- Item 2\n- Item 3");
    });

    it("should format ordered lists", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: "",
        semantic: {
          type: "list",
          structure: {
            ordered: true,
            items: ["First", "Second", "Third"],
          },
        },
      };
      const result = renderer.formatSemantic(block);
      expect(result?.type).toBe("text");
      expect((result as any).text).toBe("1. First\n2. Second\n3. Third");
    });
  });

  describe("task list flavors", () => {
    it("should format task lists with GFM checkboxes (github flavor)", () => {
      const renderer = new MarkdownRenderer("github");
      const block: SemanticContentBlock = {
        type: "text",
        text: "",
        semantic: {
          type: "list",
          structure: {
            ordered: false,
            task: true,
            items: [
              { text: "Done task", checked: true },
              { text: "Pending task", checked: false },
            ],
          },
        },
      };
      const result = renderer.formatSemantic(block);
      expect(result?.type).toBe("text");
      expect((result as any).text).toBe("- [x] Done task\n- [ ] Pending task");
    });

    it("should format task lists with GFM checkboxes (gfm flavor)", () => {
      const renderer = new MarkdownRenderer("gfm");
      const block: SemanticContentBlock = {
        type: "text",
        text: "",
        semantic: {
          type: "list",
          structure: {
            ordered: false,
            task: true,
            items: [
              { text: "Complete", checked: true },
              { text: "Incomplete", checked: false },
            ],
          },
        },
      };
      const result = renderer.formatSemantic(block);
      expect((result as any).text).toBe("- [x] Complete\n- [ ] Incomplete");
    });

    it("should format task lists with unicode symbols (commonmark flavor)", () => {
      const renderer = new MarkdownRenderer("commonmark");
      const block: SemanticContentBlock = {
        type: "text",
        text: "",
        semantic: {
          type: "list",
          structure: {
            ordered: false,
            task: true,
            items: [
              { text: "Done task", checked: true },
              { text: "Pending task", checked: false },
            ],
          },
        },
      };
      const result = renderer.formatSemantic(block);
      expect(result?.type).toBe("text");
      expect((result as any).text).toBe("- ✓ Done task\n- ○ Pending task");
    });

    it("should format task lists with unicode symbols (default/no flavor)", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: "",
        semantic: {
          type: "list",
          structure: {
            ordered: false,
            task: true,
            items: [
              { text: "Done", checked: true },
              { text: "Not done", checked: false },
            ],
          },
        },
      };
      const result = renderer.formatSemantic(block);
      // Default (undefined flavor) should use unicode symbols
      expect((result as any).text).toBe("- ✓ Done\n- ○ Not done");
    });
  });

  describe("table formatting", () => {
    it("should format simple tables", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: "",
        semantic: {
          type: "table",
          structure: {
            headers: ["Name", "Age"],
            rows: [
              ["Alice", "30"],
              ["Bob", "25"],
            ],
          },
        },
      };
      const result = renderer.formatSemantic(block);
      expect(result?.type).toBe("text");
      const text = (result as any).text;
      expect(text).toContain("| Name");
      expect(text).toContain("| Age");
      expect(text).toContain("| Alice");
      expect(text).toContain("| 30");
      expect(text).toContain("| Bob");
      expect(text).toContain("| 25");
      expect(text).toContain("---");
    });

    it("should format tables with alignment", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: "",
        semantic: {
          type: "table",
          structure: {
            headers: ["Left", "Center", "Right"],
            rows: [["1", "2", "3"]],
            alignments: ["left", "center", "right"],
          },
        },
      };
      const result = renderer.formatSemantic(block);
      const text = (result as any).text;
      // Center alignment has colons on both sides
      expect(text).toMatch(/:[-]+:/);
      // Right alignment has colon on right side
      expect(text).toMatch(/[-]+:/);
    });
  });

  describe("formatStandard", () => {
    it("should pass through text blocks", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = { type: "text", text: "Hello" };
      const result = renderer.formatStandard(block);
      expect(result).toEqual([{ type: "text", text: "Hello" }]);
    });

    it("should format code blocks with language", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "code",
        text: "const x = 1;",
        language: "typescript",
      } as any;
      const result = renderer.formatStandard(block);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("text");
      expect((result[0] as any).text).toBe("```typescript\nconst x = 1;\n```");
    });

    it("should format JSON blocks", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "json",
        text: '{"key": "value"}',
      } as any;
      const result = renderer.formatStandard(block);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("text");
      expect((result[0] as any).text).toContain("```json");
      expect((result[0] as any).text).toContain('{"key": "value"}');
    });

    it("should format user_action blocks", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "user_action",
        actor: "User",
        action: "clicked",
        target: "button",
      } as any;
      const result = renderer.formatStandard(block);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("text");
      expect((result[0] as any).text).toBe("User clicked on button");
    });

    it("should format state_change blocks", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "state_change",
        entity: "counter",
        field: "value",
        from: 0,
        to: 1,
      } as any;
      const result = renderer.formatStandard(block);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("text");
      expect((result[0] as any).text).toBe("counter.value: 0 → 1");
    });

    it("should pass through image blocks", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "image",
        source: { type: "url", url: "https://example.com/img.png" },
      } as any;
      const result = renderer.formatStandard(block);
      expect(result).toEqual([block]);
    });

    it("should pass through tool_use blocks", () => {
      const renderer = new MarkdownRenderer();
      const block: SemanticContentBlock = {
        type: "tool_use",
        toolUseId: "123",
        name: "search",
        input: {},
      } as any;
      const result = renderer.formatStandard(block);
      expect(result).toEqual([block]);
    });
  });
});
