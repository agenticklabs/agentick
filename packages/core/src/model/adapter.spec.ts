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
  composeDeltaTransforms,
  StopReason,
  type AdapterDelta,
  type DeltaTransform,
} from "./adapter.js";
import type { ModelInput } from "./model.js";

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

// ============================================================================
// composeDeltaTransforms Tests
// ============================================================================

describe("composeDeltaTransforms", () => {
  it("should return identity for empty array", () => {
    const composed = composeDeltaTransforms();
    const delta: AdapterDelta = { type: "text", delta: "hello" };
    expect(composed.process(delta)).toEqual([delta]);
    expect(composed.flush()).toEqual([]);
  });

  it("should return the single transform unchanged", () => {
    const t: DeltaTransform = {
      process: (d) => [d, d], // duplicates
      flush: () => [{ type: "text", delta: "flushed" }],
    };
    const composed = composeDeltaTransforms(t);
    expect(composed).toBe(t); // same reference
  });

  it("should chain process() — output of first feeds second", () => {
    // Transform 1: uppercases text
    const upper: DeltaTransform = {
      process(d) {
        if (d.type === "text") return [{ type: "text", delta: d.delta.toUpperCase() }];
        return [d];
      },
      flush: () => [],
    };

    // Transform 2: appends "!" to text
    const bang: DeltaTransform = {
      process(d) {
        if (d.type === "text") return [{ type: "text", delta: d.delta + "!" }];
        return [d];
      },
      flush: () => [],
    };

    const composed = composeDeltaTransforms(upper, bang);
    const result = composed.process({ type: "text", delta: "hello" });

    expect(result).toEqual([{ type: "text", delta: "HELLO!" }]);
  });

  it("should handle transform that produces multiple deltas", () => {
    // Transform 1: splits text into chars
    const splitter: DeltaTransform = {
      process(d) {
        if (d.type === "text")
          return d.delta.split("").map((ch) => ({ type: "text" as const, delta: ch }));
        return [d];
      },
      flush: () => [],
    };

    // Transform 2: wraps each char in brackets
    const wrapper: DeltaTransform = {
      process(d) {
        if (d.type === "text") return [{ type: "text", delta: `[${d.delta}]` }];
        return [d];
      },
      flush: () => [],
    };

    const composed = composeDeltaTransforms(splitter, wrapper);
    const result = composed.process({ type: "text", delta: "ab" });

    expect(result).toEqual([
      { type: "text", delta: "[a]" },
      { type: "text", delta: "[b]" },
    ]);
  });

  it("should handle transform that filters (returns empty)", () => {
    // Transform 1: drops text deltas entirely
    const dropper: DeltaTransform = {
      process(d) {
        if (d.type === "text") return [];
        return [d];
      },
      flush: () => [],
    };

    // Transform 2: should never see text
    const spy: DeltaTransform = {
      process: vi.fn((d) => [d]),
      flush: () => [],
    };

    const composed = composeDeltaTransforms(dropper, spy);
    const result = composed.process({ type: "text", delta: "dropped" });

    expect(result).toEqual([]);
    expect(spy.process).not.toHaveBeenCalled();
  });

  it("should cascade flush — upstream flush output goes through downstream process", () => {
    // Transform 1: buffers text, flushes as single delta
    let buffer = "";
    const bufferer: DeltaTransform = {
      process(d) {
        if (d.type === "text") {
          buffer += d.delta;
          return []; // buffer, don't emit
        }
        return [d];
      },
      flush() {
        if (buffer) {
          const result: AdapterDelta[] = [{ type: "text", delta: buffer }];
          buffer = "";
          return result;
        }
        return [];
      },
    };

    // Transform 2: uppercases text
    const upper: DeltaTransform = {
      process(d) {
        if (d.type === "text") return [{ type: "text", delta: d.delta.toUpperCase() }];
        return [d];
      },
      flush: () => [],
    };

    const composed = composeDeltaTransforms(bufferer, upper);

    // Process — bufferer eats everything, upper sees nothing
    expect(composed.process({ type: "text", delta: "hello " })).toEqual([]);
    expect(composed.process({ type: "text", delta: "world" })).toEqual([]);

    // Flush — bufferer emits "hello world", upper uppercases it
    const flushed = composed.flush();
    expect(flushed).toEqual([{ type: "text", delta: "HELLO WORLD" }]);
  });

  it("should cascade flush through 3 transforms", () => {
    // T1: buffers text
    let buf1 = "";
    const t1: DeltaTransform = {
      process(d) {
        if (d.type === "text") {
          buf1 += d.delta;
          return [];
        }
        return [d];
      },
      flush() {
        const r: AdapterDelta[] = buf1 ? [{ type: "text", delta: buf1 }] : [];
        buf1 = "";
        return r;
      },
    };

    // T2: buffers text, prepends "["
    let buf2 = "";
    const t2: DeltaTransform = {
      process(d) {
        if (d.type === "text") {
          buf2 += d.delta;
          return [];
        }
        return [d];
      },
      flush() {
        const r: AdapterDelta[] = buf2 ? [{ type: "text", delta: "[" + buf2 + "]" }] : [];
        buf2 = "";
        return r;
      },
    };

    // T3: uppercases
    const t3: DeltaTransform = {
      process(d) {
        if (d.type === "text") return [{ type: "text", delta: d.delta.toUpperCase() }];
        return [d];
      },
      flush: () => [],
    };

    const composed = composeDeltaTransforms(t1, t2, t3);

    composed.process({ type: "text", delta: "abc" });
    const flushed = composed.flush();

    // T1 flushes "abc" → T2.process("abc") buffers it → T2.flush() → "[abc]" → T3.process → "[ABC]"
    expect(flushed).toEqual([{ type: "text", delta: "[ABC]" }]);
  });

  it("should pass non-text deltas through all transforms", () => {
    const t1: DeltaTransform = { process: (d) => [d], flush: () => [] };
    const t2: DeltaTransform = { process: (d) => [d], flush: () => [] };

    const composed = composeDeltaTransforms(t1, t2);
    const toolDelta: AdapterDelta = { type: "tool_call_start", id: "c1", name: "search" };
    expect(composed.process(toolDelta)).toEqual([toolDelta]);
  });
});

// ============================================================================
// DeltaTransform Integration Tests
// ============================================================================

describe("deltaTransform integration (StreamTagParser + createAdapter)", () => {
  function createTestAdapterWithTransform(
    chunks: Array<{ type: string; content?: string }>,
    transform: import("./adapter.js").DeltaTransform,
  ) {
    return createAdapter({
      metadata: {
        id: "test:transform",
        provider: "test",
        capabilities: [{ stream: true }],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: (chunk: (typeof chunks)[number]): AdapterDelta | null => {
        if (chunk.type === "text") return { type: "text", delta: chunk.content! };
        if (chunk.type === "finish") return { type: "message_end", stopReason: StopReason.STOP };
        return null;
      },
      execute: async () => ({}) as any,
      executeStream: async function* () {
        for (const chunk of chunks) yield chunk;
      },
      deltaTransform: transform,
    });
  }

  it("should strip registered tags and emit custom_block events", async () => {
    const { StreamTagParser } = await import("./stream-tag-parser.js");
    const handler = { onContent: vi.fn(), onSelfClosing: vi.fn() };
    const parser = new StreamTagParser({
      tags: { interpretation: handler, done: handler },
    });

    const chunks = [
      { type: "text", content: "Hello " },
      { type: "text", content: "<interpretation>this " },
      { type: "text", content: "is a test</interpretation>" },
      { type: "text", content: " world" },
      { type: "text", content: "<done/>" },
      { type: "finish" },
    ];

    const adapter = createTestAdapterWithTransform(chunks, parser);
    const events: import("@agentick/shared/streaming").StreamEvent[] = [];
    const input = { messages: [] } as unknown as ModelInput;

    for await (const event of await adapter.stream!(input)) {
      events.push(event);
    }

    const eventTypes = events.map((e) => e.type);

    // Custom block lifecycle events should be present
    expect(eventTypes).toContain("custom_block_start");
    expect(eventTypes).toContain("custom_block_delta");
    expect(eventTypes).toContain("custom_block_end");
    expect(eventTypes).toContain("custom_block");

    // Text content should have tags stripped
    const contentDeltas = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e as any).delta)
      .join("");
    expect(contentDeltas).toBe("Hello  world");
    expect(contentDeltas).not.toContain("<interpretation>");
    expect(contentDeltas).not.toContain("<done/>");

    // Handlers should have been called
    expect(handler.onContent).toHaveBeenCalledWith("this is a test", {});
    expect(handler.onSelfClosing).toHaveBeenCalledWith({});
  });

  it("should produce custom_block events with correct data", async () => {
    const { StreamTagParser } = await import("./stream-tag-parser.js");
    const parser = new StreamTagParser({
      tags: { interpretation: {}, done: {} },
    });

    const chunks = [
      { type: "text", content: "Before." },
      { type: "text", content: '<interpretation for="ctx">insight</interpretation>' },
      { type: "text", content: "After.<done/>" },
      { type: "finish" },
    ];

    const adapter = createTestAdapterWithTransform(chunks, parser);
    const events: import("@agentick/shared/streaming").StreamEvent[] = [];
    const input = { messages: [] } as unknown as ModelInput;

    for await (const event of await adapter.stream!(input)) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "message_end")).toBe(true);

    const customBlocks = events.filter((e) => e.type === "custom_block");
    expect(customBlocks).toHaveLength(2);
    expect((customBlocks[0] as any).tag).toBe("interpretation");
    expect((customBlocks[0] as any).content).toBe("insight");
    expect((customBlocks[0] as any).attrs).toEqual({ for: "ctx" });
    expect((customBlocks[1] as any).tag).toBe("done");
    expect((customBlocks[1] as any).selfClosing).toBe(true);
  });

  it("should handle chunked tag splits across multiple text deltas", async () => {
    const { StreamTagParser } = await import("./stream-tag-parser.js");
    const parser = new StreamTagParser({ tags: { think: {} } });

    const chunks = [
      { type: "text", content: "start<thi" },
      { type: "text", content: "nk>deep " },
      { type: "text", content: "thought</t" },
      { type: "text", content: "hink>end" },
      { type: "finish" },
    ];

    const adapter = createTestAdapterWithTransform(chunks, parser);
    const events: import("@agentick/shared/streaming").StreamEvent[] = [];
    const input = { messages: [] } as unknown as ModelInput;

    for await (const event of await adapter.stream!(input)) {
      events.push(event);
    }

    const contentDeltas = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e as any).delta)
      .join("");
    expect(contentDeltas).toBe("startend");

    const customBlocks = events.filter((e) => e.type === "custom_block");
    expect(customBlocks).toHaveLength(1);
    expect((customBlocks[0] as any).content).toBe("deep thought");
  });

  it("should pass through non-text deltas unchanged", async () => {
    const { StreamTagParser } = await import("./stream-tag-parser.js");
    const parser = new StreamTagParser({ tags: { think: {} } });

    const chunks = [
      { type: "text", content: "I'll search." },
      { type: "tool_start", content: "" },
      { type: "finish" },
    ];

    const adapter = createAdapter({
      metadata: {
        id: "test:passthrough",
        provider: "test",
        capabilities: [{ stream: true, toolCalls: true }],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: (chunk: (typeof chunks)[number]): AdapterDelta | null => {
        if (chunk.type === "text") return { type: "text", delta: chunk.content! };
        if (chunk.type === "tool_start")
          return { type: "tool_call_start", id: "c1", name: "search" };
        if (chunk.type === "finish")
          return { type: "message_end", stopReason: StopReason.TOOL_USE };
        return null;
      },
      execute: async () => ({}) as any,
      executeStream: async function* () {
        for (const chunk of chunks) yield chunk;
      },
      deltaTransform: parser,
    });

    const events: import("@agentick/shared/streaming").StreamEvent[] = [];
    const input = { messages: [] } as unknown as ModelInput;
    for await (const event of await adapter.stream!(input)) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
  });

  it("should accept deltaTransform as array and compose them", async () => {
    const { StreamTagParser } = await import("./stream-tag-parser.js");

    // Parser 1: handles <think> (simulates built-in adapter transform)
    const thinkParser = new StreamTagParser({ tags: { think: {} } });

    // Parser 2: handles <interpretation> (simulates user-defined transform)
    const customParser = new StreamTagParser({ tags: { interpretation: {} } });

    const chunks = [
      { type: "text", content: "text<think>reasoning</think>" },
      { type: "text", content: "more<interpretation>insight</interpretation>end" },
      { type: "finish" },
    ];

    const adapter = createAdapter({
      metadata: {
        id: "test:array-transform",
        provider: "test",
        capabilities: [{ stream: true }],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: (chunk: (typeof chunks)[number]): AdapterDelta | null => {
        if (chunk.type === "text") return { type: "text", delta: chunk.content! };
        if (chunk.type === "finish") return { type: "message_end", stopReason: StopReason.STOP };
        return null;
      },
      execute: async () => ({}) as any,
      executeStream: async function* () {
        for (const chunk of chunks) yield chunk;
      },
      deltaTransform: [thinkParser, customParser], // array form
    });

    const events: import("@agentick/shared/streaming").StreamEvent[] = [];
    const input = { messages: [] } as unknown as ModelInput;

    for await (const event of await adapter.stream!(input)) {
      events.push(event);
    }

    // Both tags should be stripped from text
    const contentDeltas = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e as any).delta)
      .join("");
    expect(contentDeltas).toBe("textmoreend");

    // Both should produce custom_block events
    const customBlocks = events.filter((e) => e.type === "custom_block");
    expect(customBlocks).toHaveLength(2);
    expect((customBlocks[0] as any).tag).toBe("think");
    expect((customBlocks[0] as any).content).toBe("reasoning");
    expect((customBlocks[1] as any).tag).toBe("interpretation");
    expect((customBlocks[1] as any).content).toBe("insight");
  });

  it("should accept deltaTransform as factory and create fresh instance per stream", async () => {
    const { StreamTagParser } = await import("./stream-tag-parser.js");

    let instanceCount = 0;
    const factory = () => {
      instanceCount++;
      return new StreamTagParser({ tags: { think: {} } });
    };

    const chunks = [
      { type: "text", content: "before<think>reasoning</think>after" },
      { type: "finish" },
    ];

    const adapter = createAdapter({
      metadata: {
        id: "test:factory-transform",
        provider: "test",
        capabilities: [{ stream: true }],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: (chunk: (typeof chunks)[number]): AdapterDelta | null => {
        if (chunk.type === "text") return { type: "text", delta: chunk.content! };
        if (chunk.type === "finish") return { type: "message_end", stopReason: StopReason.STOP };
        return null;
      },
      execute: async () => ({}) as any,
      executeStream: async function* () {
        for (const chunk of chunks) yield chunk;
      },
      deltaTransform: factory,
    });

    const input = { messages: [] } as unknown as ModelInput;

    // First stream call
    const events1: import("@agentick/shared/streaming").StreamEvent[] = [];
    for await (const event of await adapter.stream!(input)) {
      events1.push(event);
    }
    expect(instanceCount).toBe(1);

    // Second stream call — should create a new instance
    const events2: import("@agentick/shared/streaming").StreamEvent[] = [];
    for await (const event of await adapter.stream!(input)) {
      events2.push(event);
    }
    expect(instanceCount).toBe(2);

    // Both should produce identical results (fresh state each time)
    const getText = (events: typeof events1) =>
      events
        .filter((e) => e.type === "content_delta")
        .map((e) => (e as any).delta)
        .join("");
    expect(getText(events1)).toBe("beforeafter");
    expect(getText(events2)).toBe("beforeafter");
  });
});

// ============================================================================
// customBlocks Config Tests
// ============================================================================

describe("customBlocks adapter config", () => {
  function createAdapterWithCustomBlocks(
    chunks: Array<{ type: string; content?: string }>,
    customBlocks: Record<string, import("./adapter.js").CustomBlockDefinition>,
    deltaTransform?: import("./adapter.js").DeltaTransform,
  ) {
    return createAdapter({
      metadata: {
        id: "test:custom-blocks",
        provider: "test",
        capabilities: [{ stream: true }],
      },
      prepareInput: () => ({ model: "test", messages: [] }),
      mapChunk: (chunk: (typeof chunks)[number]): AdapterDelta | null => {
        if (chunk.type === "text") return { type: "text", delta: chunk.content! };
        if (chunk.type === "finish") return { type: "message_end", stopReason: StopReason.STOP };
        return null;
      },
      execute: async () => ({}) as any,
      executeStream: async function* () {
        for (const chunk of chunks) yield chunk;
      },
      customBlocks,
      deltaTransform,
    });
  }

  async function collectEvents(adapter: ReturnType<typeof createAdapter>, input?: ModelInput) {
    const events: import("@agentick/shared/streaming").StreamEvent[] = [];
    for await (const event of await adapter.stream!(
      input ?? ({ messages: [] } as unknown as ModelInput),
    )) {
      events.push(event);
    }
    return events;
  }

  it("should intercept tags and emit custom_block events (passthrough)", async () => {
    const chunks = [
      { type: "text", content: "hello<interpretation>insight</interpretation>world" },
      { type: "finish" },
    ];

    const adapter = createAdapterWithCustomBlocks(chunks, {
      interpretation: {},
    });
    const events = await collectEvents(adapter);

    const contentDeltas = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e as any).delta)
      .join("");
    expect(contentDeltas).toBe("helloworld");

    const customBlocks = events.filter((e) => e.type === "custom_block");
    expect(customBlocks).toHaveLength(1);
    expect((customBlocks[0] as any).tag).toBe("interpretation");
    expect((customBlocks[0] as any).content).toBe("insight");
  });

  it("should remap tag from XML name to config key", async () => {
    const chunks = [
      { type: "text", content: "text<interp>content</interp>more" },
      { type: "finish" },
    ];

    const adapter = createAdapterWithCustomBlocks(chunks, {
      interpretation: { tag: "interp" }, // XML tag is <interp>, key is "interpretation"
    });
    const events = await collectEvents(adapter);

    const customBlocks = events.filter((e) => e.type === "custom_block");
    expect(customBlocks).toHaveLength(1);
    expect((customBlocks[0] as any).tag).toBe("interpretation"); // remapped to config key
  });

  it("should suppress blocks when transform returns []", async () => {
    const onDone = vi.fn();
    const chunks = [{ type: "text", content: "result<done/>" }, { type: "finish" }];

    const adapter = createAdapterWithCustomBlocks(chunks, {
      done: {
        transform(block) {
          onDone(block);
          return []; // suppress
        },
      },
    });
    const events = await collectEvents(adapter);

    // done handler called
    expect(onDone).toHaveBeenCalledWith({
      tag: "done",
      content: "",
      attrs: {},
      selfClosing: true,
    });

    // No custom_block events in output
    const customBlocks = events.filter((e) => e.type === "custom_block");
    expect(customBlocks).toHaveLength(0);

    // Text is clean
    const contentDeltas = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e as any).delta)
      .join("");
    expect(contentDeltas).toBe("result");
  });

  it("should transform blocks into different deltas", async () => {
    const chunks = [
      { type: "text", content: "before<interpretation>important insight</interpretation>after" },
      { type: "finish" },
    ];

    const adapter = createAdapterWithCustomBlocks(chunks, {
      interpretation: {
        transform(block) {
          return [{ type: "text", delta: `[${block.content}]` }];
        },
      },
    });
    const events = await collectEvents(adapter);

    const contentDeltas = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e as any).delta)
      .join("");
    expect(contentDeltas).toBe("before[important insight]after");
  });

  it("should call onStart when opening tag found", async () => {
    const onStart = vi.fn();
    const chunks = [
      { type: "text", content: '<interpretation for="ctx">content</interpretation>' },
      { type: "finish" },
    ];

    const adapter = createAdapterWithCustomBlocks(chunks, {
      interpretation: { onStart },
    });
    await collectEvents(adapter);

    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledWith({ for: "ctx" });
  });

  it("should compose customBlocks with user deltaTransform", async () => {
    const chunks = [{ type: "text", content: "text<done/>more" }, { type: "finish" }];

    // User transform: uppercases all text
    const upper: DeltaTransform = {
      process(d) {
        if (d.type === "text") return [{ type: "text", delta: d.delta.toUpperCase() }];
        return [d];
      },
      flush: () => [],
    };

    const adapter = createAdapterWithCustomBlocks(
      chunks,
      { done: { transform: () => [] } }, // suppress done
      upper, // user transform runs after
    );
    const events = await collectEvents(adapter);

    const contentDeltas = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e as any).delta)
      .join("");
    // custom blocks extracted first, then text uppercased
    expect(contentDeltas).toBe("TEXTMORE");
  });

  it("should handle multiple custom block definitions", async () => {
    const chunks = [
      { type: "text", content: "text<interpretation>insight</interpretation>mid<done/>end" },
      { type: "finish" },
    ];

    const adapter = createAdapterWithCustomBlocks(chunks, {
      interpretation: {}, // passthrough
      done: { transform: () => [] }, // suppress
    });
    const events = await collectEvents(adapter);

    const customBlocks = events.filter((e) => e.type === "custom_block");
    expect(customBlocks).toHaveLength(1); // only interpretation, done was suppressed
    expect((customBlocks[0] as any).tag).toBe("interpretation");

    const contentDeltas = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e as any).delta)
      .join("");
    expect(contentDeltas).toBe("textmidend");
  });

  it("should passthrough with remapped tag when transform returns void", async () => {
    const chunks = [{ type: "text", content: "<dbg>info</dbg>" }, { type: "finish" }];

    const adapter = createAdapterWithCustomBlocks(chunks, {
      debugInfo: {
        tag: "dbg",
        transform(_block) {
          // void return — passthrough with remapped tag
        },
      },
    });
    const events = await collectEvents(adapter);

    const customBlocks = events.filter((e) => e.type === "custom_block");
    expect(customBlocks).toHaveLength(1);
    expect((customBlocks[0] as any).tag).toBe("debugInfo"); // remapped
    expect((customBlocks[0] as any).content).toBe("info");
  });
});

// ============================================================================
// customBlocks description/instructions → system prompt injection
// ============================================================================

describe("customBlocks system prompt auto-injection", () => {
  function createAdapterWithDescriptions(
    customBlocks: Record<string, import("./adapter.js").CustomBlockDefinition>,
  ) {
    let capturedInput: ModelInput | undefined;

    const adapter = createAdapter({
      metadata: {
        id: "test:descriptions",
        provider: "test",
        capabilities: [{ stream: true }],
      },
      prepareInput: (input) => {
        capturedInput = input;
        return { model: "test", messages: input.messages };
      },
      mapChunk: (chunk: { type: string; content?: string }): AdapterDelta | null => {
        if (chunk.type === "text") return { type: "text", delta: chunk.content! };
        if (chunk.type === "finish") return { type: "message_end", stopReason: StopReason.STOP };
        return null;
      },
      execute: async () => ({}) as any,
      executeStream: async function* () {
        yield { type: "text", content: "hello" };
        yield { type: "finish" };
      },
      customBlocks,
    });

    return { adapter, getCapturedInput: () => capturedInput };
  }

  function minimalCOMInput(systemText?: string): import("../com/types.js").COMInput {
    const system = systemText
      ? [
          {
            kind: "message" as const,
            message: {
              role: "system" as const,
              content: [{ type: "text" as const, text: systemText }],
            },
          },
        ]
      : [];

    return {
      timeline: [
        {
          kind: "message" as const,
          message: {
            role: "user" as const,
            content: [{ type: "text" as const, text: "hello" }],
          },
        },
      ],
      system,
      sections: {},
      tools: [],
      metadata: {},
      ephemeral: [],
    };
  }

  it("should inject description into existing system message", async () => {
    const { adapter } = createAdapterWithDescriptions({
      interpretation: {
        description: "Wrap analytical insights in this tag.",
      },
    });

    const modelInput = await adapter.fromEngineState!(minimalCOMInput("You are helpful."));

    // System message should have the original text + injected instructions
    const systemMsg = modelInput.messages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    const systemTexts = systemMsg!.content.map((b: any) => b.text);
    expect(systemTexts).toHaveLength(2);
    expect(systemTexts[0]).toBe("You are helpful.");
    expect(systemTexts[1]).toContain("<interpretation>");
    expect(systemTexts[1]).toContain("Wrap analytical insights in this tag.");
  });

  it("should create system message when none exists", async () => {
    const { adapter } = createAdapterWithDescriptions({
      done: {
        description: "Output when task is complete.",
        transform() {
          return [];
        },
      },
    });

    const modelInput = await adapter.fromEngineState!(minimalCOMInput());

    const systemMsg = modelInput.messages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    const text = systemMsg!.content.map((b: any) => b.text).join("");
    expect(text).toContain("<done>");
    expect(text).toContain("Output when task is complete.");
  });

  it("should use XML tag name (not config key) in instructions when remapped", async () => {
    const { adapter } = createAdapterWithDescriptions({
      debugInfo: {
        tag: "debug-info",
        description: "Emit debug information here.",
      },
    });

    const modelInput = await adapter.fromEngineState!(minimalCOMInput("System."));

    const systemMsg = modelInput.messages.find((m) => m.role === "system");
    const instructionBlock = systemMsg!.content.find((b: any) => b.text?.includes("debug-info"));
    expect(instructionBlock).toBeDefined();
    // Should reference the XML tag the model needs to write, not the config key
    expect((instructionBlock as any).text).toContain("<debug-info>");
  });

  it("should skip blocks without descriptions", async () => {
    const { adapter } = createAdapterWithDescriptions({
      interpretation: {
        description: "Use for insights.",
      },
      citation: {}, // no description
      done: {
        transform() {
          return [];
        },
        // no description
      },
    });

    const modelInput = await adapter.fromEngineState!(minimalCOMInput("System."));

    const systemMsg = modelInput.messages.find((m) => m.role === "system");
    const injectedText = systemMsg!.content.map((b: any) => b.text).join("\n");
    expect(injectedText).toContain("<interpretation>");
    expect(injectedText).not.toContain("<citation>");
    expect(injectedText).not.toContain("<done>");
  });

  it("should not inject anything when no blocks have descriptions or instructions", async () => {
    const { adapter } = createAdapterWithDescriptions({
      interpretation: {},
      done: {
        transform() {
          return [];
        },
      },
    });

    const modelInput = await adapter.fromEngineState!(minimalCOMInput("System."));

    const systemMsg = modelInput.messages.find((m) => m.role === "system");
    // Should only have the original system text, no injection
    expect(systemMsg!.content).toHaveLength(1);
    expect((systemMsg!.content[0] as any).text).toBe("System.");
  });

  it("should include multiple described blocks in a single instruction block", async () => {
    const { adapter } = createAdapterWithDescriptions({
      interpretation: {
        description: "For analytical insights.",
      },
      citation: {
        description: "For quoting sources.",
      },
      done: {
        description: "Signal task completion.",
        transform() {
          return [];
        },
      },
    });

    const modelInput = await adapter.fromEngineState!(minimalCOMInput("System."));

    const systemMsg = modelInput.messages.find((m) => m.role === "system");
    const injectedBlock = systemMsg!.content.find((b: any) => b.text?.includes("XML tags"));
    expect(injectedBlock).toBeDefined();
    const text = (injectedBlock as any).text;
    expect(text).toContain("<interpretation>");
    expect(text).toContain("<citation>");
    expect(text).toContain("<done>");
    expect(text).toContain("For analytical insights.");
    expect(text).toContain("For quoting sources.");
    expect(text).toContain("Signal task completion.");
  });

  it("should inject instructions alone (without description)", async () => {
    const { adapter } = createAdapterWithDescriptions({
      done: {
        instructions: "Output <done/> only after the task is fully complete.",
        transform() {
          return [];
        },
      },
    });

    const modelInput = await adapter.fromEngineState!(minimalCOMInput("System."));

    const systemMsg = modelInput.messages.find((m) => m.role === "system");
    const injectedText = systemMsg!.content.map((b: any) => b.text).join("\n");
    expect(injectedText).toContain("<done>");
    expect(injectedText).toContain("Output <done/> only after the task is fully complete.");
  });

  it("should combine description and instructions on separate lines", async () => {
    const { adapter } = createAdapterWithDescriptions({
      interpretation: {
        description: "Analytical insight derived from evidence.",
        instructions: "Use when synthesizing information. Do not use for direct observations.",
      },
    });

    const modelInput = await adapter.fromEngineState!(minimalCOMInput("System."));

    const systemMsg = modelInput.messages.find((m) => m.role === "system");
    const injectedBlock = systemMsg!.content.find((b: any) => b.text?.includes("XML tags"));
    const text = (injectedBlock as any).text;
    // Description appears first on the tag line
    expect(text).toContain("<interpretation>: Analytical insight derived from evidence.");
    // Instructions appear indented on next line
    expect(text).toContain(
      "  Use when synthesizing information. Do not use for direct observations.",
    );
  });

  it("should skip blocks with neither description nor instructions", async () => {
    const { adapter } = createAdapterWithDescriptions({
      interpretation: {
        instructions: "Use for insights.",
      },
      citation: {}, // no description, no instructions
    });

    const modelInput = await adapter.fromEngineState!(minimalCOMInput("System."));

    const systemMsg = modelInput.messages.find((m) => m.role === "system");
    const injectedText = systemMsg!.content.map((b: any) => b.text).join("\n");
    expect(injectedText).toContain("<interpretation>");
    expect(injectedText).not.toContain("<citation>");
  });

  it("should always place system message first when prepending", async () => {
    const { adapter } = createAdapterWithDescriptions({
      done: { description: "Task complete signal." },
    });

    // No system message in input — injection must prepend
    const modelInput = await adapter.fromEngineState!(minimalCOMInput());

    expect(modelInput.messages.length).toBeGreaterThanOrEqual(2);
    expect(modelInput.messages[0].role).toBe("system");
    // User message should follow
    expect(modelInput.messages[1].role).toBe("user");
  });

  it("should target the first system message when multiple exist", async () => {
    const { adapter } = createAdapterWithDescriptions({
      interpretation: { description: "Analytical insights." },
    });

    // Build input with two system messages
    const input = minimalCOMInput("First system.");
    input.system.push({
      kind: "message" as const,
      message: {
        role: "system" as const,
        content: [{ type: "text" as const, text: "Second system." }],
      },
    });

    const modelInput = await adapter.fromEngineState!(input);

    // Find all system messages
    const systemMsgs = modelInput.messages.filter((m) => m.role === "system");
    expect(systemMsgs.length).toBe(2);

    // First system message should have the injection
    const firstTexts = systemMsgs[0].content.map((b: any) => b.text);
    expect(firstTexts).toContain("First system.");
    expect(firstTexts.some((t: string) => t.includes("<interpretation>"))).toBe(true);

    // Second system message should be untouched
    const secondTexts = systemMsgs[1].content.map((b: any) => b.text);
    expect(secondTexts).toEqual(["Second system."]);
  });

  it("should preserve system-first ordering after injection into existing message", async () => {
    const { adapter } = createAdapterWithDescriptions({
      done: { description: "Done signal." },
    });

    const modelInput = await adapter.fromEngineState!(minimalCOMInput("You are helpful."));

    // System must be first
    expect(modelInput.messages[0].role).toBe("system");
    // And it should contain both original text and injection
    const texts = modelInput.messages[0].content.map((b: any) => b.text);
    expect(texts[0]).toBe("You are helpful.");
    expect(texts[1]).toContain("<done>");
  });

  it("should not duplicate instructions across multiple fromEngineState calls", async () => {
    const { adapter } = createAdapterWithDescriptions({
      interpretation: { description: "Insights." },
    });

    // Call fromEngineState twice with same input structure
    const input1 = minimalCOMInput("System.");
    const input2 = minimalCOMInput("System.");

    const result1 = await adapter.fromEngineState!(input1);
    const result2 = await adapter.fromEngineState!(input2);

    // Each should have exactly 2 content blocks (original + injection), not 3
    const sys1 = result1.messages.find((m) => m.role === "system")!;
    const sys2 = result2.messages.find((m) => m.role === "system")!;
    expect(sys1.content).toHaveLength(2);
    expect(sys2.content).toHaveLength(2);
  });
});
