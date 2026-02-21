/**
 * Tests for OpenAI Adapter Transformations
 *
 * Tests the data shape transformations between Agentick format and OpenAI format.
 */

import {
  buildClientOptions,
  toOpenAIMessages,
  mapToolDefinition,
  mapOpenAIChunk,
} from "../openai.js";
import { STOP_REASON_MAP } from "../types.js";
import { StopReason } from "@agentick/shared";
import type { AdapterDelta } from "@agentick/core/model";
import type { Message, ImageBlock, ToolUseBlock, ToolResultBlock } from "@agentick/shared";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

// =============================================================================
// Stop Reason Mapping
// =============================================================================

describe("STOP_REASON_MAP", () => {
  it("should map stop to STOP", () => {
    expect(STOP_REASON_MAP["stop"]).toBe(StopReason.STOP);
  });

  it("should map length to MAX_TOKENS", () => {
    expect(STOP_REASON_MAP["length"]).toBe(StopReason.MAX_TOKENS);
  });

  it("should map content_filter to CONTENT_FILTER", () => {
    expect(STOP_REASON_MAP["content_filter"]).toBe(StopReason.CONTENT_FILTER);
  });

  it("should map tool_calls to TOOL_USE", () => {
    expect(STOP_REASON_MAP["tool_calls"]).toBe(StopReason.TOOL_USE);
  });

  it("should map function_call to FUNCTION_CALL", () => {
    expect(STOP_REASON_MAP["function_call"]).toBe(StopReason.FUNCTION_CALL);
  });

  it("should return undefined for unknown reasons", () => {
    expect(STOP_REASON_MAP["unknown"]).toBeUndefined();
  });
});

// =============================================================================
// Client Options Building
// =============================================================================

describe("buildClientOptions", () => {
  // Save original env values
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_BASE_URL"];
    delete process.env["OPENAI_ORGANIZATION"];
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  it("should use apiKey from config", () => {
    const result = buildClientOptions({ apiKey: "test-api-key" });
    expect(result.apiKey).toBe("test-api-key");
  });

  it("should use apiKey from environment when not in config", () => {
    process.env["OPENAI_API_KEY"] = "env-api-key";
    const result = buildClientOptions({});
    expect(result.apiKey).toBe("env-api-key");
  });

  it("should prefer config apiKey over environment", () => {
    process.env["OPENAI_API_KEY"] = "env-api-key";
    const result = buildClientOptions({ apiKey: "config-api-key" });
    expect(result.apiKey).toBe("config-api-key");
  });

  it("should use baseURL from config", () => {
    const result = buildClientOptions({
      baseURL: "https://custom.openai.com",
    });
    expect(result.baseURL).toBe("https://custom.openai.com");
  });

  it("should use baseURL from environment when not in config", () => {
    process.env["OPENAI_BASE_URL"] = "https://env.openai.com";
    const result = buildClientOptions({});
    expect(result.baseURL).toBe("https://env.openai.com");
  });

  it("should use organization from config", () => {
    const result = buildClientOptions({ organization: "org-123" });
    expect(result.organization).toBe("org-123");
  });

  it("should use organization from environment when not in config", () => {
    process.env["OPENAI_ORGANIZATION"] = "env-org-456";
    const result = buildClientOptions({});
    expect(result.organization).toBe("env-org-456");
  });

  it("should include custom headers", () => {
    const result = buildClientOptions({
      headers: { "X-Custom-Header": "custom-value" },
    });
    expect(result.defaultHeaders).toEqual({
      "X-Custom-Header": "custom-value",
    });
  });

  it("should merge providerOptions.openai into options", () => {
    const result = buildClientOptions({
      providerOptions: {
        openai: {
          maxRetries: 5,
          timeout: 30000,
        } as any,
      },
    });
    expect(result.maxRetries).toBe(5);
    expect(result.timeout).toBe(30000);
  });

  it("should remove undefined values", () => {
    const result = buildClientOptions({
      apiKey: "test-key",
      organization: undefined,
    });
    expect(result.apiKey).toBe("test-key");
    expect("organization" in result).toBe(false);
  });

  it("should combine all options", () => {
    const result = buildClientOptions({
      apiKey: "test-key",
      baseURL: "https://custom.openai.com",
      organization: "org-123",
      headers: { "X-Custom": "value" },
    });

    expect(result.apiKey).toBe("test-key");
    expect(result.baseURL).toBe("https://custom.openai.com");
    expect(result.organization).toBe("org-123");
    expect(result.defaultHeaders).toEqual({ "X-Custom": "value" });
  });
});

// =============================================================================
// Message Transformation: Agentick -> OpenAI
// =============================================================================

describe("toOpenAIMessages", () => {
  describe("text blocks", () => {
    it("should convert single text block", () => {
      const message: Message = {
        role: "user",
        content: [{ type: "text", text: "Hello, world!" }],
      };
      const result = toOpenAIMessages(message);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: "user",
        content: [{ type: "text", text: "Hello, world!" }],
      });
    });

    it("should convert multiple text blocks", () => {
      const message: Message = {
        role: "user",
        content: [
          { type: "text", text: "First" },
          { type: "text", text: "Second" },
        ],
      };
      const result = toOpenAIMessages(message);

      expect(result).toHaveLength(1);
      expect((result[0] as any).content).toHaveLength(2);
      expect((result[0] as any).content[0]).toEqual({
        type: "text",
        text: "First",
      });
      expect((result[0] as any).content[1]).toEqual({
        type: "text",
        text: "Second",
      });
    });

    it("should preserve message role", () => {
      const message: Message = {
        role: "assistant",
        content: [{ type: "text", text: "Response" }],
      };
      const result = toOpenAIMessages(message);

      expect(result[0].role).toBe("assistant");
    });
  });

  describe("image blocks", () => {
    it("should convert image with URL source", () => {
      const message: Message = {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: "https://example.com/image.png" },
            mimeType: "image/png",
          } as ImageBlock,
        ],
      };
      const result = toOpenAIMessages(message);

      expect((result[0] as any).content[0]).toEqual({
        type: "image_url",
        image_url: { url: "https://example.com/image.png" },
      });
    });

    it("should convert image with base64 source", () => {
      const message: Message = {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              data: "iVBORw0KGgoAAAANS...",
              mimeType: "image/png",
            },
            mimeType: "image/png",
          } as ImageBlock,
        ],
      };
      const result = toOpenAIMessages(message);

      expect((result[0] as any).content[0]).toEqual({
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANS..." },
      });
    });

    it("should skip image with unsupported source type", () => {
      const message: Message = {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "gcs", bucket: "test", object: "img.png" } as any,
            mimeType: "image/png",
          } as ImageBlock,
        ],
      };
      const result = toOpenAIMessages(message);

      // Should have empty content array (or null)
      expect((result[0] as any).content === null || (result[0] as any).content.length === 0).toBe(
        true,
      );
    });
  });

  describe("tool_use blocks", () => {
    it("should convert tool_use block to tool_calls", () => {
      const message: Message = {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            toolUseId: "call-123",
            name: "calculator",
            input: { expression: "2+2" },
          } as ToolUseBlock,
        ],
      };
      const result = toOpenAIMessages(message);

      expect(result).toHaveLength(1);
      expect((result[0] as any).tool_calls).toHaveLength(1);
      expect((result[0] as any).tool_calls[0]).toEqual({
        id: "call-123",
        type: "function",
        function: {
          name: "calculator",
          arguments: '{"expression":"2+2"}',
        },
      });
    });

    it("should handle multiple tool_use blocks", () => {
      const message: Message = {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            toolUseId: "call-1",
            name: "tool1",
            input: { a: 1 },
          } as ToolUseBlock,
          {
            type: "tool_use",
            toolUseId: "call-2",
            name: "tool2",
            input: { b: 2 },
          } as ToolUseBlock,
        ],
      };
      const result = toOpenAIMessages(message);

      expect((result[0] as any).tool_calls).toHaveLength(2);
      expect((result[0] as any).tool_calls[0].id).toBe("call-1");
      expect((result[0] as any).tool_calls[1].id).toBe("call-2");
    });

    it("should handle empty tool input", () => {
      const message: Message = {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            toolUseId: "call-123",
            name: "get_time",
            input: {},
          } as ToolUseBlock,
        ],
      };
      const result = toOpenAIMessages(message);

      expect((result[0] as any).tool_calls[0].function.arguments).toBe("{}");
    });
  });

  describe("tool_result blocks", () => {
    it("should convert tool_result block to separate tool message", () => {
      const message: Message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call-123",
            name: "calculator",
            content: [{ type: "text", text: "4" }],
          } as ToolResultBlock,
        ],
      };
      const result = toOpenAIMessages(message);

      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("tool");
      expect((result[0] as any).tool_call_id).toBe("call-123");
      expect((result[0] as any).content).toBe("4");
    });

    it("should join multiple text blocks in tool_result", () => {
      const message: Message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call-123",
            name: "multi_result",
            content: [
              { type: "text", text: "Line 1" },
              { type: "text", text: "Line 2" },
            ],
          } as ToolResultBlock,
        ],
      };
      const result = toOpenAIMessages(message);

      expect((result[0] as any).content).toBe("Line 1\nLine 2");
    });

    it("should use 'Done' for empty tool_result content", () => {
      const message: Message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call-123",
            name: "empty_result",
            content: [],
          } as ToolResultBlock,
        ],
      };
      const result = toOpenAIMessages(message);

      expect((result[0] as any).content).toBe("Done");
    });

    it("should expand multiple tool_results into multiple messages", () => {
      const message: Message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call-1",
            name: "tool1",
            content: [{ type: "text", text: "Result 1" }],
          } as ToolResultBlock,
          {
            type: "tool_result",
            toolUseId: "call-2",
            name: "tool2",
            content: [{ type: "text", text: "Result 2" }],
          } as ToolResultBlock,
        ],
      };
      const result = toOpenAIMessages(message);

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe("tool");
      expect((result[0] as any).tool_call_id).toBe("call-1");
      expect((result[0] as any).content).toBe("Result 1");
      expect(result[1].role).toBe("tool");
      expect((result[1] as any).tool_call_id).toBe("call-2");
      expect((result[1] as any).content).toBe("Result 2");
    });
  });

  describe("mixed content", () => {
    it("should handle text and tool_use together", () => {
      const message: Message = {
        role: "assistant",
        content: [
          { type: "text", text: "Let me calculate that." },
          {
            type: "tool_use",
            toolUseId: "call-123",
            name: "calculator",
            input: { expression: "2+2" },
          } as ToolUseBlock,
        ],
      };
      const result = toOpenAIMessages(message);

      expect(result).toHaveLength(1);
      expect((result[0] as any).content).toHaveLength(1);
      expect((result[0] as any).content[0].type).toBe("text");
      expect((result[0] as any).tool_calls).toHaveLength(1);
    });

    it("should append tool_results after base message", () => {
      const message: Message = {
        role: "assistant",
        content: [
          { type: "text", text: "Here's what I found:" },
          {
            type: "tool_result",
            toolUseId: "call-123",
            name: "search",
            content: [{ type: "text", text: "Search results" }],
          } as ToolResultBlock,
        ],
      };
      const result = toOpenAIMessages(message);

      // First message is the base with text, second is the tool result
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe("assistant");
      expect((result[0] as any).content[0].text).toBe("Here's what I found:");
      expect(result[1].role).toBe("tool");
    });
  });

  describe("empty content", () => {
    it("should set content to null when no content blocks", () => {
      const message: Message = {
        role: "assistant",
        content: [],
      };
      const result = toOpenAIMessages(message);

      expect(result).toHaveLength(1);
      expect((result[0] as any).content).toBeNull();
    });
  });

  describe("unknown block types", () => {
    it("should convert unknown block type to text as fallback", () => {
      const message: Message = {
        role: "user",
        content: [{ type: "custom", data: "custom data" } as any],
      };
      const result = toOpenAIMessages(message);

      // Should contain a text conversion of the unknown block
      expect((result[0] as any).content).toHaveLength(1);
      expect((result[0] as any).content[0].type).toBe("text");
    });
  });
});

// =============================================================================
// Tool Definition Transformation
// =============================================================================

describe("mapToolDefinition", () => {
  // mapToolDefinition returns ChatCompletionFunctionTool which always has .function

  describe("string tools", () => {
    it("should convert string tool to function type", () => {
      const result = mapToolDefinition("simple_tool");

      expect(result).toEqual({
        type: "function",
        function: {
          name: "simple_tool",
          description: "",
          parameters: {},
        },
      });
    });
  });

  describe("ToolDefinition objects", () => {
    it("should convert basic ToolDefinition", () => {
      const tool = {
        name: "calculator",
        description: "Performs calculations",
        input: {
          type: "object",
          properties: {
            expression: { type: "string" },
          },
        },
      };
      const result = mapToolDefinition(tool);

      expect(result).toEqual({
        type: "function",
        function: {
          name: "calculator",
          description: "Performs calculations",
          parameters: {
            type: "object",
            properties: {
              expression: { type: "string" },
            },
          },
        },
      });
    });

    it("should handle ToolDefinition without description", () => {
      const tool = {
        name: "no_desc",
        input: { type: "object" },
      };
      const result = mapToolDefinition(tool);

      expect(result.function.description).toBe("");
    });

    it("should handle ToolDefinition without input", () => {
      const tool = {
        name: "no_params",
        input: undefined,
      };
      const result = mapToolDefinition(tool);

      expect(result.function.parameters).toEqual({});
    });

    it("should merge providerOptions.openai config", () => {
      const tool = {
        name: "with_provider",
        description: "Tool with provider options",
        input: { type: "object" },
        providerOptions: {
          openai: {
            strict: true,
          },
        },
      };
      const result = mapToolDefinition(tool);

      expect((result as any).strict).toBe(true);
      expect(result.function.name).toBe("with_provider");
    });

    it("should merge function-specific options from providerOptions", () => {
      const tool = {
        name: "override",
        description: "Original",
        input: { type: "object" },
        providerOptions: {
          openai: {
            function: {
              strict: true,
            },
          },
        },
      };
      const result = mapToolDefinition(tool);

      expect((result.function as any).strict).toBe(true);
      expect(result.function.name).toBe("override");
      expect(result.function.description).toBe("Original");
    });
  });

  describe("ModelToolReference (with metadata)", () => {
    it("should extract from metadata object", () => {
      const tool = {
        metadata: {
          id: "tool-id",
          name: "tool-name",
          description: "Tool description",
          inputSchema: { type: "object", properties: {} },
        },
      };
      const result = mapToolDefinition(tool);

      expect(result).toEqual({
        type: "function",
        function: {
          name: "tool-id",
          description: "Tool description",
          parameters: { type: "object", properties: {} },
        },
      });
    });

    it("should prefer id over name in metadata", () => {
      const tool = {
        metadata: {
          id: "preferred-id",
          name: "fallback-name",
        },
      };
      const result = mapToolDefinition(tool);

      expect(result.function.name).toBe("preferred-id");
    });

    it("should fall back to name when id is missing", () => {
      const tool = {
        metadata: {
          name: "fallback-name",
          description: "Description",
        },
      };
      const result = mapToolDefinition(tool);

      expect(result.function.name).toBe("fallback-name");
    });

    it("should use 'unknown' when no id or name", () => {
      const tool = {
        metadata: {
          description: "Only description",
        },
      };
      const result = mapToolDefinition(tool);

      expect(result.function.name).toBe("unknown");
    });

    it("should handle missing metadata properties gracefully", () => {
      const tool = {
        metadata: {},
      };
      const result = mapToolDefinition(tool);

      expect(result).toEqual({
        type: "function",
        function: {
          name: "unknown",
          description: "",
          parameters: {},
        },
      });
    });
  });

  describe("object without metadata wrapper", () => {
    it("should treat object as metadata itself", () => {
      const tool = {
        id: "direct-id",
        description: "Direct description",
        inputSchema: { type: "object" },
      };
      const result = mapToolDefinition(tool);

      expect(result).toEqual({
        type: "function",
        function: {
          name: "direct-id",
          description: "Direct description",
          parameters: { type: "object" },
        },
      });
    });
  });
});

// =============================================================================
// Streaming Chunk Mapping
// =============================================================================

function makeChunk(overrides: Partial<ChatCompletionChunk> = {}): ChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk" as const,
    created: 1234567890,
    model: "gpt-4",
    choices: [],
    ...overrides,
  };
}

function makeToolCallChunk(toolCall: {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}): ChatCompletionChunk {
  return makeChunk({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: toolCall.index,
              ...(toolCall.id ? { id: toolCall.id } : {}),
              ...(toolCall.name || toolCall.arguments
                ? {
                    function: {
                      ...(toolCall.name ? { name: toolCall.name } : {}),
                      ...(toolCall.arguments ? { arguments: toolCall.arguments } : {}),
                    },
                  }
                : {}),
            } as any,
          ],
        },
        finish_reason: null,
      } as any,
    ],
  });
}

describe("mapOpenAIChunk", () => {
  let idMap: Map<number, string>;

  beforeEach(() => {
    idMap = new Map();
  });

  describe("text chunks", () => {
    it("should map text content", () => {
      const chunk = makeChunk({
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null } as any],
      });
      expect(mapOpenAIChunk(chunk, idMap)).toEqual({ type: "text", delta: "hello" });
    });

    it("should return null for empty delta", () => {
      const chunk = makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: null } as any],
      });
      expect(mapOpenAIChunk(chunk, idMap)).toBeNull();
    });
  });

  describe("finish reason", () => {
    it("should map stop finish_reason to message_end", () => {
      const chunk = makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" } as any],
      });
      const result = mapOpenAIChunk(chunk, idMap) as AdapterDelta;
      expect(result.type).toBe("message_end");
      expect((result as any).stopReason).toBe(StopReason.STOP);
    });

    it("should map tool_calls finish_reason", () => {
      const chunk = makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" } as any],
      });
      const result = mapOpenAIChunk(chunk, idMap) as AdapterDelta;
      expect(result.type).toBe("message_end");
      expect((result as any).stopReason).toBe(StopReason.TOOL_USE);
    });
  });

  describe("usage-only chunks", () => {
    it("should emit usage event for chunks with no choices", () => {
      const chunk = makeChunk({
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
      expect(mapOpenAIChunk(chunk, idMap)).toEqual({
        type: "usage",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });
    });

    it("should return null for empty chunk with no usage", () => {
      const chunk = makeChunk({ choices: [] });
      expect(mapOpenAIChunk(chunk, idMap)).toBeNull();
    });
  });

  describe("tool calls — OpenAI style (split chunks)", () => {
    it("should emit tool_call_start when name arrives", () => {
      const chunk = makeToolCallChunk({ index: 0, id: "call_123", name: "glob" });
      const result = mapOpenAIChunk(chunk, idMap);
      expect(result).toEqual({ type: "tool_call_start", id: "call_123", name: "glob" });
    });

    it("should emit tool_call_delta for argument fragments", () => {
      // First: register the id
      mapOpenAIChunk(makeToolCallChunk({ index: 0, id: "call_123", name: "glob" }), idMap);

      // Second: argument fragment
      const chunk = makeToolCallChunk({ index: 0, arguments: '{"pat' });
      const result = mapOpenAIChunk(chunk, idMap);
      expect(result).toEqual({ type: "tool_call_delta", id: "call_123", delta: '{"pat' });
    });

    it("should track id by index across chunks", () => {
      // First chunk sets the id
      mapOpenAIChunk(makeToolCallChunk({ index: 0, id: "call_abc", name: "search" }), idMap);
      expect(idMap.get(0)).toBe("call_abc");

      // Subsequent chunks don't have id — should reuse tracked one
      const chunk = makeToolCallChunk({ index: 0, arguments: '{"q":"test"}' });
      const result = mapOpenAIChunk(chunk, idMap);
      expect(result).toEqual({ type: "tool_call_delta", id: "call_abc", delta: '{"q":"test"}' });
    });
  });

  describe("tool calls — Grok style (name + arguments in one chunk)", () => {
    it("should emit both tool_call_start and tool_call_delta", () => {
      const chunk = makeToolCallChunk({
        index: 0,
        id: "call_grok",
        name: "glob",
        arguments: '{"pattern":"**/*.ts"}',
      });
      const result = mapOpenAIChunk(chunk, idMap);

      // Should be an array of two deltas
      expect(Array.isArray(result)).toBe(true);
      const deltas = result as AdapterDelta[];
      expect(deltas).toHaveLength(2);
      expect(deltas[0]).toEqual({ type: "tool_call_start", id: "call_grok", name: "glob" });
      expect(deltas[1]).toEqual({
        type: "tool_call_delta",
        id: "call_grok",
        delta: '{"pattern":"**/*.ts"}',
      });
    });

    it("should handle complete tool call with empty arguments in one chunk", () => {
      const chunk = makeToolCallChunk({
        index: 0,
        id: "call_empty",
        name: "get_time",
        arguments: "{}",
      });
      const result = mapOpenAIChunk(chunk, idMap);

      expect(Array.isArray(result)).toBe(true);
      const deltas = result as AdapterDelta[];
      expect(deltas).toHaveLength(2);
      expect(deltas[0]).toEqual({ type: "tool_call_start", id: "call_empty", name: "get_time" });
      expect(deltas[1]).toEqual({ type: "tool_call_delta", id: "call_empty", delta: "{}" });
    });
  });

  describe("multiple tool calls in one chunk", () => {
    it("should only process first tool call (per existing behavior)", () => {
      const chunk = makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "tool_a" } },
                { index: 1, id: "call_2", function: { name: "tool_b" } },
              ],
            },
            finish_reason: null,
          } as any,
        ],
      });
      const result = mapOpenAIChunk(chunk, idMap);
      // Returns on first match
      expect(result).toEqual({ type: "tool_call_start", id: "call_1", name: "tool_a" });
    });
  });
});
