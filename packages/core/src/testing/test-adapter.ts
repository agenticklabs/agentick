/**
 * Test Adapter Factory
 *
 * Creates mock models for testing agents without making real API calls.
 * Built on createAdapter for consistency with production adapters.
 *
 * Note: Like all adapters created with createAdapter, generate() and stream()
 * return ExecutionHandle. To get the actual result, use:
 *
 * ```typescript
 * const handle = await adapter.generate(input);
 * const output = await handle.result;
 * ```
 */

import {
  createAdapter,
  type AdapterDelta,
  type ModelClass,
  type StopReason,
} from "../model/adapter.js";
import type { ModelInput, ModelOutput } from "../model/model.js";
import { fromEngineState, toEngineState } from "../model/utils/language-model.js";
import type { Message, ToolCall } from "@agentick/shared";
import type { Mock } from "vitest";
import { vi } from "vitest";
import { randomUUID } from "crypto";

// ============================================================================
// Types
// ============================================================================

/**
 * Content items for respondWith API.
 * Supports progressive disclosure - simple cases are simple.
 */
export type ResponseItem =
  | string // Text content
  | { text: string } // Explicit text
  | { tool: ToolCallInput | ToolCallInput[] } // Tool call(s)
  | { image: { url: string } | { data: string; mediaType?: string } } // Image
  | { reasoning: string }; // Reasoning/thinking content

export interface ToolCallInput {
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Normalized response structure (internal).
 */
interface NormalizedResponse {
  content: Array<{
    type: string;
    [key: string]: unknown;
  }>;
  toolCalls: ToolCall[];
  stopReason: StopReason;
}

export interface TestAdapterOptions {
  /**
   * Default response text for the model.
   * @default "Test response"
   */
  defaultResponse?: string;

  /**
   * Delay in ms before returning response (simulates latency).
   * @default 0
   */
  delay?: number;

  /**
   * Custom response generator.
   * Called with the input to generate dynamic responses.
   */
  responseGenerator?: (input: ModelInput) => string | Message;

  /**
   * Tool calls to include in the response.
   */
  toolCalls?: ToolCall[];

  /**
   * Stop reason for the response.
   * @default "stop"
   */
  stopReason?: StopReason;

  /**
   * Whether to throw an error instead of returning a response.
   */
  throwError?: Error;

  /**
   * Callback when model.execute is called.
   */
  onExecute?: (input: ModelInput) => void;

  /**
   * Streaming simulation options.
   */
  streaming?: {
    /**
     * Whether to simulate streaming (yield chunks progressively).
     * @default false
     */
    enabled?: boolean;

    /**
     * Chunk size in characters.
     * @default 10
     */
    chunkSize?: number;

    /**
     * Delay between chunks in ms.
     * @default 5
     */
    chunkDelay?: number;
  };
}

export interface StreamingOptions {
  enabled?: boolean;
  chunkSize?: number;
  chunkDelay?: number;
}

export interface TestAdapterInstance extends ModelClass {
  /**
   * Get all captured inputs from model calls.
   */
  getCapturedInputs: () => ModelInput[];

  /**
   * Clear all captured inputs.
   */
  clearCapturedInputs: () => void;

  /**
   * Set the response for subsequent calls.
   */
  setResponse: (response: string | Message) => void;

  /**
   * Configure streaming simulation.
   */
  setStreaming: (options: StreamingOptions) => void;

  /**
   * Set tool calls for subsequent responses.
   */
  setToolCalls: (toolCalls: ToolCall[]) => void;

  /**
   * Make the model throw an error on next call.
   */
  setError: (error: Error | null) => void;

  /**
   * Set the response for the NEXT call only.
   * After the next call, this is cleared.
   */
  respondWith: (items: ResponseItem[]) => void;

  /**
   * Get the mock functions for assertions.
   */
  mocks: {
    execute: Mock;
    executeStream: Mock;
  };
}

// ============================================================================
// Response Normalization
// ============================================================================

function normalizeToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.map((tc, idx) => ({
    ...tc,
    id: tc.id || `toolu_test_${randomUUID().slice(0, 8)}_${idx}`,
  }));
}

function normalizeResponse(items: ResponseItem[]): NormalizedResponse {
  const content: NormalizedResponse["content"] = [];
  const toolCalls: ToolCall[] = [];

  for (const item of items) {
    if (typeof item === "string") {
      content.push({ type: "text", text: item });
      continue;
    }

    if ("text" in item && typeof item.text === "string") {
      content.push({ type: "text", text: item.text });
      continue;
    }

    if ("tool" in item) {
      const tools = Array.isArray(item.tool) ? item.tool : [item.tool];
      for (const t of tools) {
        const id = t.id || `toolu_test_${randomUUID().slice(0, 8)}_${toolCalls.length}`;
        toolCalls.push({ id, name: t.name, input: t.input });
        content.push({ type: "tool_use", id, name: t.name, input: t.input });
      }
      continue;
    }

    if ("image" in item) {
      if ("url" in item.image) {
        content.push({ type: "image", source: { type: "url", url: item.image.url } });
      } else {
        content.push({
          type: "image",
          source: {
            type: "base64",
            data: item.image.data,
            mediaType: item.image.mediaType || "image/png",
          },
        });
      }
      continue;
    }

    if ("reasoning" in item) {
      content.push({ type: "reasoning", text: item.reasoning });
      continue;
    }
  }

  const stopReason: StopReason =
    toolCalls.length > 0 ? ("tool_use" as StopReason) : ("stop" as StopReason);
  return { content, toolCalls, stopReason };
}

function buildMessage(response: string | Message): Message {
  if (typeof response === "string") {
    return { role: "assistant", content: [{ type: "text", text: response }] };
  }
  return response;
}

function messageToNormalizedResponse(
  message: Message,
  toolCalls: ToolCall[],
  baseStopReason: StopReason,
): NormalizedResponse {
  const content: NormalizedResponse["content"] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: (block as any).text });
    }
  }

  for (const tc of toolCalls) {
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
  }

  const stopReason: StopReason = toolCalls.length > 0 ? ("tool_use" as StopReason) : baseStopReason;
  return { content, toolCalls, stopReason: stopReason as StopReason };
}

// ============================================================================
// Provider Chunk Type (internal)
// ============================================================================

/**
 * Internal chunk type that carries AdapterDelta + delay info.
 * This allows us to use createAdapter's mapChunk with pre-computed deltas.
 */
interface TestChunk {
  delta: AdapterDelta;
  delayMs?: number;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a test adapter for use in tests.
 * Built on createAdapter for consistency with production adapters.
 *
 * @example
 * ```tsx
 * const model = createTestAdapter({
 *   defaultResponse: "Hello from test!",
 *   delay: 10,
 * });
 *
 * const { send } = renderAgent(MyAgent, { model });
 * await act(() => send("Hi"));
 *
 * expect(model.getCapturedInputs()).toHaveLength(1);
 * ```
 */
export function createTestAdapter(options: TestAdapterOptions = {}): TestAdapterInstance {
  const { defaultResponse = "Test response", delay = 0, onExecute } = options;

  // Mutable state
  let currentResponse: string | Message = defaultResponse;
  let currentToolCalls: ToolCall[] = normalizeToolCalls(options.toolCalls ?? []);
  let currentError: Error | null = options.throwError ?? null;
  let responseGenerator = options.responseGenerator;
  const capturedInputs: ModelInput[] = [];

  // respondWith state - consumed on next call
  let nextResponse: NormalizedResponse | null = null;

  // Streaming state
  let streamingEnabled = options.streaming?.enabled ?? false;
  let streamingChunkSize = options.streaming?.chunkSize ?? 10;
  let streamingChunkDelay = options.streaming?.chunkDelay ?? 5;

  // Mock functions
  const executeMock = vi.fn();
  const executeStreamMock = vi.fn();

  // Helper to get response
  const getResponse = (input: ModelInput): Message => {
    if (responseGenerator) {
      return buildMessage(responseGenerator(input));
    }
    return buildMessage(currentResponse);
  };

  // Helper to get normalized response for a call
  const getNormalizedResponse = (input: ModelInput): NormalizedResponse => {
    if (nextResponse) {
      const response = nextResponse;
      nextResponse = null;
      return response;
    }
    const message = getResponse(input);
    return messageToNormalizedResponse(
      message,
      currentToolCalls,
      (options.stopReason ?? "stop") as StopReason,
    );
  };

  // Convert normalized response to test chunks (with optional streaming delays)
  const toTestChunks = (response: NormalizedResponse): TestChunk[] => {
    const chunks: TestChunk[] = [];
    const chunkSize = streamingEnabled ? streamingChunkSize : undefined;

    chunks.push({ delta: { type: "message_start" } });

    for (const block of response.content) {
      if (block.type === "text") {
        const text = block.text as string;
        if (chunkSize && chunkSize > 0) {
          for (let i = 0; i < text.length; i += chunkSize) {
            chunks.push({
              delta: { type: "text", delta: text.slice(i, i + chunkSize) },
              delayMs: streamingEnabled ? streamingChunkDelay : undefined,
            });
          }
        } else {
          chunks.push({ delta: { type: "text", delta: text } });
        }
      } else if (block.type === "tool_use") {
        const id = block.id as string;
        const name = block.name as string;
        const input = block.input as unknown;
        chunks.push({ delta: { type: "tool_call_start", id, name } });
        chunks.push({ delta: { type: "tool_call_delta", id, delta: JSON.stringify(input) } });
        chunks.push({ delta: { type: "tool_call_end", id, input } });
      } else if (block.type === "reasoning") {
        const text = block.text as string;
        if (chunkSize && chunkSize > 0) {
          for (let i = 0; i < text.length; i += chunkSize) {
            chunks.push({
              delta: { type: "reasoning", delta: text.slice(i, i + chunkSize) },
              delayMs: streamingEnabled ? streamingChunkDelay : undefined,
            });
          }
        } else {
          chunks.push({ delta: { type: "reasoning", delta: text } });
        }
      }
    }

    chunks.push({
      delta: {
        type: "message_end",
        stopReason: response.stopReason,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    });

    return chunks;
  };

  // Build ModelOutput from normalized response (for non-streaming)
  const buildModelOutput = (response: NormalizedResponse): ModelOutput => {
    const message: Message = { role: "assistant", content: response.content as any };
    return {
      model: "test-adapter",
      createdAt: new Date().toISOString(),
      message,
      toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      stopReason: response.stopReason,
      raw: {},
    } as ModelOutput;
  };

  // Create the adapter using createAdapter
  const adapter = createAdapter<ModelInput, ModelOutput, TestChunk>({
    metadata: {
      id: "test-adapter",
      provider: "test",
      capabilities: [{ stream: true, toolCalls: true }],
    },

    prepareInput: (input: ModelInput) => {
      // Capture and track the input
      capturedInputs.push(input);
      onExecute?.(input);
      return input;
    },

    mapChunk: (chunk: TestChunk): AdapterDelta | null => {
      // Pass through the pre-computed delta
      return chunk.delta;
    },

    execute: async (input: ModelInput) => {
      executeMock(input);

      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      if (currentError) {
        throw currentError;
      }

      // Return a fake "provider output" that we'll process
      // Since we use processOutput, we need to return something
      return { _normalized: getNormalizedResponse(input) } as any;
    },

    executeStream: async function* (input: ModelInput) {
      executeStreamMock(input);

      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      if (currentError) {
        throw currentError;
      }

      const response = getNormalizedResponse(input);
      const chunks = toTestChunks(response);

      for (const chunk of chunks) {
        if (chunk.delayMs && chunk.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, chunk.delayMs));
        }
        yield chunk;
      }
    },

    processOutput: async (output: any): Promise<ModelOutput> => {
      // Convert our internal format to ModelOutput
      return buildModelOutput(output._normalized);
    },

    fromEngineState,
    toEngineState,
  });

  // Cast and extend with test utilities
  const testAdapter = adapter as TestAdapterInstance;

  testAdapter.getCapturedInputs = () => [...capturedInputs];
  testAdapter.clearCapturedInputs = () => {
    capturedInputs.length = 0;
  };
  testAdapter.setResponse = (response: string | Message) => {
    currentResponse = response;
    responseGenerator = undefined;
  };
  testAdapter.setToolCalls = (toolCalls: ToolCall[]) => {
    currentToolCalls = normalizeToolCalls(toolCalls);
  };
  testAdapter.setError = (error: Error | null) => {
    currentError = error;
  };
  testAdapter.setStreaming = (opts: StreamingOptions) => {
    if (opts.enabled !== undefined) streamingEnabled = opts.enabled;
    if (opts.chunkSize !== undefined) streamingChunkSize = opts.chunkSize;
    if (opts.chunkDelay !== undefined) streamingChunkDelay = opts.chunkDelay;
  };
  testAdapter.respondWith = (items: ResponseItem[]) => {
    nextResponse = normalizeResponse(items);
  };
  testAdapter.mocks = {
    execute: executeMock,
    executeStream: executeStreamMock,
  };

  return testAdapter;
}
