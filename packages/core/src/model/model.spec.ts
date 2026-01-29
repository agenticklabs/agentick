/**
 * Model Tests
 *
 * Tests for createModel and streaming event emission.
 */

import { describe, it, expect, vi } from "vitest";
import { createModel, type ModelInput, type ModelOutput } from "./model";
import { fromEngineState, toEngineState } from "./utils/language-model";
import type {
  StreamEvent,
  MessageEvent,
  ContentStartEvent,
  ContentEndEvent,
  MessageStartEvent,
  MessageEndEvent,
} from "@tentickle/shared";
import { BlockType, StopReason } from "@tentickle/shared";

describe("createModel", () => {
  describe("streaming", () => {
    it("should emit message event after message_end", async () => {
      const events: StreamEvent[] = [];

      // Create a model that emits proper StreamEvent sequence
      const model = createModel<ModelInput, ModelOutput, ModelInput, ModelOutput, StreamEvent>({
        metadata: {
          id: "test-model",
          provider: "test",
          capabilities: [],
        },
        executors: {
          execute: vi.fn(),
          executeStream: async function* () {
            // Emit the standard streaming sequence
            yield {
              type: "message_start",
              messageId: "msg-1",
              role: "assistant",
              model: "test-model",
              startedAt: new Date().toISOString(),
            } as MessageStartEvent;

            yield {
              type: "content_start",
              blockType: BlockType.TEXT,
              blockIndex: 0,
            } as ContentStartEvent;

            yield {
              type: "content_delta",
              blockType: BlockType.TEXT,
              blockIndex: 0,
              delta: "Hello, world!",
            } as StreamEvent;

            yield {
              type: "content_end",
              blockType: BlockType.TEXT,
              blockIndex: 0,
            } as ContentEndEvent;

            yield {
              type: "message_end",
              stopReason: StopReason.STOP,
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            } as MessageEndEvent;
          },
        },
        fromEngineState,
        toEngineState,
      });

      // Stream and collect all events
      const mockInput: ModelInput = {
        messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      };

      // model.stream returns a Procedure that yields AsyncIterable
      // Invoke the procedure (returns Promise<AsyncIterable>) and iterate over the result
      expect(model.stream).toBeDefined();
      const streamIterable = await model.stream!(mockInput);
      for await (const event of streamIterable) {
        events.push(event);
      }

      // Verify message event is emitted after message_end
      const messageEvent = events.find((e) => e.type === "message") as MessageEvent;
      expect(messageEvent).toBeDefined();
      expect(messageEvent.type).toBe("message");
      expect(messageEvent.message.role).toBe("assistant");
      expect(messageEvent.message.content).toHaveLength(1);
      expect(messageEvent.message.content[0].type).toBe("text");
      expect((messageEvent.message.content[0] as any).text).toBe("Hello, world!");
      expect(messageEvent.stopReason).toBe(StopReason.STOP);
      expect(messageEvent.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });

      // Verify event order: message_end comes before message
      const messageEndIndex = events.findIndex((e) => e.type === "message_end");
      const messageIndex = events.findIndex((e) => e.type === "message");
      expect(messageEndIndex).toBeLessThan(messageIndex);
    });

    it("should accumulate text from multiple content_delta events", async () => {
      const events: StreamEvent[] = [];

      const model = createModel<ModelInput, ModelOutput, ModelInput, ModelOutput, StreamEvent>({
        metadata: { id: "test-model", provider: "test", capabilities: [] },
        executors: {
          execute: vi.fn(),
          executeStream: async function* () {
            yield {
              type: "message_start",
              messageId: "msg-1",
              role: "assistant",
              model: "test-model",
              startedAt: new Date().toISOString(),
            } as MessageStartEvent;
            yield {
              type: "content_start",
              blockType: BlockType.TEXT,
              blockIndex: 0,
            } as ContentStartEvent;
            yield {
              type: "content_delta",
              blockType: BlockType.TEXT,
              blockIndex: 0,
              delta: "Hello",
            } as StreamEvent;
            yield {
              type: "content_delta",
              blockType: BlockType.TEXT,
              blockIndex: 0,
              delta: ", ",
            } as StreamEvent;
            yield {
              type: "content_delta",
              blockType: BlockType.TEXT,
              blockIndex: 0,
              delta: "world!",
            } as StreamEvent;
            yield {
              type: "content_end",
              blockType: BlockType.TEXT,
              blockIndex: 0,
            } as ContentEndEvent;
            yield {
              type: "message_end",
              stopReason: StopReason.STOP,
              usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
            } as MessageEndEvent;
          },
        },
        fromEngineState,
        toEngineState,
      });

      const streamIterable = await model.stream!({
        messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      });
      for await (const event of streamIterable) {
        events.push(event);
      }

      const messageEvent = events.find((e) => e.type === "message") as MessageEvent;
      expect(messageEvent).toBeDefined();
      expect((messageEvent.message.content[0] as any).text).toBe("Hello, world!");
    });

    it("should emit message event with tool_use content", async () => {
      const events: StreamEvent[] = [];
      const now = new Date().toISOString();

      const model = createModel<ModelInput, ModelOutput, ModelInput, ModelOutput, StreamEvent>({
        metadata: { id: "test-model", provider: "test", capabilities: [] },
        executors: {
          execute: vi.fn(),
          executeStream: async function* () {
            yield {
              type: "message_start",
              messageId: "msg-1",
              role: "assistant",
              model: "test-model",
              startedAt: now,
            } as MessageStartEvent;
            // Emit complete tool_call event (this is what adapters emit for complete tool calls)
            yield {
              type: "tool_call",
              callId: "call-1",
              name: "search",
              input: { query: "test" },
              blockIndex: 0,
              startedAt: now,
              completedAt: now,
            } as StreamEvent;
            yield {
              type: "message_end",
              stopReason: StopReason.TOOL_USE,
              usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
            } as MessageEndEvent;
          },
        },
        fromEngineState,
        toEngineState,
      });

      const streamIterable = await model.stream!({
        messages: [{ role: "user", content: [{ type: "text", text: "Search" }] }],
      });
      for await (const event of streamIterable) {
        events.push(event);
      }

      const messageEvent = events.find((e) => e.type === "message") as MessageEvent;
      expect(messageEvent).toBeDefined();
      expect(messageEvent.stopReason).toBe(StopReason.TOOL_USE);
      expect(messageEvent.message.content).toHaveLength(1);
      expect(messageEvent.message.content[0].type).toBe("tool_use");
      expect((messageEvent.message.content[0] as any).name).toBe("search");
      expect((messageEvent.message.content[0] as any).input).toEqual({ query: "test" });
    });

    it("should emit message event with reasoning content", async () => {
      const events: StreamEvent[] = [];

      const model = createModel<ModelInput, ModelOutput, ModelInput, ModelOutput, StreamEvent>({
        metadata: { id: "test-model", provider: "test", capabilities: [] },
        executors: {
          execute: vi.fn(),
          executeStream: async function* () {
            yield {
              type: "message_start",
              messageId: "msg-1",
              role: "assistant",
              model: "test-model",
              startedAt: new Date().toISOString(),
            } as MessageStartEvent;
            yield { type: "reasoning_start", blockIndex: 0 } as StreamEvent;
            yield {
              type: "reasoning_delta",
              delta: "Let me think...",
              blockIndex: 0,
            } as StreamEvent;
            yield { type: "reasoning_end", blockIndex: 0 } as StreamEvent;
            yield {
              type: "content_start",
              blockType: BlockType.TEXT,
              blockIndex: 1,
            } as ContentStartEvent;
            yield {
              type: "content_delta",
              blockType: BlockType.TEXT,
              blockIndex: 1,
              delta: "The answer is 42.",
            } as StreamEvent;
            yield {
              type: "content_end",
              blockType: BlockType.TEXT,
              blockIndex: 1,
            } as ContentEndEvent;
            yield {
              type: "message_end",
              stopReason: StopReason.STOP,
              usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            } as MessageEndEvent;
          },
        },
        fromEngineState,
        toEngineState,
      });

      const streamIterable = await model.stream!({
        messages: [
          { role: "user", content: [{ type: "text", text: "What is the meaning of life?" }] },
        ],
      });
      for await (const event of streamIterable) {
        events.push(event);
      }

      const messageEvent = events.find((e) => e.type === "message") as MessageEvent;
      expect(messageEvent).toBeDefined();
      expect(messageEvent.message.content).toHaveLength(2);
      expect(messageEvent.message.content[0].type).toBe("reasoning");
      expect((messageEvent.message.content[0] as any).text).toBe("Let me think...");
      expect(messageEvent.message.content[1].type).toBe("text");
      expect((messageEvent.message.content[1] as any).text).toBe("The answer is 42.");
    });

    it("should pass through events from adapter", async () => {
      const events: StreamEvent[] = [];

      const model = createModel<ModelInput, ModelOutput, ModelInput, ModelOutput, StreamEvent>({
        metadata: { id: "test-model", provider: "test", capabilities: [] },
        executors: {
          execute: vi.fn(),
          executeStream: async function* () {
            yield {
              type: "message_start",
              messageId: "msg-1",
              role: "assistant",
              model: "test-model",
              startedAt: new Date().toISOString(),
            } as MessageStartEvent;
            yield {
              type: "content_start",
              blockType: BlockType.TEXT,
              blockIndex: 0,
            } as ContentStartEvent;
            yield {
              type: "content_delta",
              blockType: BlockType.TEXT,
              blockIndex: 0,
              delta: "Hi",
            } as StreamEvent;
            yield {
              type: "content_end",
              blockType: BlockType.TEXT,
              blockIndex: 0,
            } as ContentEndEvent;
            yield {
              type: "message_end",
              stopReason: StopReason.STOP,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            } as MessageEndEvent;
          },
        },
        fromEngineState,
        toEngineState,
      });

      const streamIterable = await model.stream!({ messages: [] });
      for await (const event of streamIterable) {
        events.push(event);
      }

      // All adapter events should be present
      expect(events.some((e) => e.type === "message_start")).toBe(true);
      expect(events.some((e) => e.type === "content_start")).toBe(true);
      expect(events.some((e) => e.type === "content_delta")).toBe(true);
      expect(events.some((e) => e.type === "content_end")).toBe(true);
      expect(events.some((e) => e.type === "message_end")).toBe(true);
      // Plus the synthesized message event
      expect(events.some((e) => e.type === "message")).toBe(true);
    });
  });
});
