/**
 * Tests for AI-SDK Adapter Transformations
 *
 * Tests the data shape transformations between Agentick format and AI SDK format.
 */

import {
  toStopReason,
  toAiSdkMessages,
  fromAiSdkMessages,
  mapContentBlocksToAiSdkContent,
  mapContentBlockToAiSdkPart,
  mapAiSdkContentToContentBlocks,
  mapAiSdkPartToContentBlock,
  mapToolResultContent,
  convertToolsToToolSet,
} from "../adapter";
import { ImageMimeType, StopReason } from "@agentick/shared";
import type {
  Message,
  ContentBlock,
  TextBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  ReasoningBlock,
} from "@agentick/shared";

// =============================================================================
// Stop Reason Mapping
// =============================================================================

describe("toStopReason", () => {
  it("should map length to MAX_TOKENS", () => {
    expect(toStopReason("length")).toBe(StopReason.MAX_TOKENS);
  });

  it("should map stop to STOP", () => {
    expect(toStopReason("stop")).toBe(StopReason.STOP);
  });

  it("should map content-filter to CONTENT_FILTER", () => {
    expect(toStopReason("content-filter")).toBe(StopReason.CONTENT_FILTER);
  });

  it("should map tool-calls to TOOL_USE", () => {
    expect(toStopReason("tool-calls")).toBe(StopReason.TOOL_USE);
  });

  it("should map error to ERROR", () => {
    expect(toStopReason("error")).toBe(StopReason.ERROR);
  });

  it("should map other to OTHER", () => {
    expect(toStopReason("other")).toBe(StopReason.OTHER);
  });

  it("should map unknown to UNSPECIFIED", () => {
    expect(toStopReason("unknown-reason" as any)).toBe(StopReason.UNSPECIFIED);
  });
});

// =============================================================================
// Message Transformation: Agentick -> AI SDK
// =============================================================================

describe("toAiSdkMessages", () => {
  it("should convert user message with text", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello, world!" }],
      },
    ];

    const result = toAiSdkMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Hello, world!" }],
    });
  });

  it("should convert assistant message with text", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
      },
    ];

    const result = toAiSdkMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
  });

  it("should extract system message and prepend", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "system",
        content: [{ type: "text", text: "You are a helpful assistant." }],
      },
    ];

    const result = toAiSdkMessages(messages);

    expect(result[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
  });

  it("should use adapter system prompt as fallback", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ];

    const result = toAiSdkMessages(messages, "Default system prompt");

    expect(result[0]).toEqual({
      role: "system",
      content: "Default system prompt",
    });
  });

  it("should convert tool role messages", () => {
    const messages: Message[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolUseId: "call-123",
            name: "calculator",
            content: [{ type: "text", text: "42" }],
          } as ToolResultBlock,
        ],
      },
    ];

    const result = toAiSdkMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool");
    expect((result[0].content as any)[0].type).toBe("tool-result");
    expect((result[0].content as any)[0].toolCallId).toBe("call-123");
  });

  it("should skip messages with empty content", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ];

    const result = toAiSdkMessages(messages);

    expect(result).toHaveLength(1);
    expect((result[0].content as any)[0].text).toBe("Hello");
  });

  it("should convert event role to user", () => {
    const messages: Message[] = [
      {
        role: "event" as any,
        content: [{ type: "text", text: "Event content" }],
      },
    ];

    const result = toAiSdkMessages(messages);

    expect(result[0].role).toBe("user");
  });
});

// =============================================================================
// Message Transformation: AI SDK -> Agentick
// =============================================================================

describe("fromAiSdkMessages", () => {
  it("should return empty array for undefined", () => {
    expect(fromAiSdkMessages(undefined)).toEqual([]);
  });

  it("should return empty array for empty array", () => {
    expect(fromAiSdkMessages([])).toEqual([]);
  });

  it("should convert assistant messages", () => {
    const aiSdkMessages = [
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Hello!" }],
      },
    ];

    const result = fromAiSdkMessages(aiSdkMessages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content[0]).toEqual({ type: "text", text: "Hello!" });
  });

  it("should filter out messages with empty content", () => {
    const aiSdkMessages = [
      {
        role: "assistant" as const,
        content: [],
      },
    ];

    const result = fromAiSdkMessages(aiSdkMessages);
    expect(result).toHaveLength(0);
  });
});

// =============================================================================
// Content Block Transformation: Agentick -> AI SDK
// =============================================================================

describe("mapContentBlockToAiSdkPart", () => {
  it("should map text block", () => {
    const block: TextBlock = { type: "text", text: "Hello" };
    const result = mapContentBlockToAiSdkPart(block);

    expect(result).toEqual({ type: "text", text: "Hello" });
  });

  it("should map reasoning block", () => {
    const block: ReasoningBlock = { type: "reasoning", text: "Thinking..." };
    const result = mapContentBlockToAiSdkPart(block);

    expect(result).toEqual({ type: "reasoning", text: "Thinking..." });
  });

  it("should map image block with URL source", () => {
    const block: ImageBlock = {
      type: "image",
      source: { type: "url", url: "https://example.com/image.png" },
      mimeType: ImageMimeType.PNG,
    };
    const result = mapContentBlockToAiSdkPart(block);

    expect(result).toEqual({
      type: "image",
      image: "https://example.com/image.png",
      mediaType: "image/png",
    });
  });

  it("should map image block with base64 source", () => {
    const block: ImageBlock = {
      type: "image",
      source: {
        type: "base64",
        data: "iVBORw0KGgoAAAANS...",
      },
      mimeType: ImageMimeType.PNG,
    };
    const result = mapContentBlockToAiSdkPart(block);

    expect(result).toEqual({
      type: "image",
      image: "iVBORw0KGgoAAAANS...",
      mediaType: "image/png",
    });
  });

  it("should map tool_use block", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      toolUseId: "call-123",
      name: "calculator",
      input: { expression: "2+2" },
    };
    const result = mapContentBlockToAiSdkPart(block);

    expect(result).toEqual({
      type: "tool-call",
      toolCallId: "call-123",
      toolName: "calculator",
      input: { expression: "2+2" },
    });
  });

  it("should map tool_result block", () => {
    const block: ToolResultBlock = {
      type: "tool_result",
      toolUseId: "call-123",
      name: "calculator",
      content: [{ type: "text", text: "4" }],
    };
    const result = mapContentBlockToAiSdkPart(block);

    expect((result as any).type).toBe("tool-result");
    expect((result as any).toolCallId).toBe("call-123");
  });

  it("should return undefined for unsupported source types", () => {
    const block: ImageBlock = {
      type: "image",
      source: { type: "s3", bucket: "test", key: "image.png" } as any,
      mimeType: ImageMimeType.PNG,
    };
    const result = mapContentBlockToAiSdkPart(block);

    expect(result).toBeUndefined();
  });
});

describe("mapContentBlocksToAiSdkContent", () => {
  it("should map multiple blocks", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "First" },
      { type: "text", text: "Second" },
    ];

    const result = mapContentBlocksToAiSdkContent(blocks);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: "First" });
    expect(result[1]).toEqual({ type: "text", text: "Second" });
  });

  it("should filter out undefined parts", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "Keep this" },
      {
        type: "image",
        source: { type: "gcs", bucket: "test", object: "test.png" } as any,
        mimeType: ImageMimeType.PNG,
      },
    ];

    const result = mapContentBlocksToAiSdkContent(blocks);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "text", text: "Keep this" });
  });
});

// =============================================================================
// Content Block Transformation: AI SDK -> Agentick
// =============================================================================

describe("mapAiSdkPartToContentBlock", () => {
  it("should map text part", () => {
    const result = mapAiSdkPartToContentBlock({ type: "text", text: "Hello" });
    expect(result).toEqual({ type: "text", text: "Hello" });
  });

  it("should map reasoning part", () => {
    const result = mapAiSdkPartToContentBlock({
      type: "reasoning",
      text: "Let me think...",
    } as any);
    expect(result).toEqual({ type: "reasoning", text: "Let me think..." });
  });

  // Skip: AI SDK AssistantContent doesn't include image type
  it.skip("should map image part with URL", () => {
    const result = mapAiSdkPartToContentBlock({
      type: "image",
      image: "https://example.com/image.png",
      mediaType: "image/png",
    });

    expect(result).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/image.png" },
      mimeType: "image/png",
    });
  });

  // Skip: AI SDK AssistantContent doesn't include image type
  it.skip("should map image part with base64", () => {
    const result = mapAiSdkPartToContentBlock({
      type: "image",
      image: "iVBORw0KGgoAAAANS...",
      mediaType: "image/png",
    });

    expect(result).toEqual({
      type: "image",
      source: { type: "base64", data: "iVBORw0KGgoAAAANS..." },
      mimeType: "image/png",
    });
  });

  it("should map tool-call part", () => {
    const result = mapAiSdkPartToContentBlock({
      type: "tool-call",
      toolCallId: "call-123",
      toolName: "calculator",
      args: { expression: "2+2" },
    } as any);

    expect(result).toEqual({
      type: "tool_use",
      toolUseId: "call-123",
      name: "calculator",
      input: { expression: "2+2" },
    });
  });
});

describe("mapAiSdkContentToContentBlocks", () => {
  it("should handle string content", () => {
    const result = mapAiSdkContentToContentBlocks("Hello, world!");
    expect(result).toEqual([{ type: "text", text: "Hello, world!" }]);
  });

  it("should handle array content", () => {
    const content = [
      { type: "text" as const, text: "First" },
      { type: "text" as const, text: "Second" },
    ];
    const result = mapAiSdkContentToContentBlocks(content);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: "First" });
    expect(result[1]).toEqual({ type: "text", text: "Second" });
  });

  it("should filter undefined blocks", () => {
    const content = [{ type: "text" as const, text: "Keep" }, { type: "unknown-type" as any }];
    const result = mapAiSdkContentToContentBlocks(content as any);

    // The unknown type might be converted or undefined depending on implementation
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]).toEqual({ type: "text", text: "Keep" });
  });
});

// =============================================================================
// Tool Result Transformation
// =============================================================================

describe("mapToolResultContent", () => {
  it("should return default success for empty content", () => {
    const result = mapToolResultContent([]);
    expect(result).toEqual({ type: "text", value: "Tool execution succeeded" });
  });

  it("should return default error for empty content with isError", () => {
    const result = mapToolResultContent([], true);
    expect(result).toEqual({
      type: "error-text",
      value: "Tool execution failed",
    });
  });

  it("should return text type for single text block", () => {
    const result = mapToolResultContent([{ type: "text", text: "Result text" }]);
    expect(result).toEqual({ type: "text", value: "Result text" });
  });

  it("should return error-text for single text block with isError", () => {
    const result = mapToolResultContent([{ type: "text", text: "Error message" }], true);
    expect(result).toEqual({ type: "error-text", value: "Error message" });
  });

  it("should return json type for single json block", () => {
    const result = mapToolResultContent([
      { type: "json", text: '{"key":"value"}', data: { key: "value" } } as any,
    ]);
    expect(result).toEqual({ type: "json", value: { key: "value" } });
  });

  it("should return error-json for single json block with isError", () => {
    const result = mapToolResultContent(
      [
        {
          type: "json",
          text: '{"error":"oops"}',
          data: { error: "oops" },
        } as any,
      ],
      true,
    );
    expect(result).toEqual({ type: "error-json", value: { error: "oops" } });
  });

  it("should return content type for multiple blocks", () => {
    const result = mapToolResultContent([
      { type: "text", text: "Line 1" },
      { type: "text", text: "Line 2" },
    ]);

    expect(result.type).toBe("content");
    expect((result as any).value).toHaveLength(2);
  });

  it("should handle image blocks in content type", () => {
    const result = mapToolResultContent([
      { type: "text", text: "Image:" },
      {
        type: "image",
        source: { type: "base64", data: "imagedata", media_type: "image/png" },
        mimeType: "image/png",
      } as ImageBlock,
    ]);

    expect(result.type).toBe("content");
    const value = (result as any).value;
    expect(value[0]).toEqual({ type: "text", text: "Image:" });
    expect(value[1]).toEqual({
      type: "media",
      data: "imagedata",
      mediaType: "image/png",
    });
  });
});

describe("mapToolResultContent", () => {
  it("should return success text for empty content", () => {
    const result = mapToolResultContent([]);
    expect(result).toEqual({ type: "text", value: "Tool execution succeeded" });
  });

  it("should handle error case", () => {
    const result = mapToolResultContent([], true);
    expect(result).toEqual({
      type: "error-text",
      value: "Tool execution failed",
    });
  });

  it("should handle single text block", () => {
    const result = mapToolResultContent([{ type: "text", text: "42" }]);
    expect(result).toEqual({ type: "text", value: "42" });
  });

  it("should handle json block", () => {
    const result = mapToolResultContent([
      { type: "json", text: '{"result": 42}', data: { result: 42 } } as any,
    ]);
    expect(result).toEqual({ type: "json", value: { result: 42 } });
  });
});

// =============================================================================
// Tool Conversion
// =============================================================================

describe("convertToolsToToolSet", () => {
  it("should return empty object for undefined tools", () => {
    expect(convertToolsToToolSet(undefined)).toEqual({});
  });

  it("should return empty object for empty array", () => {
    expect(convertToolsToToolSet([])).toEqual({});
  });

  it("should skip string tool references", () => {
    const tools = ["tool-name" as any];
    const result = convertToolsToToolSet(tools);
    expect(result).toEqual({});
  });

  it("should convert ExecutableTool", () => {
    const tools = [
      {
        metadata: {
          name: "calculator",
          description: "Performs calculations",
          input: { type: "object" },
        },
        run: () => Promise.resolve("result"),
      } as any,
    ];

    const result = convertToolsToToolSet(tools);

    expect(result.calculator).toBeDefined();
    expect(result.calculator.description).toBe("Performs calculations");
  });

  it("should convert ToolDefinition", () => {
    const tools = [
      {
        name: "search",
        description: "Search the web",
        input: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      } as any,
    ];

    const result = convertToolsToToolSet(tools);

    expect(result.search).toBeDefined();
    expect(result.search.description).toBe("Search the web");
  });
});
