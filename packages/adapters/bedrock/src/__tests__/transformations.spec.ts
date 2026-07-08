/**
 * Tests for Bedrock Adapter Transformations
 *
 * Tests the data shape transformations between Agentick format and AWS Bedrock format.
 */

import {
  toBedrockMessages,
  mapToolDefinition,
  mapBedrockStreamChunk,
  processConverseOutput,
} from "../bedrock.js";
import { STOP_REASON_MAP } from "../types.js";
import { StopReason } from "@agentick/shared";
import type { AdapterDelta } from "@agentick/core/model";
import type { Message, ImageBlock, ToolUseBlock, ToolResultBlock } from "@agentick/shared";

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

  it("should map content_filtered to CONTENT_FILTER", () => {
    expect(STOP_REASON_MAP["content_filtered"]).toBe(StopReason.CONTENT_FILTER);
  });

  it("should map guardrail_intervened to CONTENT_FILTER", () => {
    expect(STOP_REASON_MAP["guardrail_intervened"]).toBe(StopReason.CONTENT_FILTER);
  });

  it("should return undefined for unknown reasons", () => {
    expect(STOP_REASON_MAP["unknown"]).toBeUndefined();
  });
});

// =============================================================================
// Message Transformation: Agentick -> Bedrock
// =============================================================================

describe("toBedrockMessages", () => {
  describe("text blocks", () => {
    it("should convert single text message", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Hello, world!" }],
        },
      ];
      const result = toBedrockMessages(messages);

      expect(result.system).toHaveLength(0);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        role: "user",
        content: [{ text: "Hello, world!" }],
      });
    });

    it("should convert multiple text blocks", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "First" },
            { type: "text", text: "Second" },
          ],
        },
      ];
      const result = toBedrockMessages(messages);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toHaveLength(2);
      expect(result.messages[0].content![0]).toEqual({ text: "First" });
      expect(result.messages[0].content![1]).toEqual({ text: "Second" });
    });

    it("should preserve assistant role", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [{ type: "text", text: "Response" }],
        },
      ];
      const result = toBedrockMessages(messages);

      expect(result.messages[0].role).toBe("assistant");
    });
  });

  describe("system messages", () => {
    it("should extract system messages to system blocks", () => {
      const messages: Message[] = [
        {
          role: "system",
          content: [{ type: "text", text: "You are a helpful assistant." }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      ];
      const result = toBedrockMessages(messages);

      expect(result.system).toHaveLength(1);
      expect(result.system[0]).toEqual({
        text: "You are a helpful assistant.",
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
    });

    it("should handle multiple system messages", () => {
      const messages: Message[] = [
        {
          role: "system",
          content: [
            { type: "text", text: "System instruction 1" },
            { type: "text", text: "System instruction 2" },
          ],
        },
      ];
      const result = toBedrockMessages(messages);

      expect(result.system).toHaveLength(2);
      expect(result.system[0]).toEqual({ text: "System instruction 1" });
      expect(result.system[1]).toEqual({ text: "System instruction 2" });
    });
  });

  describe("image blocks", () => {
    it("should convert image with base64 source to bytes", () => {
      // "SGVsbG8=" is "Hello" in base64
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                data: "SGVsbG8=",
                mimeType: "image/png",
              },
              mimeType: "image/png",
            } as ImageBlock,
          ],
        },
      ];
      const result = toBedrockMessages(messages);

      const imageBlock = result.messages[0].content![0] as any;
      expect(imageBlock.image).toBeDefined();
      expect(imageBlock.image.format).toBe("png");
      expect(imageBlock.image.source.bytes).toBeInstanceOf(Uint8Array);
      // Verify the bytes match "Hello"
      const decoded = Buffer.from(imageBlock.image.source.bytes).toString("utf-8");
      expect(decoded).toBe("Hello");
    });

    it("should extract format from mimeType", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                data: "AAAA",
                mimeType: "image/jpeg",
              },
              mimeType: "image/jpeg",
            } as ImageBlock,
          ],
        },
      ];
      const result = toBedrockMessages(messages);

      const imageBlock = result.messages[0].content![0] as any;
      expect(imageBlock.image.format).toBe("jpeg");
    });
  });

  describe("document blocks", () => {
    it("should convert a base64 document source to bytes", () => {
      // "SGVsbG8=" is "Hello" in base64
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", data: "SGVsbG8=", mimeType: "application/pdf" },
              mimeType: "application/pdf",
            } as any,
          ],
        },
      ];
      const result = toBedrockMessages(messages);

      const doc = result.messages[0].content![0] as any;
      expect(doc.document).toBeDefined();
      expect(doc.document.format).toBe("pdf");
      expect(doc.document.source.bytes).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(doc.document.source.bytes).toString("utf-8")).toBe("Hello");
    });

    it("should map an s3:// document url to s3Location", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "url",
                url: "s3://my-bucket/invoice.pdf",
                mimeType: "application/pdf",
              },
              title: "Invoice #123",
            } as any,
          ],
        },
      ];
      const result = toBedrockMessages(messages);

      const doc = result.messages[0].content![0] as any;
      expect(doc.document.source.s3Location.uri).toBe("s3://my-bucket/invoice.pdf");
      expect(doc.document.format).toBe("pdf");
    });

    it("should sanitize the document name to Bedrock's allowed charset", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", data: "AAAA", mimeType: "application/pdf" },
              title: "quote/2024_final*.pdf",
            } as any,
          ],
        },
      ];
      const result = toBedrockMessages(messages);

      const doc = result.messages[0].content![0] as any;
      // '/', '_', '*' and '.' are all outside Bedrock's allowed charset → spaces, collapsed.
      expect(doc.document.name).toBe("quote 2024 final pdf");
    });

    it("should still accept pre-decoded bytes on the source", () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "document", source: { bytes }, format: "csv" } as any],
        },
      ];
      const result = toBedrockMessages(messages);

      const doc = result.messages[0].content![0] as any;
      expect(doc.document.source.bytes).toBe(bytes);
      expect(doc.document.format).toBe("csv");
    });
  });

  describe("tool_use blocks", () => {
    it("should convert tool_use block to Bedrock toolUse format", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolUseId: "call-123",
              name: "calculator",
              input: { expression: "2+2" },
            } as ToolUseBlock,
          ],
        },
      ];
      const result = toBedrockMessages(messages);

      expect(result.messages).toHaveLength(1);
      const block = result.messages[0].content![0] as any;
      expect(block.toolUse).toEqual({
        toolUseId: "call-123",
        name: "calculator",
        input: { expression: "2+2" },
      });
    });

    it("should handle empty tool input", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolUseId: "call-123",
              name: "get_time",
              input: {},
            } as ToolUseBlock,
          ],
        },
      ];
      const result = toBedrockMessages(messages);

      const block = result.messages[0].content![0] as any;
      expect(block.toolUse.input).toEqual({});
    });
  });

  describe("tool_result blocks", () => {
    it("should convert tool_result block to Bedrock toolResult format", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call-123",
              name: "calculator",
              content: [{ type: "text", text: "4" }],
            } as ToolResultBlock,
          ],
        },
      ];
      const result = toBedrockMessages(messages);

      const block = result.messages[0].content![0] as any;
      expect(block.toolResult).toEqual({
        toolUseId: "call-123",
        content: [{ text: "4" }],
        status: "success",
      });
    });

    it("should use 'Done' for empty tool_result content", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call-123",
              name: "empty_result",
              content: [],
            } as ToolResultBlock,
          ],
        },
      ];
      const result = toBedrockMessages(messages);

      const block = result.messages[0].content![0] as any;
      expect(block.toolResult.content).toEqual([{ text: "Done" }]);
    });

    it("should set status to error when isError is true", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call-123",
              name: "failed_tool",
              content: [{ type: "text", text: "Something went wrong" }],
              isError: true,
            } as ToolResultBlock,
          ],
        },
      ];
      const result = toBedrockMessages(messages);

      const block = result.messages[0].content![0] as any;
      expect(block.toolResult.status).toBe("error");
    });

    it("should join multiple text blocks in tool_result", () => {
      const messages: Message[] = [
        {
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
        },
      ];
      const result = toBedrockMessages(messages);

      const block = result.messages[0].content![0] as any;
      expect(block.toolResult.content).toEqual([{ text: "Line 1\nLine 2" }]);
    });
  });

  describe("empty content", () => {
    it("should skip messages with no content blocks", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [],
        },
      ];
      const result = toBedrockMessages(messages);

      expect(result.messages).toHaveLength(0);
    });
  });
});

// =============================================================================
// Tool Definition Transformation
// =============================================================================

describe("mapToolDefinition", () => {
  describe("string tools", () => {
    it("should convert string tool to toolSpec format", () => {
      const result = mapToolDefinition("simple_tool");

      expect(result).toEqual({
        toolSpec: {
          name: "simple_tool",
          description: "",
          inputSchema: { json: {} },
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
        toolSpec: {
          name: "calculator",
          description: "Performs calculations",
          inputSchema: {
            json: {
              type: "object",
              properties: {
                expression: { type: "string" },
              },
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

      expect(result.toolSpec!.description).toBe("");
    });

    it("should handle ToolDefinition without input", () => {
      const tool = {
        name: "no_params",
        input: undefined,
      };
      const result = mapToolDefinition(tool);

      expect(result.toolSpec!.inputSchema).toEqual({ json: {} });
    });

    it("should merge providerOptions.bedrock config", () => {
      const tool = {
        name: "with_provider",
        description: "Tool with provider options",
        input: { type: "object" },
        providerOptions: {
          bedrock: {
            toolSpec: {
              description: "Overridden description",
            },
          },
        },
      };
      const result = mapToolDefinition(tool);

      expect(result.toolSpec!.description).toBe("Overridden description");
      expect(result.toolSpec!.name).toBe("with_provider");
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
        toolSpec: {
          name: "tool-id",
          description: "Tool description",
          inputSchema: { json: { type: "object", properties: {} } },
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

      expect(result.toolSpec!.name).toBe("preferred-id");
    });

    it("should fall back to name when id is missing", () => {
      const tool = {
        metadata: {
          name: "fallback-name",
          description: "Description",
        },
      };
      const result = mapToolDefinition(tool);

      expect(result.toolSpec!.name).toBe("fallback-name");
    });

    it("should use 'unknown' when no id or name", () => {
      const tool = {
        metadata: {
          description: "Only description",
        },
      };
      const result = mapToolDefinition(tool);

      expect(result.toolSpec!.name).toBe("unknown");
    });

    it("should handle missing metadata properties gracefully", () => {
      const tool = {
        metadata: {},
      };
      const result = mapToolDefinition(tool);

      expect(result).toEqual({
        toolSpec: {
          name: "unknown",
          description: "",
          inputSchema: { json: {} },
        },
      });
    });
  });
});

// =============================================================================
// Streaming Chunk Mapping
// =============================================================================

describe("mapBedrockStreamChunk", () => {
  let toolCallState: Map<number, { id: string; name: string }>;

  beforeEach(() => {
    toolCallState = new Map();
  });

  describe("messageStart event", () => {
    it("should emit message_start", () => {
      const event = { messageStart: { role: "assistant" } };
      const result = mapBedrockStreamChunk(event, toolCallState);

      expect(result).toEqual({
        type: "message_start",
        model: "assistant",
      });
    });
  });

  describe("contentBlockDelta with text", () => {
    it("should emit text delta", () => {
      const event = {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { text: "Hello, world!" },
        },
      };
      const result = mapBedrockStreamChunk(event, toolCallState);

      expect(result).toEqual({ type: "text", delta: "Hello, world!" });
    });
  });

  describe("contentBlockStart with toolUse", () => {
    it("should emit tool_call_start and track state", () => {
      const event = {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: {
            toolUse: {
              toolUseId: "tool-123",
              name: "calculator",
            },
          },
        },
      };
      const result = mapBedrockStreamChunk(event, toolCallState);

      expect(result).toEqual({
        type: "tool_call_start",
        id: "tool-123",
        name: "calculator",
      });
      expect(toolCallState.has(1)).toBe(true);
      expect(toolCallState.get(1)).toEqual({
        id: "tool-123",
        name: "calculator",
      });
    });
  });

  describe("contentBlockDelta with toolUse input", () => {
    it("should emit tool_call_delta with tracked id", () => {
      // Pre-set tool state
      toolCallState.set(1, { id: "tool-123", name: "calculator" });

      const event = {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { toolUse: { input: '{"expression":"2+2"}' } },
        },
      };
      const result = mapBedrockStreamChunk(event, toolCallState);

      expect(result).toEqual({
        type: "tool_call_delta",
        id: "tool-123",
        delta: '{"expression":"2+2"}',
      });
    });
  });

  describe("contentBlockStop", () => {
    it("should emit tool_call_end when tracking a tool", () => {
      toolCallState.set(0, { id: "tool-123", name: "calculator" });

      const event = {
        contentBlockStop: { contentBlockIndex: 0 },
      };
      const result = mapBedrockStreamChunk(event, toolCallState);

      // No `input` on the end event — the stream accumulator must parse the
      // accumulated toolUse JSON deltas (a non-nullish input would win the
      // `delta.input ?? parse(...)` fallback and discard the arguments).
      expect(result).toEqual({
        type: "tool_call_end",
        id: "tool-123",
      });
      expect(toolCallState.has(0)).toBe(false);
    });

    it("should return null when not tracking a tool", () => {
      const event = {
        contentBlockStop: { contentBlockIndex: 0 },
      };
      const result = mapBedrockStreamChunk(event, toolCallState);

      expect(result).toBeNull();
    });
  });

  describe("messageStop event", () => {
    it("should emit message_end with mapped stop reason", () => {
      const event = {
        messageStop: { stopReason: "end_turn" },
      };
      const result = mapBedrockStreamChunk(event, toolCallState) as AdapterDelta;

      expect(result).toEqual({
        type: "message_end",
        stopReason: StopReason.STOP,
      });
    });

    it("should map tool_use stop reason", () => {
      const event = {
        messageStop: { stopReason: "tool_use" },
      };
      const result = mapBedrockStreamChunk(event, toolCallState) as AdapterDelta;

      expect((result as any).stopReason).toBe(StopReason.TOOL_USE);
    });

    it("should map max_tokens stop reason", () => {
      const event = {
        messageStop: { stopReason: "max_tokens" },
      };
      const result = mapBedrockStreamChunk(event, toolCallState) as AdapterDelta;

      expect((result as any).stopReason).toBe(StopReason.MAX_TOKENS);
    });

    it("should use OTHER for unknown stop reason", () => {
      const event = {
        messageStop: { stopReason: "something_new" },
      };
      const result = mapBedrockStreamChunk(event, toolCallState) as AdapterDelta;

      expect((result as any).stopReason).toBe(StopReason.OTHER);
    });
  });

  describe("metadata event", () => {
    it("should emit usage delta", () => {
      const event = {
        metadata: {
          usage: {
            inputTokens: 100,
            outputTokens: 50,
          },
        },
      };
      const result = mapBedrockStreamChunk(event, toolCallState);

      expect(result).toEqual({
        type: "usage",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
      });
    });

    it("should return null for metadata without usage", () => {
      const event = {
        metadata: { metrics: { latencyMs: 42 } },
      };
      const result = mapBedrockStreamChunk(event, toolCallState);

      expect(result).toBeNull();
    });
  });

  describe("unknown event", () => {
    it("should return null for unrecognized events", () => {
      const event = { somethingNew: { data: "value" } };
      const result = mapBedrockStreamChunk(event, toolCallState);

      expect(result).toBeNull();
    });
  });
});

// =============================================================================
// processConverseOutput
// =============================================================================

describe("processConverseOutput", () => {
  it("should convert a full Converse response to ModelOutput", () => {
    const output = {
      output: {
        message: {
          role: "assistant" as const,
          content: [
            { text: "Here is the answer:" },
            {
              toolUse: {
                toolUseId: "tool-456",
                name: "calculator",
                input: { expression: "2+2" },
              },
            },
          ],
        },
      },
      stopReason: "tool_use",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
      metrics: { latencyMs: 500 },
      $metadata: { requestId: "req-abc" },
    } as any;

    const result = processConverseOutput(output);

    // Check messages
    expect(result.messages).toHaveLength(1);
    expect(result.messages?.[0].role).toBe("assistant");
    expect(result.messages?.[0].content).toHaveLength(2);

    // Text block
    expect(result.messages?.[0].content[0]).toEqual({
      type: "text",
      text: "Here is the answer:",
    });

    // Tool use block
    expect(result.messages?.[0].content[1]).toEqual({
      type: "tool_use",
      toolUseId: "tool-456",
      name: "calculator",
      input: { expression: "2+2" },
    });

    // Tool calls
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({
      id: "tool-456",
      name: "calculator",
      input: { expression: "2+2" },
    });

    // Stop reason
    expect(result.stopReason).toBe(StopReason.TOOL_USE);

    // Usage
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    });

    // Raw preserved
    expect(result.raw).toBe(output);
  });

  it("should handle text-only response", () => {
    const output = {
      output: {
        message: {
          role: "assistant" as const,
          content: [{ text: "Hello!" }],
        },
      },
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
      $metadata: {},
    } as any;

    const result = processConverseOutput(output);

    expect(result.messages?.[0].content).toHaveLength(1);
    expect(result.messages?.[0].content[0]).toEqual({
      type: "text",
      text: "Hello!",
    });
    expect(result.toolCalls).toBeUndefined();
    expect(result.stopReason).toBe(StopReason.STOP);
  });

  it("should throw AdapterError when no message in response", () => {
    const output = {
      output: {},
      stopReason: "end_turn",
      $metadata: {},
    } as any;

    expect(() => processConverseOutput(output)).toThrow("No message in Bedrock response");
  });

  it("should provide message getter that returns assistant message", () => {
    const output = {
      output: {
        message: {
          role: "assistant" as const,
          content: [{ text: "Response" }],
        },
      },
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
      $metadata: {},
    } as any;

    const result = processConverseOutput(output);
    expect(result.message?.role).toBe("assistant");
    expect(result.message?.content[0]).toEqual({
      type: "text",
      text: "Response",
    });
  });
});

describe("mapToolDefinition — enriched inputSchema preference", () => {
  it("prefers metadata.inputSchema (JSON Schema) over raw zod input", async () => {
    const { mapToolDefinition } = await import("../bedrock.js");
    const jsonSchema = {
      type: "object",
      properties: { ItemsTsv: { type: "string" } },
      required: ["ItemsTsv"],
    };
    const zodLike = { _def: { typeName: "ZodObject" }, safeParse: () => ({ success: true }) };
    const mapped = mapToolDefinition({
      name: "submit_extraction",
      description: "d",
      input: zodLike,
      inputSchema: jsonSchema,
    } as never) as { toolSpec: { inputSchema: { json: unknown } } };
    expect(mapped.toolSpec.inputSchema.json).toEqual(jsonSchema);
  });

  it("falls back to input when no inputSchema is present", async () => {
    const { mapToolDefinition } = await import("../bedrock.js");
    const plain = { type: "object", properties: {} };
    const mapped = mapToolDefinition({
      name: "t",
      description: "d",
      input: plain,
    } as never) as { toolSpec: { inputSchema: { json: unknown } } };
    expect(mapped.toolSpec.inputSchema.json).toEqual(plain);
  });
});

describe("mapBedrockStreamChunk — toolUse input accumulation", () => {
  it("tool_call_end does not override accumulated input with {}", async () => {
    const { mapBedrockStreamChunk } = await import("../bedrock.js");
    const state = new Map();
    mapBedrockStreamChunk(
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "t1", name: "submit" } } } } as never,
      state,
    );
    mapBedrockStreamChunk(
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"a":1}' } } } } as never,
      state,
    );
    const end = mapBedrockStreamChunk({ contentBlockStop: { contentBlockIndex: 0 } } as never, state) as {
      type: string;
      input?: unknown;
    };
    expect(end.type).toBe("tool_call_end");
    // `input` must be absent (nullish) so the stream accumulator parses the
    // accumulated JSON deltas instead of receiving a hardcoded empty object.
    expect(end.input).toBeUndefined();
  });
});
