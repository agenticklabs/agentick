/**
 * Tests for Google Adapter Transformations
 *
 * Tests the data shape transformations between Tentickle format and Google GenAI format.
 */

import {
  buildClientOptions,
  mapGoogleFinishReason,
  convertBlocksToGoogleParts,
  mapToolDefinition,
} from "../google";
import { STOP_REASON_MAP } from "../types";
import { StopReason } from "@tentickle/shared";
import type { ContentBlock, ImageBlock, ToolUseBlock, ToolResultBlock } from "@tentickle/shared";

// =============================================================================
// Stop Reason Mapping
// =============================================================================

describe("STOP_REASON_MAP", () => {
  it("should map FINISH_REASON_UNSPECIFIED to UNSPECIFIED", () => {
    expect(STOP_REASON_MAP["FINISH_REASON_UNSPECIFIED"]).toBe(StopReason.UNSPECIFIED);
  });

  it("should map STOP to STOP", () => {
    expect(STOP_REASON_MAP["STOP"]).toBe(StopReason.STOP);
  });

  it("should map MAX_TOKENS to MAX_TOKENS", () => {
    expect(STOP_REASON_MAP["MAX_TOKENS"]).toBe(StopReason.MAX_TOKENS);
  });

  describe("safety and content filtering", () => {
    it("should map SAFETY to CONTENT_FILTER", () => {
      expect(STOP_REASON_MAP["SAFETY"]).toBe(StopReason.CONTENT_FILTER);
    });

    it("should map RECITATION to CONTENT_FILTER", () => {
      expect(STOP_REASON_MAP["RECITATION"]).toBe(StopReason.CONTENT_FILTER);
    });

    it("should map LANGUAGE to CONTENT_FILTER", () => {
      expect(STOP_REASON_MAP["LANGUAGE"]).toBe(StopReason.CONTENT_FILTER);
    });

    it("should map BLOCKLIST to CONTENT_FILTER", () => {
      expect(STOP_REASON_MAP["BLOCKLIST"]).toBe(StopReason.CONTENT_FILTER);
    });

    it("should map PROHIBITED_CONTENT to CONTENT_FILTER", () => {
      expect(STOP_REASON_MAP["PROHIBITED_CONTENT"]).toBe(StopReason.CONTENT_FILTER);
    });

    it("should map SPII to CONTENT_FILTER", () => {
      expect(STOP_REASON_MAP["SPII"]).toBe(StopReason.CONTENT_FILTER);
    });
  });

  describe("tool/function call related", () => {
    it("should map MALFORMED_FUNCTION_CALL to FORMAT_ERROR", () => {
      expect(STOP_REASON_MAP["MALFORMED_FUNCTION_CALL"]).toBe(StopReason.FORMAT_ERROR);
    });

    it("should map UNEXPECTED_TOOL_CALL to ERROR", () => {
      expect(STOP_REASON_MAP["UNEXPECTED_TOOL_CALL"]).toBe(StopReason.ERROR);
    });

    it("should map TOO_MANY_TOOL_CALLS to ERROR", () => {
      expect(STOP_REASON_MAP["TOO_MANY_TOOL_CALLS"]).toBe(StopReason.ERROR);
    });
  });

  describe("image generation related", () => {
    it("should map IMAGE_SAFETY to CONTENT_FILTER", () => {
      expect(STOP_REASON_MAP["IMAGE_SAFETY"]).toBe(StopReason.CONTENT_FILTER);
    });

    it("should map IMAGE_PROHIBITED_CONTENT to CONTENT_FILTER", () => {
      expect(STOP_REASON_MAP["IMAGE_PROHIBITED_CONTENT"]).toBe(StopReason.CONTENT_FILTER);
    });

    it("should map IMAGE_OTHER to OTHER", () => {
      expect(STOP_REASON_MAP["IMAGE_OTHER"]).toBe(StopReason.OTHER);
    });

    it("should map NO_IMAGE to NO_CONTENT", () => {
      expect(STOP_REASON_MAP["NO_IMAGE"]).toBe(StopReason.NO_CONTENT);
    });

    it("should map IMAGE_RECITATION to CONTENT_FILTER", () => {
      expect(STOP_REASON_MAP["IMAGE_RECITATION"]).toBe(StopReason.CONTENT_FILTER);
    });
  });

  describe("other reasons", () => {
    it("should map OTHER to OTHER", () => {
      expect(STOP_REASON_MAP["OTHER"]).toBe(StopReason.OTHER);
    });

    it("should map MISSING_THOUGHT_SIGNATURE to ERROR", () => {
      expect(STOP_REASON_MAP["MISSING_THOUGHT_SIGNATURE"]).toBe(StopReason.ERROR);
    });
  });
});

describe("mapGoogleFinishReason", () => {
  it("should return STOP for undefined", () => {
    expect(mapGoogleFinishReason(undefined)).toBe(StopReason.STOP);
  });

  it("should map known finish reasons via STOP_REASON_MAP", () => {
    expect(mapGoogleFinishReason("STOP" as any)).toBe(StopReason.STOP);
    expect(mapGoogleFinishReason("MAX_TOKENS" as any)).toBe(StopReason.MAX_TOKENS);
    expect(mapGoogleFinishReason("SAFETY" as any)).toBe(StopReason.CONTENT_FILTER);
  });

  it("should return STOP for unknown finish reasons", () => {
    expect(mapGoogleFinishReason("UNKNOWN_REASON" as any)).toBe(StopReason.STOP);
  });
});

// =============================================================================
// Client Options Building
// =============================================================================

describe("buildClientOptions", () => {
  it("should return empty object for empty config", () => {
    const result = buildClientOptions({});
    expect(result).toEqual({});
  });

  it("should include apiKey when provided", () => {
    const result = buildClientOptions({ apiKey: "test-api-key" });
    expect(result.apiKey).toBe("test-api-key");
  });

  describe("vertexai configuration", () => {
    it("should set vertexai flag", () => {
      const result = buildClientOptions({ vertexai: true });
      expect(result.vertexai).toBe(true);
    });

    it("should include project when vertexai is true", () => {
      const result = buildClientOptions({
        vertexai: true,
        project: "my-project",
      });
      expect(result.vertexai).toBe(true);
      expect(result.project).toBe("my-project");
    });

    it("should include location when vertexai is true", () => {
      const result = buildClientOptions({
        vertexai: true,
        location: "us-central1",
      });
      expect(result.vertexai).toBe(true);
      expect(result.location).toBe("us-central1");
    });

    it("should not include project/location without vertexai flag", () => {
      const result = buildClientOptions({
        project: "my-project",
        location: "us-central1",
      });
      expect(result.project).toBeUndefined();
      expect(result.location).toBeUndefined();
    });
  });

  describe("HTTP options", () => {
    it("should set httpOptions.timeout when timeout provided", () => {
      const result = buildClientOptions({ timeout: 30000 });
      expect(result.httpOptions).toEqual({ timeout: 30000 });
    });

    it("should set httpOptions.baseUrl when baseUrl provided", () => {
      const result = buildClientOptions({ baseUrl: "https://custom.api.com" });
      expect(result.httpOptions).toEqual({ baseUrl: "https://custom.api.com" });
    });

    it("should set both timeout and baseUrl", () => {
      const result = buildClientOptions({
        timeout: 30000,
        baseUrl: "https://custom.api.com",
      });
      expect(result.httpOptions).toEqual({
        timeout: 30000,
        baseUrl: "https://custom.api.com",
      });
    });
  });

  it("should include googleAuthOptions when provided", () => {
    const authOptions = {
      keyFilename: "/path/to/key.json",
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    };
    const result = buildClientOptions({ googleAuthOptions: authOptions });
    expect(result.googleAuthOptions).toEqual(authOptions);
  });

  it("should merge providerOptions.google into options", () => {
    const result = buildClientOptions({
      providerOptions: {
        google: {
          customOption: "custom-value",
          anotherOption: 123,
        },
      },
    });
    expect(result.customOption).toBe("custom-value");
    expect(result.anotherOption).toBe(123);
  });

  it("should combine all options", () => {
    const result = buildClientOptions({
      apiKey: "test-key",
      vertexai: true,
      project: "my-project",
      location: "us-central1",
      timeout: 30000,
      googleAuthOptions: { keyFilename: "/path/to/key.json" },
    });

    expect(result.apiKey).toBe("test-key");
    expect(result.vertexai).toBe(true);
    expect(result.project).toBe("my-project");
    expect(result.location).toBe("us-central1");
    expect(result.httpOptions.timeout).toBe(30000);
    expect(result.googleAuthOptions.keyFilename).toBe("/path/to/key.json");
  });
});

// =============================================================================
// Content Block Transformation: Tentickle -> Google
// =============================================================================

describe("convertBlocksToGoogleParts", () => {
  describe("text blocks", () => {
    it("should convert single text block", () => {
      const blocks: ContentBlock[] = [{ type: "text", text: "Hello, world!" }];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ text: "Hello, world!" });
    });

    it("should convert multiple text blocks", () => {
      const blocks: ContentBlock[] = [
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
      ];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ text: "First" });
      expect(result[1]).toEqual({ text: "Second" });
    });

    it("should handle empty text", () => {
      const blocks: ContentBlock[] = [{ type: "text", text: "" }];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ text: "" });
    });
  });

  describe("image blocks", () => {
    it("should convert image with URL source to fileData", () => {
      const blocks: ContentBlock[] = [
        {
          type: "image",
          source: {
            type: "url",
            url: "https://example.com/image.png",
            mimeType: "image/png",
          },
          mimeType: "image/png",
        } as ImageBlock,
      ];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        fileData: {
          mimeType: "image/png",
          fileUri: "https://example.com/image.png",
        },
      });
    });

    it("should use default mime type for URL source", () => {
      const blocks: ContentBlock[] = [
        {
          type: "image",
          source: { type: "url", url: "https://example.com/image.jpg" },
          mimeType: "image/jpeg",
        } as ImageBlock,
      ];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result[0].fileData.mimeType).toBe("image/jpeg");
    });

    it("should convert image with base64 source to inlineData", () => {
      // Note: The implementation uses source.mimeType for base64, not block.mimeType
      // So we need to set it on the source
      const blocks: ContentBlock[] = [
        {
          type: "image",
          source: {
            type: "base64",
            data: "iVBORw0KGgoAAAANS...",
            mimeType: "image/png",
          },
          mimeType: "image/png",
        } as ImageBlock,
      ];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        inlineData: {
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANS...",
        },
      });
    });

    it("should use default mime type for base64 source", () => {
      const blocks: ContentBlock[] = [
        {
          type: "image",
          source: { type: "base64", data: "iVBORw0KGgoAAAANS..." },
          mimeType: "image/jpeg",
        } as ImageBlock,
      ];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result[0].inlineData.mimeType).toBe("image/jpeg");
    });

    it("should skip image with unsupported source type", () => {
      const blocks: ContentBlock[] = [
        {
          type: "image",
          source: { type: "gcs", bucket: "test", object: "image.png" } as any,
          mimeType: "image/png",
        } as ImageBlock,
      ];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result).toHaveLength(0);
    });
  });

  describe("tool_use blocks", () => {
    it("should convert tool_use block to functionCall", () => {
      const blocks: ContentBlock[] = [
        {
          type: "tool_use",
          toolUseId: "call-123",
          name: "calculator",
          input: { expression: "2+2" },
        } as ToolUseBlock,
      ];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        functionCall: {
          name: "calculator",
          args: { expression: "2+2" },
        },
      });
    });

    it("should handle tool_use with empty input", () => {
      const blocks: ContentBlock[] = [
        {
          type: "tool_use",
          toolUseId: "call-456",
          name: "get_time",
          input: {},
        } as ToolUseBlock,
      ];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result[0]).toEqual({
        functionCall: {
          name: "get_time",
          args: {},
        },
      });
    });

    it("should handle tool_use with complex input", () => {
      const blocks: ContentBlock[] = [
        {
          type: "tool_use",
          toolUseId: "call-789",
          name: "search",
          input: {
            query: "test",
            filters: { type: "article", date: "2024-01-01" },
            limit: 10,
          },
        } as ToolUseBlock,
      ];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result[0].functionCall.args).toEqual({
        query: "test",
        filters: { type: "article", date: "2024-01-01" },
        limit: 10,
      });
    });
  });

  describe("tool_result blocks", () => {
    it("should convert tool_result block to functionResponse", () => {
      const blocks: ContentBlock[] = [
        {
          type: "tool_result",
          toolUseId: "call-123",
          name: "calculator",
          content: [{ type: "text", text: "4" }],
        } as ToolResultBlock,
      ];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        functionResponse: {
          id: "call-123",
          name: "calculator",
          response: { result: "4" },
        },
      });
    });

    it("should join multiple text blocks in tool_result", () => {
      const blocks: ContentBlock[] = [
        {
          type: "tool_result",
          toolUseId: "call-123",
          name: "multi_result",
          content: [
            { type: "text", text: "Line 1" },
            { type: "text", text: "Line 2" },
          ],
        } as ToolResultBlock,
      ];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result[0].functionResponse.response.result).toBe("Line 1\nLine 2");
    });

    it("should JSON stringify non-text content in tool_result", () => {
      const blocks: ContentBlock[] = [
        {
          type: "tool_result",
          toolUseId: "call-123",
          name: "json_result",
          content: [{ type: "json", data: { key: "value" } } as any],
        } as ToolResultBlock,
      ];
      const result = convertBlocksToGoogleParts(blocks);

      // Should stringify the content array since no text blocks
      expect(result[0].functionResponse.response.result).toBe(
        JSON.stringify([{ type: "json", data: { key: "value" } }]),
      );
    });

    it("should handle empty tool_result content", () => {
      const blocks: ContentBlock[] = [
        {
          type: "tool_result",
          toolUseId: "call-123",
          name: "empty_result",
          content: [],
        } as ToolResultBlock,
      ];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result[0].functionResponse.response.result).toBe("[]");
    });

    it("should handle undefined tool_result content", () => {
      const blocks: ContentBlock[] = [
        {
          type: "tool_result",
          toolUseId: "call-123",
          name: "undefined_result",
        } as ToolResultBlock,
      ];
      const result = convertBlocksToGoogleParts(blocks);

      // When content is undefined, JSON.stringify(undefined) returns undefined
      expect(result[0].functionResponse.response.result).toBeUndefined();
    });
  });

  describe("mixed content", () => {
    it("should convert mixed block types", () => {
      const blocks: ContentBlock[] = [
        { type: "text", text: "Here is an image:" },
        {
          type: "image",
          source: {
            type: "url",
            url: "https://example.com/image.png",
            mimeType: "image/png",
          },
          mimeType: "image/png",
        } as ImageBlock,
        { type: "text", text: "What do you see?" },
      ];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ text: "Here is an image:" });
      expect(result[1]).toEqual({
        fileData: {
          mimeType: "image/png",
          fileUri: "https://example.com/image.png",
        },
      });
      expect(result[2]).toEqual({ text: "What do you see?" });
    });
  });

  describe("unknown block types", () => {
    it("should convert unknown block type to text as fallback", () => {
      const blocks = [{ type: "custom", data: "custom data" } as any];
      const result = convertBlocksToGoogleParts(blocks);

      expect(result).toHaveLength(1);
      // Should fall back to text representation
      expect(result[0].text).toBeDefined();
    });
  });
});

// =============================================================================
// Tool Definition Transformation
// =============================================================================

describe("mapToolDefinition", () => {
  describe("string tools", () => {
    it("should convert string tool to functionDeclarations", () => {
      const result = mapToolDefinition("simple_tool");

      expect(result).toEqual({
        functionDeclarations: [
          {
            name: "simple_tool",
            description: "",
            parameters: {},
          },
        ],
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
        functionDeclarations: [
          {
            name: "calculator",
            description: "Performs calculations",
            parameters: {
              type: "object",
              properties: {
                expression: { type: "string" },
              },
            },
          },
        ],
      });
    });

    it("should handle ToolDefinition without description", () => {
      const tool = {
        name: "no_desc",
        input: { type: "object" },
      };
      const result = mapToolDefinition(tool);

      expect(result.functionDeclarations[0].description).toBe("");
    });

    it("should handle ToolDefinition without input", () => {
      const tool = {
        name: "no_params",
        input: undefined,
      };
      const result = mapToolDefinition(tool);

      expect(result.functionDeclarations[0].parameters).toEqual({});
    });

    it("should merge providerOptions.google config", () => {
      const tool = {
        name: "with_provider",
        description: "Tool with provider options",
        input: { type: "object" },
        providerOptions: {
          google: {
            customGoogleOption: "value",
          },
        },
      };
      const result = mapToolDefinition(tool);

      expect(result.customGoogleOption).toBe("value");
      expect(result.functionDeclarations[0].name).toBe("with_provider");
    });

    it("should use custom functionDeclarations from providerOptions", () => {
      const tool = {
        name: "override",
        description: "Original",
        input: { type: "object" },
        providerOptions: {
          google: {
            functionDeclarations: [
              {
                name: "custom_override",
                description: "Custom",
                parameters: { type: "string" },
              },
            ],
          },
        },
      };
      const result = mapToolDefinition(tool);

      expect(result.functionDeclarations[0].name).toBe("custom_override");
      expect(result.functionDeclarations[0].description).toBe("Custom");
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

      expect(result.functionDeclarations[0]).toEqual({
        name: "tool-id",
        description: "Tool description",
        parameters: { type: "object", properties: {} },
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

      expect(result.functionDeclarations[0].name).toBe("preferred-id");
    });

    it("should fall back to name when id is missing", () => {
      const tool = {
        metadata: {
          name: "fallback-name",
          description: "Description",
        },
      };
      const result = mapToolDefinition(tool);

      expect(result.functionDeclarations[0].name).toBe("fallback-name");
    });

    it("should use 'unknown' when no id or name", () => {
      const tool = {
        metadata: {
          description: "Only description",
        },
      };
      const result = mapToolDefinition(tool);

      expect(result.functionDeclarations[0].name).toBe("unknown");
    });

    it("should handle missing metadata properties gracefully", () => {
      const tool = {
        metadata: {},
      };
      const result = mapToolDefinition(tool);

      expect(result.functionDeclarations[0]).toEqual({
        name: "unknown",
        description: "",
        parameters: {},
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

      expect(result.functionDeclarations[0]).toEqual({
        name: "direct-id",
        description: "Direct description",
        parameters: { type: "object" },
      });
    });
  });
});
