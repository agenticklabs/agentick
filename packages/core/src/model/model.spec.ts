/**
 * Model Tests
 *
 * Tests for createModel - the low-level model API.
 *
 * Note: createModel is a pass-through layer that doesn't accumulate or synthesize
 * the final `message` event. For that behavior, use createAdapter (tested in adapter.spec.ts).
 */

import { describe, it, expect, vi } from "vitest";
import { createModel, type ModelInput, type ModelOutput } from "./model";
import { fromEngineState, toEngineState } from "./utils/language-model";
import type {
  StreamEvent,
  ContentStartEvent,
  ContentEndEvent,
  MessageStartEvent,
  MessageEndEvent,
} from "@tentickle/shared";
import { BlockType, StopReason } from "@tentickle/shared";

describe("createModel", () => {
  describe("streaming", () => {
    it("should pass through all events from executor", async () => {
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

      expect(model.stream).toBeDefined();
      const streamIterable = await model.stream!(mockInput);
      for await (const event of streamIterable) {
        events.push(event);
      }

      // Verify all events are passed through
      expect(events).toHaveLength(5);
      expect(events[0].type).toBe("message_start");
      expect(events[1].type).toBe("content_start");
      expect(events[2].type).toBe("content_delta");
      expect(events[3].type).toBe("content_end");
      expect(events[4].type).toBe("message_end");

      // Verify message_end has correct data
      const messageEnd = events[4] as MessageEndEvent;
      expect(messageEnd.stopReason).toBe(StopReason.STOP);
      expect(messageEnd.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    });

    it("should pass through multiple content_delta events", async () => {
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

      // All deltas should be passed through
      const deltas = events.filter((e) => e.type === "content_delta");
      expect(deltas).toHaveLength(3);
      expect((deltas[0] as any).delta).toBe("Hello");
      expect((deltas[1] as any).delta).toBe(", ");
      expect((deltas[2] as any).delta).toBe("world!");
    });

    it("should pass through tool_call events", async () => {
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

      // Tool call event should be passed through
      const toolCall = events.find((e) => e.type === "tool_call") as any;
      expect(toolCall).toBeDefined();
      expect(toolCall.name).toBe("search");
      expect(toolCall.input).toEqual({ query: "test" });

      // Message end should have TOOL_USE stop reason
      const messageEnd = events.find((e) => e.type === "message_end") as MessageEndEvent;
      expect(messageEnd.stopReason).toBe(StopReason.TOOL_USE);
    });

    it("should pass through reasoning events", async () => {
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

      // Reasoning events should be passed through
      expect(events.some((e) => e.type === "reasoning_start")).toBe(true);
      expect(events.some((e) => e.type === "reasoning_delta")).toBe(true);
      expect(events.some((e) => e.type === "reasoning_end")).toBe(true);

      const reasoningDelta = events.find((e) => e.type === "reasoning_delta") as any;
      expect(reasoningDelta.delta).toBe("Let me think...");
    });

    it("should preserve event order from executor", async () => {
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

      // All events should be present in order
      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "message_start",
        "content_start",
        "content_delta",
        "content_end",
        "message_end",
      ]);
    });
  });
});
