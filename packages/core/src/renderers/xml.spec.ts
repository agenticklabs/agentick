/**
 * XML Renderer Tests
 *
 * Tests for the XMLRenderer class, focused on collapsed block rendering.
 */

import { describe, it, expect } from "vitest";
import { XMLRenderer } from "./xml";
import type { SemanticContentBlock } from "./base";

describe("XMLRenderer", () => {
  describe("collapsed blocks", () => {
    it("formatSemantic renders collapsed with name", () => {
      const renderer = new XMLRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: "[file contents]",
        semantic: {
          type: "custom",
          rendererTag: "collapsed",
          rendererAttrs: { name: "ref:0" },
        },
      };
      const result = renderer.formatSemantic(block);
      expect(result).toEqual({
        type: "text",
        text: '<collapsed name="ref:0">[file contents]</collapsed>',
      });
    });

    it("formatSemantic renders collapsed with name and group", () => {
      const renderer = new XMLRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: "[image: photo.png]",
        semantic: {
          type: "custom",
          rendererTag: "collapsed",
          rendererAttrs: { name: "img:0", group: "msg:123" },
        },
      };
      const result = renderer.formatSemantic(block);
      expect(result).toEqual({
        type: "text",
        text: '<collapsed name="img:0" group="msg:123">[image: photo.png]</collapsed>',
      });
    });

    it("escapes XML special characters in summary text", () => {
      const renderer = new XMLRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: 'user asked: "what <is> this & that?"',
        semantic: {
          type: "custom",
          rendererTag: "collapsed",
          rendererAttrs: { name: "ref:0" },
        },
      };
      const result = renderer.formatSemantic(block);
      expect((result as any).text).toBe(
        '<collapsed name="ref:0">user asked: &quot;what &lt;is&gt; this &amp; that?&quot;</collapsed>',
      );
    });

    it("escapes XML special characters in name attribute", () => {
      const renderer = new XMLRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: "summary",
        semantic: {
          type: "custom",
          rendererTag: "collapsed",
          rendererAttrs: { name: 'ref:"0"' },
        },
      };
      const result = renderer.formatSemantic(block);
      expect((result as any).text).toContain('name="ref:&quot;0&quot;"');
    });

    it("format() routes collapsed blocks through formatSemantic", () => {
      const renderer = new XMLRenderer();
      const blocks: SemanticContentBlock[] = [
        { type: "text", text: "visible text" },
        {
          type: "text",
          text: "[code: python]",
          semantic: {
            type: "custom",
            rendererTag: "collapsed",
            rendererAttrs: { name: "code:0" },
          },
        },
      ];
      const result = renderer.format(blocks);
      expect(result).toHaveLength(2);
      expect((result[0] as any).text).toBe("visible text");
      expect((result[1] as any).text).toBe('<collapsed name="code:0">[code: python]</collapsed>');
    });

    it("handles missing group attribute", () => {
      const renderer = new XMLRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: "summary",
        semantic: {
          type: "custom",
          rendererTag: "collapsed",
          rendererAttrs: { name: "ref:0" },
        },
      };
      const result = renderer.formatSemantic(block);
      const text = (result as any).text;
      expect(text).not.toContain("group=");
      expect(text).toBe('<collapsed name="ref:0">summary</collapsed>');
    });

    it("non-collapsed custom returns null", () => {
      const renderer = new XMLRenderer();
      const block: SemanticContentBlock = {
        type: "text",
        text: "something",
        semantic: {
          type: "custom",
          rendererTag: "timestamp",
          rendererAttrs: { format: "iso" },
        },
      };
      const result = renderer.formatSemantic(block);
      expect(result).toBeNull();
    });
  });

  describe("formatStandard", () => {
    it("formats code blocks with XML pre/code tags", () => {
      const renderer = new XMLRenderer();
      const block: SemanticContentBlock = {
        type: "code",
        text: "const x = 1;",
        language: "typescript",
      } as any;
      const result = renderer.formatStandard(block);
      expect(result).toHaveLength(1);
      expect((result[0] as any).text).toBe(
        '<pre><code class="language-typescript">const x = 1;</code></pre>',
      );
    });

    it("escapes XML in code block content", () => {
      const renderer = new XMLRenderer();
      const block: SemanticContentBlock = {
        type: "code",
        text: "if (a < b && c > d) {}",
        language: "typescript",
      } as any;
      const result = renderer.formatStandard(block);
      expect((result[0] as any).text).toContain("&lt;");
      expect((result[0] as any).text).toContain("&amp;&amp;");
    });

    it("passes through tool_use blocks unchanged", () => {
      const renderer = new XMLRenderer();
      const block: SemanticContentBlock = {
        type: "tool_use",
        toolUseId: "call_1",
        name: "shell",
        input: { cmd: "ls" },
      } as any;
      const result = renderer.formatStandard(block);
      expect(result).toEqual([block]);
    });
  });
});
