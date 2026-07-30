/**
 * Outbound content mapping (#255) — `toWireContent` / `toWireContentBlock`.
 *
 * Pins:
 *  - EVERY agentick `BlockType` produces a frame the SDK's own
 *    `ContentBlockSchema` parses. A block kind added to the spec fails
 *    the fold at compile time; a kind projected to an invalid frame fails
 *    here at runtime.
 *  - MCP-native kinds (text / base64 image / base64 audio / resource) are
 *    byte-stable — the projection is identity for a server that already
 *    spoke MCP's content vocabulary.
 *  - A URL-sourced medium becomes a `resource_link`, not a dropped block.
 *  - Non-native kinds become fenced text whose info string NAMES the
 *    projected kind (lossy, but never silent).
 */

import { ContentBlockSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { BlockType, ContentBlock } from "@agentick/spec";

import { toWireContent, toWireContentBlock } from "../content.js";

/** One block of every kind in the union — the exhaustiveness fixture. */
const ONE_OF_EACH: { readonly [K in BlockType]: Extract<ContentBlock, { type: K }> } = {
  text: { type: "text", text: "hello" },
  reasoning: { type: "reasoning", text: "thinking" },
  image: { type: "image", source: { type: "base64", data: "aW1n", mimeType: "image/png" } },
  document: {
    type: "document",
    source: { type: "url", url: "https://example.com/docs/report.pdf" },
    mimeType: "application/pdf",
  },
  audio: { type: "audio", source: { type: "base64", data: "YXVk", mimeType: "audio/mpeg" } },
  video: {
    type: "video",
    source: { type: "reference", fileId: "file_123", fileName: "clip.mp4" },
  },
  tool_use: { type: "tool_use", toolUseId: "call_1", name: "search", input: { q: "x" } },
  tool_result: {
    type: "tool_result",
    toolUseId: "call_1",
    name: "search",
    content: [{ type: "text", text: "found" }],
  },
  task_ref: { type: "task_ref", taskId: "task_1", status: "working" },
  resource: { type: "resource", resource: { uri: "file:///a.txt", text: "body" } },
  json: { type: "json", data: { x: 1 } },
  xml: { type: "xml", text: "<a/>" },
  csv: { type: "csv", text: "a,b\n1,2" },
  html: { type: "html", text: "<p>hi</p>" },
  code: { type: "code", text: "const x = 1;", language: "typescript" },
  generated_image: { type: "generated_image", data: "Z2Vu", mimeType: "image/webp" },
  generated_file: {
    type: "generated_file",
    uri: "https://example.com/out/chart.svg",
    mimeType: "image/svg+xml",
  },
  executable_code: { type: "executable_code", code: "print(1)", language: "python" },
  code_execution_result: { type: "code_execution_result", output: "1" },
  user_action: { type: "user_action", action: "clicked" },
  system_event: { type: "system_event", event: "restarted" },
  state_change: { type: "state_change", entity: "job", from: "open", to: "closed" },
  custom: { type: "custom", tag: "note", content: "body", attrs: { id: "7" } },
};

describe("toWireContent — every block kind reaches the wire", () => {
  it("produces a frame the SDK content schema parses, for all 23 kinds", () => {
    const blocks = Object.values(ONE_OF_EACH) as readonly ContentBlock[];
    const wire = toWireContent(blocks);
    expect(wire).toHaveLength(blocks.length);
    for (const frame of wire) {
      expect(() => ContentBlockSchema.parse(frame)).not.toThrow();
    }
  });

  it("names the projected kind on every non-native frame", () => {
    // The lossy frames are text blocks; each fence carries a kind (or the
    // language, for code) so a consumer can tell WHAT was narrowed.
    const fenced = (block: ContentBlock): string => {
      const frame = toWireContentBlock(block);
      expect(frame.type).toBe("text");
      return (frame as { text: string }).text;
    };
    expect(fenced(ONE_OF_EACH.json)).toBe('```json\n{"x":1}\n```');
    expect(fenced(ONE_OF_EACH.csv)).toBe("```csv\na,b\n1,2\n```");
    expect(fenced(ONE_OF_EACH.code)).toBe("```typescript\nconst x = 1;\n```");
    expect(fenced(ONE_OF_EACH.executable_code)).toBe("```python\nprint(1)\n```");
    expect(fenced(ONE_OF_EACH.reasoning)).toBe("```reasoning\nthinking\n```");
    expect(fenced(ONE_OF_EACH.custom)).toContain("```note\n");
    expect(fenced(ONE_OF_EACH.tool_use)).toContain("```tool_use\n");
    expect(fenced(ONE_OF_EACH.state_change)).toContain("```state_change\n");
    // A `reference` source names the adopter's file id rather than
    // inventing a uri the wire could not resolve.
    expect(fenced(ONE_OF_EACH.video)).toContain("file_123");
  });
});

describe("toWireContentBlock — MCP-native kinds are byte-stable", () => {
  it("text passes through unchanged", () => {
    expect(toWireContentBlock(ONE_OF_EACH.text)).toEqual({ type: "text", text: "hello" });
  });

  it("base64 image / audio map field-for-field", () => {
    expect(toWireContentBlock(ONE_OF_EACH.image)).toEqual({
      type: "image",
      data: "aW1n",
      mimeType: "image/png",
    });
    expect(toWireContentBlock(ONE_OF_EACH.audio)).toEqual({
      type: "audio",
      data: "YXVk",
      mimeType: "audio/mpeg",
    });
  });

  it("a resource block carries its contents verbatim", () => {
    expect(toWireContentBlock(ONE_OF_EACH.resource)).toEqual({
      type: "resource",
      resource: { uri: "file:///a.txt", text: "body" },
    });
  });

  it("a generated image IS the native base64 shape", () => {
    expect(toWireContentBlock(ONE_OF_EACH.generated_image)).toEqual({
      type: "image",
      data: "Z2Vu",
      mimeType: "image/webp",
    });
  });
});

describe("toWireContentBlock — addressable payloads become resource links", () => {
  it("a url-sourced document links instead of inlining or dropping", () => {
    expect(toWireContentBlock(ONE_OF_EACH.document)).toEqual({
      type: "resource_link",
      uri: "https://example.com/docs/report.pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
    });
  });

  it("a generated file links by its uri, named by its display name", () => {
    expect(toWireContentBlock(ONE_OF_EACH.generated_file)).toEqual({
      type: "resource_link",
      uri: "https://example.com/out/chart.svg",
      name: "chart.svg",
      mimeType: "image/svg+xml",
    });
  });

  it("an image's own label wins over the uri segment", () => {
    const wire = toWireContentBlock({
      type: "image",
      source: { type: "url", url: "https://cdn.example.com/a/b.png" },
      mimeType: "image/png",
      altText: "The chart",
    });
    expect(wire).toEqual({
      type: "resource_link",
      uri: "https://cdn.example.com/a/b.png",
      name: "The chart",
      mimeType: "image/png",
    });
  });
});

describe("toWireContentBlock — nested content", () => {
  it("a tool_result's own blocks narrow by the same rules", () => {
    const frame = toWireContentBlock(ONE_OF_EACH.tool_result) as { text: string };
    expect(frame.text).toContain('{"type":"text","text":"found"}');
  });
});
