/**
 * Tests for Anthropic Adapter Transformations
 *
 * Tests the data shape transformations between Agentick format and Anthropic format.
 */

import {
  buildClientOptions,
  toAnthropicMessages,
  mapToolDefinition,
  mapAnthropicChunk,
} from "../anthropic.js";
import { STOP_REASON_MAP } from "../types.js";
import { StopReason } from "@agentick/shared";
import type { AdapterDelta } from "@agentick/core/model";
import { StreamAccumulator } from "@agentick/core/model";
import type { Message, ImageBlock, ToolUseBlock, ToolResultBlock } from "@agentick/shared";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";

// =============================================================================
// Stop Reason Mapping
// =============================================================================

describe("STOP_REASON_MAP", () => {
  it("should map end_turn to STOP", () => {
    expect(STOP_REASON_MAP["end_turn"]).toBe(StopReason.STOP);
  });

  it("should map max_tokens to MAX_TOKENS", () => {
    expect(STOP_REASON_MAP["max_tokens"]).toBe(StopReason.MAX_TOKENS);
  });

  it("should map stop_sequence to STOP", () => {
    expect(STOP_REASON_MAP["stop_sequence"]).toBe(StopReason.STOP);
  });

  it("should map tool_use to TOOL_USE", () => {
    expect(STOP_REASON_MAP["tool_use"]).toBe(StopReason.TOOL_USE);
  });

  it("should return undefined for unknown reasons", () => {
    expect(STOP_REASON_MAP["unknown"]).toBeUndefined();
  });
});

// =============================================================================
// Client Options Building
// =============================================================================

describe("buildClientOptions", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_BASE_URL"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("should use apiKey from config", () => {
    const result = buildClientOptions({ apiKey: "test-api-key" });
    expect(result.apiKey).toBe("test-api-key");
  });

  it("should use apiKey from environment when not in config", () => {
    process.env["ANTHROPIC_API_KEY"] = "env-api-key";
    const result = buildClientOptions({});
    expect(result.apiKey).toBe("env-api-key");
  });

  it("should prefer config apiKey over environment", () => {
    process.env["ANTHROPIC_API_KEY"] = "env-api-key";
    const result = buildClientOptions({ apiKey: "config-api-key" });
    expect(result.apiKey).toBe("config-api-key");
  });

  it("should use baseURL from config", () => {
    const result = buildClientOptions({ baseURL: "https://custom.anthropic.com" });
    expect(result.baseURL).toBe("https://custom.anthropic.com");
  });

  it("should use baseURL from environment when not in config", () => {
    process.env["ANTHROPIC_BASE_URL"] = "https://env.anthropic.com";
    const result = buildClientOptions({});
    expect(result.baseURL).toBe("https://env.anthropic.com");
  });

  it("should include custom headers", () => {
    const result = buildClientOptions({
      headers: { "X-Custom-Header": "custom-value" },
    });
    expect(result.defaultHeaders).toEqual({ "X-Custom-Header": "custom-value" });
  });

  it("should include timeout and maxRetries", () => {
    const result = buildClientOptions({ timeout: 30000, maxRetries: 5 });
    expect(result.timeout).toBe(30000);
    expect(result.maxRetries).toBe(5);
  });

  it("should merge providerOptions.anthropic into options", () => {
    const result = buildClientOptions({
      providerOptions: {
        anthropic: {
          maxRetries: 3,
          timeout: 60000,
        } as any,
      },
    });
    expect(result.maxRetries).toBe(3);
    expect(result.timeout).toBe(60000);
  });

  it("should remove undefined values", () => {
    const result = buildClientOptions({
      apiKey: "test-key",
      baseURL: undefined,
    });
    expect(result.apiKey).toBe("test-key");
    expect("baseURL" in result).toBe(false);
  });

  it("should combine all options", () => {
    const result = buildClientOptions({
      apiKey: "test-key",
      baseURL: "https://custom.anthropic.com",
      headers: { "X-Custom": "value" },
      timeout: 30000,
      maxRetries: 3,
    });

    expect(result.apiKey).toBe("test-key");
    expect(result.baseURL).toBe("https://custom.anthropic.com");
    expect(result.defaultHeaders).toEqual({ "X-Custom": "value" });
    expect(result.timeout).toBe(30000);
    expect(result.maxRetries).toBe(3);
  });
});

// =============================================================================
// Message Transformation: Agentick -> Anthropic
// =============================================================================

describe("toAnthropicMessages", () => {
  describe("text blocks", () => {
    it("should convert single text message", () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Hello, world!" }] },
      ];
      const result = toAnthropicMessages(messages);

      expect(result.system).toBeUndefined();
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        role: "user",
        content: [{ type: "text", text: "Hello, world!" }],
      });
    });

    it("should convert multiple text blocks in one message", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "First" },
            { type: "text", text: "Second" },
          ],
        },
      ];
      const result = toAnthropicMessages(messages);

      expect(result.messages).toHaveLength(1);
      expect((result.messages[0] as any).content).toHaveLength(2);
    });

    it("should preserve assistant role", () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Hi" }] },
        { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
      ];
      const result = toAnthropicMessages(messages);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[1].role).toBe("assistant");
    });
  });

  describe("system message extraction", () => {
    it("should extract system message to system parameter", () => {
      const messages: Message[] = [
        { role: "system", content: [{ type: "text", text: "You are a helpful assistant." }] },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ];
      const result = toAnthropicMessages(messages);

      expect(result.system).toBe("You are a helpful assistant.");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
    });

    it("should concatenate multiple system messages", () => {
      const messages: Message[] = [
        { role: "system", content: [{ type: "text", text: "Part 1" }] },
        { role: "system", content: [{ type: "text", text: "Part 2" }] },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ];
      const result = toAnthropicMessages(messages);

      expect(result.system).toBe("Part 1\n\nPart 2");
    });

    it("should concatenate multiple text blocks within system message", () => {
      const messages: Message[] = [
        {
          role: "system",
          content: [
            { type: "text", text: "Block A" },
            { type: "text", text: "Block B" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ];
      const result = toAnthropicMessages(messages);

      expect(result.system).toBe("Block A\n\nBlock B");
    });
  });

  describe("image blocks", () => {
    it("should convert image with base64 source", () => {
      const messages: Message[] = [
        {
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
        },
      ];
      const result = toAnthropicMessages(messages);

      expect((result.messages[0] as any).content[0]).toEqual({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "iVBORw0KGgoAAAANS...",
        },
      });
    });

    it("should convert image with URL source", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: "https://example.com/image.png" },
              mimeType: "image/png",
            } as ImageBlock,
          ],
        },
      ];
      const result = toAnthropicMessages(messages);

      expect((result.messages[0] as any).content[0]).toEqual({
        type: "image",
        source: {
          type: "url",
          url: "https://example.com/image.png",
        },
      });
    });

    it("should skip image with unsupported source type", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "gcs", bucket: "test", object: "img.png" } as any,
              mimeType: "image/png",
            } as ImageBlock,
          ],
        },
      ];
      const result = toAnthropicMessages(messages);

      // Message should be skipped entirely since no content was produced
      expect(result.messages).toHaveLength(0);
    });
  });

  describe("tool_use blocks", () => {
    it("should convert tool_use block with toolUseId to id", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolUseId: "toolu_123",
              name: "calculator",
              input: { expression: "2+2" },
            } as ToolUseBlock,
          ],
        },
      ];
      const result = toAnthropicMessages(messages);

      expect((result.messages[0] as any).content[0]).toEqual({
        type: "tool_use",
        id: "toolu_123",
        name: "calculator",
        input: { expression: "2+2" },
      });
    });

    it("should handle multiple tool_use blocks", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolUseId: "toolu_1",
              name: "tool1",
              input: { a: 1 },
            } as ToolUseBlock,
            {
              type: "tool_use",
              toolUseId: "toolu_2",
              name: "tool2",
              input: { b: 2 },
            } as ToolUseBlock,
          ],
        },
      ];
      const result = toAnthropicMessages(messages);

      expect((result.messages[0] as any).content).toHaveLength(2);
      expect((result.messages[0] as any).content[0].id).toBe("toolu_1");
      expect((result.messages[0] as any).content[1].id).toBe("toolu_2");
    });
  });

  describe("tool_result blocks", () => {
    it("should convert tool_result with toolUseId to tool_use_id", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "toolu_123",
              name: "calculator",
              content: [{ type: "text", text: "4" }],
            } as ToolResultBlock,
          ],
        },
      ];
      const result = toAnthropicMessages(messages);

      expect((result.messages[0] as any).content[0]).toEqual({
        type: "tool_result",
        tool_use_id: "toolu_123",
        content: [{ type: "text", text: "4" }],
      });
    });

    it("should use 'Done' for empty tool_result content", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "toolu_123",
              name: "empty_result",
              content: [],
            } as ToolResultBlock,
          ],
        },
      ];
      const result = toAnthropicMessages(messages);

      expect((result.messages[0] as any).content[0].content).toEqual([
        { type: "text", text: "Done" },
      ]);
    });

    it("should use 'Done' for undefined tool_result content", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "toolu_123",
              name: "no_content",
            } as ToolResultBlock,
          ],
        },
      ];
      const result = toAnthropicMessages(messages);

      expect((result.messages[0] as any).content[0].content).toEqual([
        { type: "text", text: "Done" },
      ]);
    });

    it("should handle string tool_result content", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "toolu_123",
              name: "result",
              content: "plain text result" as any,
            } as ToolResultBlock,
          ],
        },
      ];
      const result = toAnthropicMessages(messages);

      expect((result.messages[0] as any).content[0].content).toEqual([
        { type: "text", text: "plain text result" },
      ]);
    });
  });

  describe("consecutive same-role merging", () => {
    it("should coalesce consecutive user messages", () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "First" }] },
        { role: "user", content: [{ type: "text", text: "Second" }] },
      ];
      const result = toAnthropicMessages(messages);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
      expect((result.messages[0] as any).content).toHaveLength(2);
      expect((result.messages[0] as any).content[0]).toEqual({
        type: "text",
        text: "First",
      });
      expect((result.messages[0] as any).content[1]).toEqual({
        type: "text",
        text: "Second",
      });
    });

    it("should coalesce consecutive assistant messages", () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Hi" }] },
        { role: "assistant", content: [{ type: "text", text: "First" }] },
        { role: "assistant", content: [{ type: "text", text: "Second" }] },
      ];
      const result = toAnthropicMessages(messages);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[1].role).toBe("assistant");
      expect((result.messages[1] as any).content).toHaveLength(2);
    });

    it("should not coalesce messages with different roles", () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Hi" }] },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        { role: "user", content: [{ type: "text", text: "How are you?" }] },
      ];
      const result = toAnthropicMessages(messages);

      expect(result.messages).toHaveLength(3);
    });
  });

  describe("mixed content types", () => {
    it("should handle text and tool_use together", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me calculate that." },
            {
              type: "tool_use",
              toolUseId: "toolu_123",
              name: "calculator",
              input: { expression: "2+2" },
            } as ToolUseBlock,
          ],
        },
      ];
      const result = toAnthropicMessages(messages);

      expect(result.messages).toHaveLength(1);
      expect((result.messages[0] as any).content).toHaveLength(2);
      expect((result.messages[0] as any).content[0].type).toBe("text");
      expect((result.messages[0] as any).content[1].type).toBe("tool_use");
    });
  });

  describe("non-standard roles mapped to user", () => {
    it("should map event role to user", () => {
      const messages: Message[] = [
        { role: "event" as any, content: [{ type: "text", text: "Event happened" }] },
      ];
      const result = toAnthropicMessages(messages);

      expect(result.messages[0].role).toBe("user");
    });
  });
});

// =============================================================================
// Tool Definition Transformation
// =============================================================================

describe("mapToolDefinition", () => {
  describe("string tools", () => {
    it("should convert string tool to Anthropic format", () => {
      const result = mapToolDefinition("simple_tool");

      expect(result).toEqual({
        name: "simple_tool",
        description: "",
        input_schema: { type: "object" },
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
        name: "calculator",
        description: "Performs calculations",
        input_schema: {
          type: "object",
          properties: {
            expression: { type: "string" },
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

      expect(result.description).toBe("");
    });

    it("should handle ToolDefinition without input", () => {
      const tool = {
        name: "no_params",
        input: undefined,
      };
      const result = mapToolDefinition(tool);

      expect(result.input_schema).toEqual({ type: "object" });
    });

    it("should merge providerOptions.anthropic config", () => {
      const tool = {
        name: "with_provider",
        description: "Tool with provider options",
        input: { type: "object" },
        providerOptions: {
          anthropic: {
            cache_control: { type: "ephemeral" },
          },
        },
      };
      const result = mapToolDefinition(tool);

      expect((result as any).cache_control).toEqual({ type: "ephemeral" });
      expect(result.name).toBe("with_provider");
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
        name: "tool-id",
        description: "Tool description",
        input_schema: { type: "object", properties: {} },
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

      expect(result.name).toBe("preferred-id");
    });

    it("should fall back to name when id is missing", () => {
      const tool = {
        metadata: {
          name: "fallback-name",
          description: "Description",
        },
      };
      const result = mapToolDefinition(tool);

      expect(result.name).toBe("fallback-name");
    });

    it("should use 'unknown' when no id or name", () => {
      const tool = {
        metadata: {
          description: "Only description",
        },
      };
      const result = mapToolDefinition(tool);

      expect(result.name).toBe("unknown");
    });

    it("should handle missing metadata properties gracefully", () => {
      const tool = {
        metadata: {},
      };
      const result = mapToolDefinition(tool);

      expect(result).toEqual({
        name: "unknown",
        description: "",
        input_schema: { type: "object" },
      });
    });
  });
});

// =============================================================================
// Streaming Chunk Mapping
// =============================================================================

describe("mapAnthropicChunk", () => {
  let blockState: Map<number, any>;

  beforeEach(() => {
    blockState = new Map();
  });

  describe("message_start", () => {
    it("should emit message_start and usage for message_start event", () => {
      const event: RawMessageStreamEvent = {
        type: "message_start",
        message: {
          id: "msg_123",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-20250514",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 0,
          },
        },
      };
      const result = mapAnthropicChunk(event, blockState);

      expect(Array.isArray(result)).toBe(true);
      const deltas = result as AdapterDelta[];
      expect(deltas).toHaveLength(2);
      expect(deltas[0]).toEqual({
        type: "message_start",
        model: "claude-sonnet-4-20250514",
      });
      expect(deltas[1]).toEqual({
        type: "usage",
        usage: { inputTokens: 100 },
      });
    });
  });

  describe("text content", () => {
    it("should map text_delta to text delta", () => {
      // First register the text block
      const startEvent: RawMessageStreamEvent = {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      };
      mapAnthropicChunk(startEvent, blockState);

      const event: RawMessageStreamEvent = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      };
      const result = mapAnthropicChunk(event, blockState);

      expect(result).toEqual({ type: "text", delta: "Hello" });
    });
  });

  describe("thinking content", () => {
    it("should emit null for thinking content_block_start", () => {
      const event: RawMessageStreamEvent = {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      } as any;
      const result = mapAnthropicChunk(event, blockState);

      expect(result).toBeNull();
    });

    it("should map thinking_delta to reasoning delta", () => {
      // First register thinking block
      const startEvent: RawMessageStreamEvent = {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      } as any;
      mapAnthropicChunk(startEvent, blockState);

      const event: RawMessageStreamEvent = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think about this..." },
      } as any;
      const result = mapAnthropicChunk(event, blockState);

      expect(result).toEqual({
        type: "reasoning",
        delta: "Let me think about this...",
      });
    });
  });

  describe("tool calls", () => {
    it("should emit tool_call_start on tool_use content_block_start", () => {
      const event: RawMessageStreamEvent = {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_123",
          name: "calculator",
          input: {},
        },
      };
      const result = mapAnthropicChunk(event, blockState);

      expect(result).toEqual({
        type: "tool_call_start",
        id: "toolu_123",
        name: "calculator",
      });
    });

    it("should emit tool_call_delta for input_json_delta", () => {
      // Register tool block
      const startEvent: RawMessageStreamEvent = {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_123",
          name: "calculator",
          input: {},
        },
      };
      mapAnthropicChunk(startEvent, blockState);

      const event: RawMessageStreamEvent = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"expres' },
      };
      const result = mapAnthropicChunk(event, blockState);

      expect(result).toEqual({
        type: "tool_call_delta",
        id: "toolu_123",
        delta: '{"expres',
      });
    });

    it("should emit tool_call_end on content_block_stop for tool_use", () => {
      // Register tool block and accumulate JSON
      const startEvent: RawMessageStreamEvent = {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_123",
          name: "calculator",
          input: {},
        },
      };
      mapAnthropicChunk(startEvent, blockState);

      const deltaEvent: RawMessageStreamEvent = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"expression":"2+2"}' },
      };
      mapAnthropicChunk(deltaEvent, blockState);

      const stopEvent: RawMessageStreamEvent = {
        type: "content_block_stop",
        index: 0,
      };
      const result = mapAnthropicChunk(stopEvent, blockState);

      expect(result).toEqual({
        type: "tool_call_end",
        id: "toolu_123",
        input: { expression: "2+2" },
      });
    });

    it("should return null on content_block_stop for text block", () => {
      // Register text block
      const startEvent: RawMessageStreamEvent = {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      };
      mapAnthropicChunk(startEvent, blockState);

      const stopEvent: RawMessageStreamEvent = {
        type: "content_block_stop",
        index: 0,
      };
      const result = mapAnthropicChunk(stopEvent, blockState);

      expect(result).toBeNull();
    });

    it("should accumulate partial JSON across multiple deltas", () => {
      // Register tool block
      mapAnthropicChunk(
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_456",
            name: "search",
            input: {},
          },
        } as RawMessageStreamEvent,
        blockState,
      );

      // Partial JSON chunks
      mapAnthropicChunk(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"q' },
        } as RawMessageStreamEvent,
        blockState,
      );
      mapAnthropicChunk(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: 'uery":"test' },
        } as RawMessageStreamEvent,
        blockState,
      );
      mapAnthropicChunk(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"}' },
        } as RawMessageStreamEvent,
        blockState,
      );

      // Stop
      const result = mapAnthropicChunk(
        { type: "content_block_stop", index: 0 } as RawMessageStreamEvent,
        blockState,
      );

      expect(result).toEqual({
        type: "tool_call_end",
        id: "toolu_456",
        input: { query: "test" },
      });
    });
  });

  describe("message_delta", () => {
    it("should emit message_end with stop_reason", () => {
      const event: RawMessageStreamEvent = {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 50 },
      } as any;
      const result = mapAnthropicChunk(event, blockState);

      expect(result).toEqual({
        type: "message_end",
        stopReason: StopReason.STOP,
        usage: { inputTokens: 0, outputTokens: 50, totalTokens: 50 },
      });
    });

    it("should map tool_use stop_reason", () => {
      const event: RawMessageStreamEvent = {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 30 },
      } as any;
      const result = mapAnthropicChunk(event, blockState) as AdapterDelta;

      expect(result.type).toBe("message_end");
      expect((result as any).stopReason).toBe(StopReason.TOOL_USE);
    });

    it("should map max_tokens stop_reason", () => {
      const event: RawMessageStreamEvent = {
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: { output_tokens: 4096 },
      } as any;
      const result = mapAnthropicChunk(event, blockState) as AdapterDelta;

      expect(result.type).toBe("message_end");
      expect((result as any).stopReason).toBe(StopReason.MAX_TOKENS);
    });
  });

  describe("message_stop", () => {
    it("should return null for message_stop", () => {
      const event: RawMessageStreamEvent = {
        type: "message_stop",
      } as any;
      const result = mapAnthropicChunk(event, blockState);

      expect(result).toBeNull();
    });
  });

  describe("multiple tool calls by block index", () => {
    it("should track multiple tool calls independently by index", () => {
      // Start two tool blocks
      mapAnthropicChunk(
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "tool_a",
            input: {},
          },
        } as RawMessageStreamEvent,
        blockState,
      );
      mapAnthropicChunk(
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_2",
            name: "tool_b",
            input: {},
          },
        } as RawMessageStreamEvent,
        blockState,
      );

      // Delta for tool_b (index 1)
      const delta1 = mapAnthropicChunk(
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"b":2}' },
        } as RawMessageStreamEvent,
        blockState,
      );
      expect(delta1).toEqual({
        type: "tool_call_delta",
        id: "toolu_2",
        delta: '{"b":2}',
      });

      // Delta for tool_a (index 0)
      const delta0 = mapAnthropicChunk(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"a":1}' },
        } as RawMessageStreamEvent,
        blockState,
      );
      expect(delta0).toEqual({
        type: "tool_call_delta",
        id: "toolu_1",
        delta: '{"a":1}',
      });

      // Stop both
      const stop0 = mapAnthropicChunk(
        { type: "content_block_stop", index: 0 } as RawMessageStreamEvent,
        blockState,
      );
      expect(stop0).toEqual({
        type: "tool_call_end",
        id: "toolu_1",
        input: { a: 1 },
      });

      const stop1 = mapAnthropicChunk(
        { type: "content_block_stop", index: 1 } as RawMessageStreamEvent,
        blockState,
      );
      expect(stop1).toEqual({
        type: "tool_call_end",
        id: "toolu_2",
        input: { b: 2 },
      });
    });
  });
});

// =============================================================================
// Round-trip test
// =============================================================================

describe("round-trip: Anthropic response -> accumulate -> serialize", () => {
  it("should preserve tool_use blocks through accumulation and re-serialization", () => {
    const accumulator = new StreamAccumulator({ modelId: "claude-sonnet-4-20250514" });
    const blockState = new Map<number, any>();

    // Simulate a realistic streaming sequence
    const events: RawMessageStreamEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_123",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-20250514",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 50, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Let me check." },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_abc",
          name: "search",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"query":' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"hello"}' },
      },
      {
        type: "content_block_stop",
        index: 1,
      },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 25 },
      } as any,
      {
        type: "message_stop",
      } as any,
    ];

    // Push all events through chunk mapper and accumulator
    for (const event of events) {
      const deltas = mapAnthropicChunk(event as any, blockState);
      if (deltas) {
        const deltaArray = Array.isArray(deltas) ? deltas : [deltas];
        for (const delta of deltaArray) {
          accumulator.push(delta);
        }
      }
    }

    // Verify accumulated state
    const output = accumulator.toModelOutput();
    expect(output.message.content).toHaveLength(2); // text + tool_use
    expect(output.stopReason).toBe(StopReason.TOOL_USE);

    const textBlock = output.message.content.find((b: any) => b.type === "text");
    expect((textBlock as any).text).toBe("Let me check.");

    const toolBlock = output.message.content.find((b: any) => b.type === "tool_use");
    expect((toolBlock as any).toolUseId).toBe("toolu_abc");
    expect((toolBlock as any).name).toBe("search");
    expect((toolBlock as any).input).toEqual({ query: "hello" });

    // Re-serialize back to Anthropic format
    const { messages } = toAnthropicMessages([output.message]);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");

    const content = (messages[0] as any).content;
    const serializedToolUse = content.find((b: any) => b.type === "tool_use");
    expect(serializedToolUse).toEqual({
      type: "tool_use",
      id: "toolu_abc",
      name: "search",
      input: { query: "hello" },
    });
  });
});
