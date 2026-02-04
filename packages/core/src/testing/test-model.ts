/**
 * Test Model Factory
 *
 * Creates mock models for testing agents without making real API calls.
 * Uses StreamAccumulator for consistent stream event generation.
 */

import { createModel, type ModelInput, type ModelOutput } from "../model/model";
import { fromEngineState, toEngineState } from "../model/utils/language-model";
import { StreamAccumulator, type AdapterDelta } from "../model/stream-accumulator";
import type { StopReason, StreamEvent, Message, ToolCall } from "@tentickle/shared";
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

// ============================================================================
// Response Building Helpers
// ============================================================================

/**
 * Convert NormalizedResponse to a sequence of AdapterDeltas.
 * These can be pushed through StreamAccumulator to generate proper StreamEvents.
 */
function toAdapterDeltas(
  response: NormalizedResponse,
  options?: { streaming?: { chunkSize?: number } },
): AdapterDelta[] {
  const deltas: AdapterDelta[] = [];
  const chunkSize = options?.streaming?.chunkSize;

  deltas.push({ type: "message_start" });

  for (const block of response.content) {
    if (block.type === "text") {
      const text = block.text as string;
      if (chunkSize && chunkSize > 0) {
        // Stream in chunks
        for (let i = 0; i < text.length; i += chunkSize) {
          deltas.push({ type: "text", delta: text.slice(i, i + chunkSize) });
        }
      } else {
        deltas.push({ type: "text", delta: text });
      }
    } else if (block.type === "tool_use") {
      // Emit tool_call_start/delta/end sequence for proper lifecycle events
      const id = block.id as string;
      const name = block.name as string;
      const input = block.input as unknown;
      deltas.push({ type: "tool_call_start", id, name });
      deltas.push({ type: "tool_call_delta", id, delta: JSON.stringify(input) });
      deltas.push({ type: "tool_call_end", id, input });
    } else if (block.type === "reasoning") {
      const text = block.text as string;
      if (chunkSize && chunkSize > 0) {
        for (let i = 0; i < text.length; i += chunkSize) {
          deltas.push({ type: "reasoning", delta: text.slice(i, i + chunkSize) });
        }
      } else {
        deltas.push({ type: "reasoning", delta: text });
      }
    } else if (block.type === "image") {
      // Images don't stream - just skip for now (they're in the final output)
    }
  }

  deltas.push({
    type: "message_end",
    stopReason: response.stopReason,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });

  return deltas;
}

/**
 * Build ModelOutput directly from NormalizedResponse.
 * Used by execute() for non-streaming path.
 */
function buildModelOutput(response: NormalizedResponse): ModelOutput {
  const message: Message = {
    role: "assistant",
    content: response.content as any,
  };

  return {
    model: "test-model",
    createdAt: new Date().toISOString(),
    message,
    toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    stopReason: response.stopReason,
    raw: {},
  } as ModelOutput;
}

/**
 * Convert a Message and optional tool calls to NormalizedResponse.
 * Used to unify execute/stream paths for default behavior.
 */
function messageToNormalizedResponse(
  message: Message,
  toolCalls: ToolCall[],
  baseStopReason: StopReason,
): NormalizedResponse {
  const content: NormalizedResponse["content"] = [];

  // Add message content
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: (block as any).text });
    }
    // Other content types from message are preserved as-is
  }

  // Add tool_use blocks for tool calls
  for (const tc of toolCalls) {
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: tc.input,
    });
  }

  const stopReason: StopReason = toolCalls.length > 0 ? "tool_use" : baseStopReason;

  return { content, toolCalls, stopReason };
}

export interface TestModelOptions {
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
   * When enabled, executeStream yields chunks progressively.
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

export interface TestModelInstance extends ReturnType<typeof createModel> {
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
   * Content is auto-detected and normalized.
   * After the next call, this is cleared.
   *
   * @example
   * ```typescript
   * // Simple text
   * model.respondWith(["Hello world"])
   *
   * // Text + tool call
   * model.respondWith([
   *   "Let me search for that",
   *   { tool: { name: "search", input: { query: "test" } } }
   * ])
   *
   * // Parallel tool calls
   * model.respondWith([
   *   { tool: [
   *     { name: "search", input: { query: "a" } },
   *     { name: "search", input: { query: "b" } }
   *   ]}
   * ])
   *
   * // With image
   * model.respondWith([
   *   "Here's the image:",
   *   { image: { url: "https://..." } }
   * ])
   * ```
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

/**
 * Normalize ResponseItem[] into internal NormalizedResponse structure.
 * Handles content type detection, ID generation, and stopReason inference.
 */
function normalizeResponse(items: ResponseItem[]): NormalizedResponse {
  const content: NormalizedResponse["content"] = [];
  const toolCalls: ToolCall[] = [];

  for (const item of items) {
    // String → text block
    if (typeof item === "string") {
      content.push({ type: "text", text: item });
      continue;
    }

    // Explicit text
    if ("text" in item && typeof item.text === "string") {
      content.push({ type: "text", text: item.text });
      continue;
    }

    // Tool call(s)
    if ("tool" in item) {
      const tools = Array.isArray(item.tool) ? item.tool : [item.tool];
      for (let i = 0; i < tools.length; i++) {
        const t = tools[i];
        const id = t.id || `toolu_test_${randomUUID().slice(0, 8)}_${toolCalls.length}`;
        toolCalls.push({ id, name: t.name, input: t.input });
        content.push({
          type: "tool_use",
          id,
          name: t.name,
          input: t.input,
        });
      }
      continue;
    }

    // Image
    if ("image" in item) {
      if ("url" in item.image) {
        content.push({
          type: "image",
          source: { type: "url", url: item.image.url },
        });
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

    // Reasoning
    if ("reasoning" in item) {
      content.push({ type: "reasoning", text: item.reasoning });
      continue;
    }
  }

  // Infer stopReason from content
  const stopReason: StopReason = toolCalls.length > 0 ? "tool_use" : "stop";

  return { content, toolCalls, stopReason };
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a test model for use in tests.
 *
 * @example
 * ```tsx
 * const model = createTestModel({
 *   defaultResponse: "Hello from test!",
 *   delay: 10,
 * });
 *
 * const { send } = renderAgent(MyAgent, { model });
 * await act(() => send("Hi"));
 *
 * expect(model.getCapturedInputs()).toHaveLength(1);
 * ```
 *
 * @example Dynamic responses
 * ```tsx
 * const model = createTestModel({
 *   responseGenerator: (input) => {
 *     const lastMessage = input.messages.at(-1);
 *     if (lastMessage?.content.includes("weather")) {
 *       return "It's sunny today!";
 *     }
 *     return "I don't understand.";
 *   },
 * });
 * ```
 */
export function createTestModel(options: TestModelOptions = {}): TestModelInstance {
  const { defaultResponse = "Test response", delay = 0, onExecute } = options;

  // Helper to ensure tool calls have IDs
  const normalizeToolCalls = (toolCalls: ToolCall[]): ToolCall[] => {
    return toolCalls.map((tc, idx) => ({
      ...tc,
      id: tc.id || `toolu_test_${randomUUID().slice(0, 8)}_${idx}`,
    }));
  };

  // Mutable state
  let currentResponse: string | Message = options.responseGenerator
    ? defaultResponse
    : defaultResponse;
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

  // Helper to build message from string or Message
  const buildMessage = (response: string | Message): Message => {
    if (typeof response === "string") {
      return {
        role: "assistant",
        content: [{ type: "text", text: response }],
      };
    }
    return response;
  };

  // Helper to get response
  const getResponse = (input: ModelInput): Message => {
    if (responseGenerator) {
      return buildMessage(responseGenerator(input));
    }
    return buildMessage(currentResponse);
  };

  // Mock functions
  const executeMock = vi.fn();
  const executeStreamMock = vi.fn();

  const model = createModel<ModelInput, ModelOutput, ModelInput, ModelOutput, StreamEvent>({
    metadata: {
      id: "test-model",
      provider: "test",
      capabilities: [],
    },
    executors: {
      execute: async (input: ModelInput) => {
        executeMock(input);
        capturedInputs.push(input);
        onExecute?.(input);

        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        if (currentError) {
          throw currentError;
        }

        // Check for respondWith override (consumes it)
        if (nextResponse) {
          const response = nextResponse;
          nextResponse = null;
          return buildModelOutput(response);
        }

        // Default behavior: convert message + toolCalls to normalized response
        const message = getResponse(input);
        const normalizedResponse = messageToNormalizedResponse(
          message,
          currentToolCalls,
          (options.stopReason ?? "stop") as StopReason,
        );
        return buildModelOutput(normalizedResponse);
      },
      executeStream: async function* (input: ModelInput) {
        executeStreamMock(input);
        capturedInputs.push(input);
        onExecute?.(input);

        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        if (currentError) {
          throw currentError;
        }

        // Determine response to stream
        let response: NormalizedResponse;
        if (nextResponse) {
          response = nextResponse;
          nextResponse = null;
        } else {
          // Default behavior: convert message + toolCalls to normalized response
          const message = getResponse(input);
          response = messageToNormalizedResponse(
            message,
            currentToolCalls,
            (options.stopReason ?? "stop") as StopReason,
          );
        }

        // Use StreamAccumulator to generate proper events
        const accumulator = new StreamAccumulator({ modelId: "test-model" });
        const chunkSize = streamingEnabled ? streamingChunkSize : undefined;
        const deltas = toAdapterDeltas(response, { streaming: { chunkSize } });

        for (const delta of deltas) {
          const events = accumulator.push(delta);
          for (const event of events) {
            yield event;
          }

          // Add delay between chunks if streaming is enabled
          if (
            streamingEnabled &&
            streamingChunkDelay > 0 &&
            (delta.type === "text" || delta.type === "reasoning")
          ) {
            await new Promise((resolve) => setTimeout(resolve, streamingChunkDelay));
          }
        }
      },
    },
    transformers: {
      processStream: async (chunks: StreamEvent[]) => {
        // Aggregate stream events into ModelOutput
        // StreamAccumulator emits tool_call events with complete data
        let text = "";
        let reasoning = "";
        const toolCalls: ToolCall[] = [];
        let stopReason: StopReason = (options.stopReason ?? "stop") as StopReason;
        let usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

        for (const chunk of chunks) {
          if (chunk.type === "content_delta") {
            const delta = (chunk as any).delta as string;
            const blockType = (chunk as any).blockType;
            if (blockType === "reasoning") {
              reasoning += delta;
            } else {
              text += delta;
            }
          } else if (chunk.type === "tool_call") {
            // StreamAccumulator emits complete tool_call events
            const tc = chunk as any;
            toolCalls.push({
              id: tc.callId,
              name: tc.name,
              input: tc.input as Record<string, unknown>,
            });
          } else if (chunk.type === "message_end") {
            const end = chunk as any;
            stopReason = end.stopReason;
            if (end.usage) {
              usage = end.usage;
            }
          }
        }

        // Build message content
        const content: any[] = [];
        if (reasoning) {
          content.push({ type: "reasoning", text: reasoning });
        }
        if (text) {
          content.push({ type: "text", text });
        }
        for (const tc of toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }

        return {
          model: "test-model",
          createdAt: new Date().toISOString(),
          message: { role: "assistant", content },
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage,
          stopReason,
          raw: {},
        } as ModelOutput;
      },
    },
    fromEngineState,
    toEngineState,
  });

  // Extend with test utilities
  const testModel = model as TestModelInstance;

  testModel.getCapturedInputs = () => [...capturedInputs];
  testModel.clearCapturedInputs = () => {
    capturedInputs.length = 0;
  };
  testModel.setResponse = (response: string | Message) => {
    currentResponse = response;
    responseGenerator = undefined;
  };
  testModel.setToolCalls = (toolCalls: ToolCall[]) => {
    currentToolCalls = normalizeToolCalls(toolCalls);
  };
  testModel.setError = (error: Error | null) => {
    currentError = error;
  };
  testModel.setStreaming = (opts: StreamingOptions) => {
    if (opts.enabled !== undefined) streamingEnabled = opts.enabled;
    if (opts.chunkSize !== undefined) streamingChunkSize = opts.chunkSize;
    if (opts.chunkDelay !== undefined) streamingChunkDelay = opts.chunkDelay;
  };
  testModel.respondWith = (items: ResponseItem[]) => {
    nextResponse = normalizeResponse(items);
  };
  testModel.mocks = {
    execute: executeMock,
    executeStream: executeStreamMock,
  };

  return testModel;
}
