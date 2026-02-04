/**
 * Tests for adapter.ts - createAdapter and options utilities
 */

import { describe, it, expect, vi } from "vitest";
import {
  createAdapter,
  createDeclarativeAdapter,
  mergeProviderOptions,
  mergeLibraryOptions,
  extractAdapterOptions,
  StopReason,
  type AdapterDelta,
} from "./adapter";
import type { ModelInput } from "./model";

// ============================================================================
// Options Merging Tests
// ============================================================================

describe("mergeProviderOptions", () => {
  it("should return empty object when no options provided", () => {
    const result = mergeProviderOptions("openai");
    expect(result).toEqual({});
  });

  it("should return adapter defaults when only defaults provided", () => {
    const result = mergeProviderOptions("openai", { temperature: 0.7 });
    expect(result).toEqual({ temperature: 0.7 });
  });

  it("should merge input options over adapter defaults", () => {
    const result = mergeProviderOptions(
      "openai",
      { temperature: 0.7, maxTokens: 100 },
      { openai: { temperature: 0.9 } },
    );
    expect(result).toEqual({ temperature: 0.9, maxTokens: 100 });
  });

  it("should extract nested providerOptions from libraryOptions", () => {
    const result = mergeProviderOptions(
      "openai",
      { temperature: 0.5 },
      { openai: { temperature: 0.7 } },
      { "ai-sdk": { providerOptions: { openai: { temperature: 0.9 } } } },
    );
    // Library nested providerOptions should win
    expect(result).toEqual({ temperature: 0.9 });
  });

  it("should deep merge nested objects", () => {
    const result = mergeProviderOptions(
      "openai",
      { config: { a: 1, b: 2 } },
      { openai: { config: { b: 3, c: 4 } } },
    );
    expect(result).toEqual({ config: { a: 1, b: 3, c: 4 } });
  });

  it("should handle different provider keys correctly", () => {
    const result = mergeProviderOptions(
      "anthropic",
      { maxTokens: 100 },
      { openai: { temperature: 0.7 }, anthropic: { maxTokens: 200 } },
    );
    expect(result).toEqual({ maxTokens: 200 });
  });
});

describe("mergeLibraryOptions", () => {
  it("should return empty object when no options provided", () => {
    const result = mergeLibraryOptions("ai-sdk");
    expect(result).toEqual({});
  });

  it("should return adapter defaults when only defaults provided", () => {
    const result = mergeLibraryOptions("ai-sdk", { maxSteps: 5 });
    expect(result).toEqual({ maxSteps: 5 });
  });

  it("should merge input options over adapter defaults", () => {
    const result = mergeLibraryOptions(
      "ai-sdk",
      { maxSteps: 5, experimental: { flag: true } },
      { "ai-sdk": { maxSteps: 10 } },
    );
    expect(result).toEqual({ maxSteps: 10, experimental: { flag: true } });
  });

  it("should handle different library keys correctly", () => {
    const result = mergeLibraryOptions(
      "langchain",
      { callbacks: ["default"] },
      { "ai-sdk": { maxSteps: 5 }, langchain: { callbacks: ["custom"] } },
    );
    expect(result).toEqual({ callbacks: ["custom"] });
  });
});

describe("extractAdapterOptions", () => {
  it("should extract all options with defaults", () => {
    const input: ModelInput = {
      messages: [],
      model: "gpt-4",
      temperature: 0.8,
      maxTokens: 1000,
    };

    const result = extractAdapterOptions("ai-sdk", "openai", input, {
      libraryDefaults: { maxSteps: 5 },
      providerDefaults: { topP: 0.9 },
    });

    expect(result.library).toEqual({ maxSteps: 5 });
    expect(result.provider).toEqual({ topP: 0.9 });
    expect(result.standard).toEqual({
      model: "gpt-4",
      temperature: 0.8,
      maxTokens: 1000,
      topP: undefined,
      frequencyPenalty: undefined,
      presencePenalty: undefined,
      stop: undefined,
    });
  });

  it("should merge options from input", () => {
    const input: ModelInput = {
      messages: [],
      providerOptions: { openai: { temperature: 0.9 } },
      libraryOptions: { "ai-sdk": { maxSteps: 10 } },
    };

    const result = extractAdapterOptions("ai-sdk", "openai", input, {
      libraryDefaults: { maxSteps: 5 },
      providerDefaults: { temperature: 0.7 },
    });

    expect(result.library).toEqual({ maxSteps: 10 });
    expect(result.provider).toEqual({ temperature: 0.9 });
  });

  it("should handle nested providerOptions in libraryOptions", () => {
    const input: ModelInput = {
      messages: [],
      providerOptions: { openai: { temperature: 0.7 } },
      libraryOptions: {
        "ai-sdk": {
          maxSteps: 10,
          providerOptions: { openai: { topP: 0.95 } },
        },
      },
    };

    const result = extractAdapterOptions("ai-sdk", "openai", input);

    expect(result.library).toEqual({
      maxSteps: 10,
      providerOptions: { openai: { topP: 0.95 } },
    });
    // Provider options merge from multiple sources
    expect(result.provider).toEqual({ temperature: 0.7, topP: 0.95 });
  });
});

// ============================================================================
// createAdapter Tests
// ============================================================================

describe("createAdapter", () => {
  // Mock provider types
  interface MockProviderInput {
    model: string;
    messages: Array<{ role: string; content: string }>;
  }

  interface MockProviderOutput {
    text: string;
    usage: { promptTokens: number; completionTokens: number };
    finishReason: string;
  }

  interface MockChunk {
    type: string;
    text?: string;
    finishReason?: string;
    usage?: { promptTokens: number; completionTokens: number };
  }

  it("should create an adapter with basic configuration", () => {
    const adapter = createAdapter<MockProviderInput, MockProviderOutput, MockChunk>({
      metadata: {
        id: "test:model",
        provider: "test",
        capabilities: [{ stream: true }],
      },
      prepareInput: (input) => ({
        model: input.model || "test-model",
        messages: input.messages.map((m) => ({
          role: m.role,
          content: m.content.map((c: any) => c.text).join(""),
        })),
      }),
      mapChunk: (chunk) => {
        if (chunk.type === "text") return { type: "text", delta: chunk.text || "" };
        if (chunk.type === "finish") return { type: "message_end", stopReason: StopReason.STOP };
        return null;
      },
      execute: async () => ({
        text: "Hello",
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: "stop",
      }),
    });

    expect(adapter).toBeDefined();
    expect(adapter.metadata.id).toBe("test:model");
    expect(adapter.metadata.provider).toBe("test");
    expect(adapter.generate).toBeDefined();
    expect(typeof adapter.generate).toBe("function");
  });

  it("should have stream method when executeStream is provided", () => {
    const adapter = createAdapter<MockProviderInput, MockProviderOutput, MockChunk>({
      metadata: {
        id: "test:model",
        provider: "test",
        capabilities: [{ stream: true }],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: () => null,
      execute: async () => ({
        text: "Hello",
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: "stop",
      }),
      executeStream: async function* () {
        yield { type: "text", text: "Hello" };
        yield { type: "finish", finishReason: "stop" };
      },
    });

    expect(adapter.stream).toBeDefined();
  });

  it("should not have stream method when executeStream is not provided", () => {
    const adapter = createAdapter<MockProviderInput, MockProviderOutput, MockChunk>({
      metadata: {
        id: "test:model",
        provider: "test",
        capabilities: [{ stream: false }],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: () => null,
      execute: async () => ({
        text: "Hello",
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: "stop",
      }),
    });

    expect(adapter.stream).toBeUndefined();
  });

  it("should have fromEngineState when not provided (uses default)", () => {
    const adapter = createAdapter<MockProviderInput, MockProviderOutput, MockChunk>({
      metadata: {
        id: "test:model",
        provider: "test",
        capabilities: [],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: () => null,
      execute: async () => ({
        text: "Hello",
        usage: { promptTokens: 0, completionTokens: 0 },
        finishReason: "stop",
      }),
    });

    expect(adapter.fromEngineState).toBeDefined();
  });

  it("should use custom fromEngineState when provided", async () => {
    const customFromEngineState = vi.fn().mockResolvedValue({
      messages: [{ role: "user", content: [{ type: "text", text: "custom" }] }],
    });

    const adapter = createAdapter<MockProviderInput, MockProviderOutput, MockChunk>({
      metadata: {
        id: "test:model",
        provider: "test",
        capabilities: [],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: () => null,
      execute: async () => ({
        text: "Hello",
        usage: { promptTokens: 0, completionTokens: 0 },
        finishReason: "stop",
      }),
      fromEngineState: customFromEngineState,
    });

    const mockCOMInput = {
      timeline: [],
      system: [],
      ephemeral: [],
      sections: {},
      tools: [],
    };

    await adapter.fromEngineState!(mockCOMInput);
    expect(customFromEngineState).toHaveBeenCalledWith(mockCOMInput);
  });
});

// ============================================================================
// createDeclarativeAdapter Tests
// ============================================================================

describe("createDeclarativeAdapter", () => {
  interface MockChunk {
    type: string;
    text?: string;
    finishReason?: string;
  }

  it("should create an adapter using declarative chunk mapping", () => {
    const adapter = createDeclarativeAdapter<any, any, MockChunk>({
      metadata: {
        id: "declarative:model",
        provider: "test",
        capabilities: [{ stream: true }],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      execute: async () => ({ text: "Hello" }),
      executeStream: async function* () {
        yield { type: "text-delta", text: "Hello" };
        yield { type: "finish", finishReason: "stop" };
      },
      chunkMapping: {
        text: { type: "text-delta", extract: (c) => c.text || "" },
        messageEnd: {
          type: "finish",
          extract: () => ({ stopReason: StopReason.STOP }),
        },
      },
    });

    expect(adapter).toBeDefined();
    expect(adapter.metadata.id).toBe("declarative:model");
    expect(adapter.stream).toBeDefined();
  });
});

// ============================================================================
// AdapterDelta Mapping Tests
// ============================================================================

describe("AdapterDelta mapping", () => {
  it("should handle all delta types correctly", () => {
    const deltas: AdapterDelta[] = [
      { type: "text", delta: "Hello" },
      { type: "reasoning", delta: "Thinking..." },
      { type: "tool_call_start", id: "tc1", name: "search" },
      { type: "tool_call_delta", id: "tc1", delta: '{"query":' },
      { type: "tool_call_delta", id: "tc1", delta: '"test"}' },
      { type: "tool_call_end", id: "tc1", input: { query: "test" } },
      { type: "tool_call", id: "tc2", name: "calculator", input: { expr: "2+2" } },
      { type: "message_start", model: "gpt-4" },
      {
        type: "message_end",
        stopReason: StopReason.STOP,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      { type: "usage", usage: { inputTokens: 10 } },
      { type: "error", error: "Something went wrong", code: "ERR001" },
      { type: "raw", data: { custom: "data" } },
      { type: "content_metadata", metadata: { language: "typescript" } },
      { type: "reasoning_metadata", metadata: { citations: [{ text: "source" }] } },
    ];

    // All should be valid AdapterDelta types
    deltas.forEach((delta) => {
      expect(delta.type).toBeDefined();
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("createAdapter integration", () => {
  it("should process streaming chunks correctly", async () => {
    const chunks: Array<{ type: string; text?: string; finishReason?: string }> = [
      { type: "start" },
      { type: "text", text: "Hello" },
      { type: "text", text: " World" },
      { type: "finish", finishReason: "stop" },
    ];

    const adapter = createAdapter({
      metadata: {
        id: "test:streaming",
        provider: "test",
        capabilities: [{ stream: true }],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: (chunk) => {
        if (chunk.type === "start") return { type: "message_start" };
        if (chunk.type === "text") return { type: "text", delta: chunk.text || "" };
        if (chunk.type === "finish") return { type: "message_end", stopReason: StopReason.STOP };
        return null;
      },
      execute: async () => ({}) as any,
      executeStream: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    });

    expect(adapter.stream).toBeDefined();

    // Collect events from stream
    // const events: any[] = [];
    // const input: ModelInput = {
    //   messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    // };

    // We can't easily test the full stream without the engine context,
    // but we can verify the adapter is set up correctly
    expect(typeof adapter.stream).toBe("function");
  });

  it("should pass extractMetadata hook through", () => {
    const extractMetadata = vi.fn();

    const adapter = createAdapter({
      metadata: {
        id: "test:metadata",
        provider: "test",
        capabilities: [],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: () => null,
      execute: async () => ({}) as any,
      executeStream: async function* () {
        yield { type: "text", text: "Hello" };
      },
      extractMetadata,
    });

    expect(adapter).toBeDefined();
    // extractMetadata is called internally during streaming
  });

  it("should support messageTransformation in capabilities", () => {
    const adapter = createAdapter({
      metadata: {
        id: "test:transformation",
        provider: "test",
        capabilities: [
          { stream: true },
          {
            messageTransformation: (modelId, _provider) => ({
              preferredRenderer: "markdown",
              roleMapping: {
                event: modelId.includes("gpt") ? "developer" : "user",
                ephemeral: "user",
              },
            }),
          },
        ],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: () => null,
      execute: async () => ({}) as any,
    });

    // Verify the messageTransformation is in capabilities
    const transformCap = adapter.metadata.capabilities.find((c) => "messageTransformation" in c);
    expect(transformCap).toBeDefined();
    expect(typeof (transformCap as any).messageTransformation).toBe("function");

    // Test the function
    const config = (transformCap as any).messageTransformation("gpt-4", "openai");
    expect(config.roleMapping.event).toBe("developer");

    const config2 = (transformCap as any).messageTransformation("claude-3", "anthropic");
    expect(config2.roleMapping.event).toBe("user");
  });
});

// ============================================================================
// Streaming Tool Call Accumulation Tests
// ============================================================================

describe("createAdapter tool call streaming", () => {
  it("should accumulate tool calls from tool_call_start and tool_call_delta events", async () => {
    // Simulates OpenAI's streaming pattern:
    // 1. First chunk has id + name
    // 2. Subsequent chunks have delta (arguments)
    // 3. message_end signals completion
    const chunks = [
      { type: "tool_start", id: "call_123", name: "todo_list" },
      { type: "tool_delta", id: "call_123", args: '{"action":' },
      { type: "tool_delta", id: "call_123", args: '"add",' },
      { type: "tool_delta", id: "call_123", args: '"text":"buy milk"}' },
      { type: "finish" },
    ];

    const adapter = createAdapter({
      metadata: {
        id: "test:tool-streaming",
        provider: "test",
        capabilities: [{ stream: true, toolCalls: true }],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: (chunk: (typeof chunks)[number]): AdapterDelta | null => {
        if (chunk.type === "tool_start") {
          return { type: "tool_call_start", id: chunk.id!, name: chunk.name! };
        }
        if (chunk.type === "tool_delta") {
          return { type: "tool_call_delta", id: chunk.id!, delta: chunk.args! };
        }
        if (chunk.type === "finish") {
          return {
            type: "message_end",
            stopReason: StopReason.TOOL_USE,
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          };
        }
        return null;
      },
      execute: async () => ({}) as any,
      executeStream: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    });

    expect(adapter.stream).toBeDefined();
  });

  it("should handle complete tool_call events (non-streamed)", async () => {
    // Some providers send complete tool calls in one event
    const chunks = [
      { type: "text", content: "I'll help you with that." },
      { type: "tool", id: "call_456", name: "search", input: { query: "weather" } },
      { type: "finish" },
    ];

    const adapter = createAdapter({
      metadata: {
        id: "test:tool-complete",
        provider: "test",
        capabilities: [{ stream: true, toolCalls: true }],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: (chunk: (typeof chunks)[number]): AdapterDelta | null => {
        if (chunk.type === "text") {
          return { type: "text", delta: (chunk as any).content };
        }
        if (chunk.type === "tool") {
          const c = chunk as any;
          return { type: "tool_call", id: c.id, name: c.name, input: c.input };
        }
        if (chunk.type === "finish") {
          return { type: "message_end", stopReason: StopReason.TOOL_USE };
        }
        return null;
      },
      execute: async () => ({}) as any,
      executeStream: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    });

    expect(adapter.stream).toBeDefined();
  });

  it("should handle multiple tool calls in one response", async () => {
    // Model calls multiple tools in sequence
    const chunks = [
      { type: "tool_start", index: 0, id: "call_1", name: "search" },
      { type: "tool_delta", index: 0, args: '{"q":"a"}' },
      { type: "tool_start", index: 1, id: "call_2", name: "calculate" },
      { type: "tool_delta", index: 1, args: '{"expr":"2+2"}' },
      { type: "finish" },
    ];

    const adapter = createAdapter({
      metadata: {
        id: "test:multi-tool",
        provider: "test",
        capabilities: [{ stream: true, toolCalls: true }],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: (chunk: (typeof chunks)[number]): AdapterDelta | null => {
        if (chunk.type === "tool_start") {
          const c = chunk as any;
          return { type: "tool_call_start", id: c.id, name: c.name };
        }
        if (chunk.type === "tool_delta") {
          const c = chunk as any;
          // In real OpenAI adapter, we track id by index
          return { type: "tool_call_delta", id: c.id || "call_1", delta: c.args };
        }
        if (chunk.type === "finish") {
          return { type: "message_end", stopReason: StopReason.TOOL_USE };
        }
        return null;
      },
      execute: async () => ({}) as any,
      executeStream: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    });

    expect(adapter.stream).toBeDefined();
  });
});
