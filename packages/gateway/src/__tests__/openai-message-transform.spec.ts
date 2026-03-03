/**
 * OpenAI Message Transform Tests
 *
 * Pure function tests for converting between OpenAI chat completion
 * messages and agentick's Message/ContentBlock types.
 */

import { describe, it, expect } from "vitest";
import {
  fromOpenAIMessages,
  toOpenAITools,
  type OpenAIMessage,
} from "../plugins/openai-message-transform.js";

describe("fromOpenAIMessages", () => {
  it("converts system message", () => {
    const messages: OpenAIMessage[] = [{ role: "system", content: "You are a helpful assistant." }];
    const result = fromOpenAIMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toEqual([{ type: "text", text: "You are a helpful assistant." }]);
  });

  it("converts user message with string content", () => {
    const messages: OpenAIMessage[] = [{ role: "user", content: "Hello!" }];
    const result = fromOpenAIMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toEqual([{ type: "text", text: "Hello!" }]);
  });

  it("converts user message with multimodal content", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          { type: "image_url", image_url: { url: "https://example.com/img.png" } },
        ],
      },
    ];
    const result = fromOpenAIMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toHaveLength(2);
    expect(result[0].content[0]).toEqual({ type: "text", text: "What's in this image?" });
    expect(result[0].content[1]).toMatchObject({
      type: "image",
      source: { type: "url", url: "https://example.com/img.png" },
    });
  });

  it("converts assistant message with text content", () => {
    const messages: OpenAIMessage[] = [{ role: "assistant", content: "Here's the answer." }];
    const result = fromOpenAIMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toEqual([{ type: "text", text: "Here's the answer." }]);
  });

  it("converts assistant message with tool calls", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "search", arguments: '{"q":"test"}' },
          },
        ],
      },
    ];
    const result = fromOpenAIMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toEqual([
      {
        type: "tool_use",
        id: "call_123",
        name: "search",
        input: { q: "test" },
      },
    ]);
  });

  it("converts assistant message with both text and tool calls", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "assistant",
        content: "Let me search for that.",
        tool_calls: [
          {
            id: "call_456",
            type: "function",
            function: { name: "search", arguments: '{"q":"hello"}' },
          },
        ],
      },
    ];
    const result = fromOpenAIMessages(messages);
    expect(result[0].content).toHaveLength(2);
    expect(result[0].content[0]).toEqual({ type: "text", text: "Let me search for that." });
    expect(result[0].content[1]).toMatchObject({
      type: "tool_use",
      id: "call_456",
      name: "search",
    });
  });

  it("converts tool message to user message with tool_result", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "tool",
        tool_call_id: "call_123",
        name: "search",
        content: "Found 5 results",
      },
    ];
    const result = fromOpenAIMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toHaveLength(1);
    expect(result[0].content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "call_123",
      name: "search",
    });
  });

  it("handles empty/null user content", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: null },
      { role: "user", content: undefined },
    ];
    const result = fromOpenAIMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content).toEqual([{ type: "text", text: "" }]);
    expect(result[1].content).toEqual([{ type: "text", text: "" }]);
  });

  it("handles invalid tool call arguments JSON", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_bad",
            type: "function",
            function: { name: "broken", arguments: "not json{" },
          },
        ],
      },
    ];
    const result = fromOpenAIMessages(messages);
    expect(result[0].content[0]).toMatchObject({
      type: "tool_use",
      input: {}, // Falls back to empty object
    });
  });

  it("converts a full multi-turn conversation", () => {
    const messages: OpenAIMessage[] = [
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Search for cats" },
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "search", arguments: '{"q":"cats"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", name: "search", content: "Found cats" },
      { role: "assistant", content: "I found some cats!" },
    ];
    const result = fromOpenAIMessages(messages);
    expect(result).toHaveLength(5);
    expect(result.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant"]);
  });
});

describe("toOpenAITools", () => {
  it("converts tool definitions to OpenAI format", () => {
    const tools = [
      {
        name: "search",
        description: "Search the web",
        input: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
      },
    ];
    const result = toOpenAITools(tools);
    expect(result).toEqual([
      {
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
      },
    ]);
  });

  it("handles empty tools array", () => {
    expect(toOpenAITools([])).toEqual([]);
  });

  it("converts multiple tools", () => {
    const tools = [
      { name: "a", description: "Tool A", input: {} },
      { name: "b", description: "Tool B", input: {} },
    ];
    const result = toOpenAITools(tools);
    expect(result).toHaveLength(2);
    expect(result[0].function.name).toBe("a");
    expect(result[1].function.name).toBe("b");
  });
});
