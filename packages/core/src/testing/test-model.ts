/**
 * Test Model Factory
 *
 * Creates mock models for testing agents without making real API calls.
 */

import { createModel, type ModelInput, type ModelOutput } from "../model/model";
import { fromEngineState, toEngineState } from "../model/utils/language-model";
import type { StopReason, StreamEvent, Message, ToolCall } from "@tentickle/shared";
import { BlockType } from "@tentickle/shared";
import type { Mock } from "vitest";
import { vi } from "vitest";
import { randomUUID } from "crypto";

// ============================================================================
// Stream Event Helpers
// ============================================================================

let sequenceCounter = 0;

function createStreamEvent<T extends StreamEvent["type"]>(
  type: T,
  fields: Omit<
    Extract<StreamEvent, { type: T }>,
    "type" | "id" | "sequence" | "tick" | "timestamp"
  >,
): Extract<StreamEvent, { type: T }> {
  sequenceCounter++;
  return {
    type,
    id: randomUUID(),
    sequence: sequenceCounter,
    tick: 1,
    timestamp: new Date().toISOString(),
    ...fields,
  } as Extract<StreamEvent, { type: T }>;
}

// ============================================================================
// Types
// ============================================================================

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
   * Get the mock functions for assertions.
   */
  mocks: {
    execute: Mock;
    executeStream: Mock;
  };
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

  // Mutable state
  let currentResponse: string | Message = options.responseGenerator
    ? defaultResponse
    : defaultResponse;
  let currentToolCalls: ToolCall[] = options.toolCalls ?? [];
  let currentError: Error | null = options.throwError ?? null;
  let responseGenerator = options.responseGenerator;
  const capturedInputs: ModelInput[] = [];

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

        const message = getResponse(input);

        return {
          model: "test-model",
          createdAt: new Date().toISOString(),
          message,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          stopReason: (options.stopReason ?? "stop") as StopReason,
          raw: {},
        } as ModelOutput;
      },
      executeStream: async function* (input: ModelInput) {
        executeStreamMock(input);
        capturedInputs.push(input);
        onExecute?.(input);

        // Reset sequence counter for this stream
        sequenceCounter = 0;

        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        if (currentError) {
          throw currentError;
        }

        const message = getResponse(input);
        const textContent = message.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");

        // Use mutable streaming state
        const chunkSize = streamingChunkSize;
        const chunkDelay = streamingChunkDelay;

        // Yield message_start
        yield createStreamEvent("message_start", {
          role: "assistant",
        });

        // Yield text content
        if (textContent) {
          // Yield content_start
          yield createStreamEvent("content_start", {
            blockType: BlockType.TEXT,
            blockIndex: 0,
          });

          if (streamingEnabled) {
            // Simulate realistic streaming: yield chunks progressively
            for (let i = 0; i < textContent.length; i += chunkSize) {
              const chunk = textContent.slice(i, i + chunkSize);
              yield createStreamEvent("content_delta", {
                blockType: BlockType.TEXT,
                blockIndex: 0,
                delta: chunk,
              });

              if (chunkDelay > 0 && i + chunkSize < textContent.length) {
                await new Promise((resolve) => setTimeout(resolve, chunkDelay));
              }
            }
          } else {
            // Default: yield entire response as single chunk
            yield createStreamEvent("content_delta", {
              blockType: BlockType.TEXT,
              blockIndex: 0,
              delta: textContent,
            });
          }

          // Yield content_end
          yield createStreamEvent("content_end", {
            blockType: BlockType.TEXT,
            blockIndex: 0,
          });
        }

        // Yield tool calls
        let toolBlockIndex = textContent ? 1 : 0;
        for (const toolCall of currentToolCalls) {
          yield createStreamEvent("tool_call_start", {
            // blockType: BlockType.TOOL_USE,
            blockIndex: toolBlockIndex,
            callId: toolCall.id,
            name: toolCall.name,
          });
          yield createStreamEvent("tool_call_delta", {
            // blockType: BlockType.TOOL_USE,
            blockIndex: toolBlockIndex,
            callId: toolCall.id,
            delta: JSON.stringify(toolCall.input),
          });
          yield createStreamEvent("tool_call_end", {
            // blockType: BlockType.TOOL_USE,
            blockIndex: toolBlockIndex,
            callId: toolCall.id,
            // name: toolCall.name,
            // input: toolCall.input,
          });
          toolBlockIndex++;
        }

        // Yield message_end
        yield createStreamEvent("message_end", {
          stopReason: (options.stopReason ?? "stop") as StopReason,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        });
      },
    },
    transformers: {
      processStream: async (chunks: StreamEvent[]) => {
        let text = "";
        for (const chunk of chunks) {
          if (chunk.type === "content_delta" && typeof chunk.delta === "string") {
            text += chunk.delta;
          }
        }
        return {
          model: "test-model",
          createdAt: new Date().toISOString(),
          message: { role: "assistant", content: [{ type: "text", text }] },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          stopReason: (options.stopReason ?? "stop") as StopReason,
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
    currentToolCalls = toolCalls;
  };
  testModel.setError = (error: Error | null) => {
    currentError = error;
  };
  testModel.setStreaming = (opts: StreamingOptions) => {
    if (opts.enabled !== undefined) streamingEnabled = opts.enabled;
    if (opts.chunkSize !== undefined) streamingChunkSize = opts.chunkSize;
    if (opts.chunkDelay !== undefined) streamingChunkDelay = opts.chunkDelay;
  };
  testModel.mocks = {
    execute: executeMock,
    executeStream: executeStreamMock,
  };

  return testModel;
}
