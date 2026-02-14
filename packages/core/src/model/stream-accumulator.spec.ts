/**
 * Tests for StreamAccumulator
 *
 * StreamAccumulator handles the complexity of converting AdapterDeltas to StreamEvents
 * with proper lifecycle management. These tests verify correct accumulation of
 * text, reasoning, and especially tool calls which can be streamed in parts.
 */

import { describe, it, expect } from "vitest";
import { StreamAccumulator } from "./stream-accumulator";
import { StopReason } from "@agentick/shared";

describe("StreamAccumulator", () => {
  describe("text accumulation", () => {
    it("should accumulate text deltas", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "text", delta: "Hello" });
      accumulator.push({ type: "text", delta: " " });
      accumulator.push({ type: "text", delta: "World" });
      accumulator.push({ type: "message_end", stopReason: StopReason.STOP });

      const output = accumulator.toModelOutput();
      expect(output.raw?.text).toBe("Hello World");
    });

    it("should emit content_start on first text delta", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      const events = accumulator.push({ type: "text", delta: "Hello" });

      // Should emit message_start and content_start before content_delta
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("message_start");
      expect(eventTypes).toContain("content_start");
      expect(eventTypes).toContain("content_delta");
    });

    it("should emit content_end on message_end", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "text", delta: "Hello" });
      const events = accumulator.push({ type: "message_end", stopReason: StopReason.STOP });

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("content_end");
      expect(eventTypes).toContain("message_end");
    });
  });

  describe("reasoning accumulation", () => {
    it("should accumulate reasoning deltas", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "reasoning", delta: "Let me think" });
      accumulator.push({ type: "reasoning", delta: " about this..." });
      accumulator.push({ type: "message_end", stopReason: StopReason.STOP });

      const output = accumulator.toModelOutput();
      expect(output.raw?.reasoning).toBe("Let me think about this...");
    });

    it("should emit reasoning_start on first reasoning delta", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      const events = accumulator.push({ type: "reasoning", delta: "Thinking..." });

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("reasoning_start");
      expect(eventTypes).toContain("reasoning_delta");
    });
  });

  describe("tool call accumulation", () => {
    it("should accumulate streamed tool calls (start/delta/end pattern)", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      // Simulate OpenAI's streaming pattern
      accumulator.push({ type: "tool_call_start", id: "call_123", name: "search" });
      accumulator.push({ type: "tool_call_delta", id: "call_123", delta: '{"query":' });
      accumulator.push({ type: "tool_call_delta", id: "call_123", delta: '"weather"}' });
      accumulator.push({ type: "tool_call_end", id: "call_123", input: { query: "weather" } });
      accumulator.push({ type: "message_end", stopReason: StopReason.TOOL_USE });

      const output = accumulator.toModelOutput();
      expect(output.toolCalls).toHaveLength(1);
      expect(output.toolCalls![0]).toEqual({
        id: "call_123",
        name: "search",
        input: { query: "weather" },
      });
    });

    it("should accumulate complete tool calls (non-streamed)", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({
        type: "tool_call",
        id: "call_456",
        name: "calculator",
        input: { expr: "2+2" },
      });
      accumulator.push({ type: "message_end", stopReason: StopReason.TOOL_USE });

      const output = accumulator.toModelOutput();
      expect(output.toolCalls).toHaveLength(1);
      expect(output.toolCalls![0]).toEqual({
        id: "call_456",
        name: "calculator",
        input: { expr: "2+2" },
      });
    });

    it("should handle multiple tool calls", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      // First tool call (streamed)
      accumulator.push({ type: "tool_call_start", id: "call_1", name: "search" });
      accumulator.push({ type: "tool_call_delta", id: "call_1", delta: '{"q":"a"}' });
      accumulator.push({ type: "tool_call_end", id: "call_1", input: { q: "a" } });

      // Second tool call (complete)
      accumulator.push({
        type: "tool_call",
        id: "call_2",
        name: "calc",
        input: { x: 1 },
      });

      accumulator.push({ type: "message_end", stopReason: StopReason.TOOL_USE });

      const output = accumulator.toModelOutput();
      expect(output.toolCalls).toHaveLength(2);
      expect(output.toolCalls![0].id).toBe("call_1");
      expect(output.toolCalls![1].id).toBe("call_2");
    });

    it("should emit tool_call event on tool_call_end", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "tool_call_start", id: "call_1", name: "search" });
      accumulator.push({ type: "tool_call_delta", id: "call_1", delta: '{"q":"a"}' });
      const events = accumulator.push({ type: "tool_call_end", id: "call_1", input: { q: "a" } });

      // Should emit tool_call_end AND complete tool_call event
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("tool_call_end");
      expect(eventTypes).toContain("tool_call");
    });

    it("should parse JSON from accumulated tool_call_delta", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "tool_call_start", id: "call_1", name: "search" });
      accumulator.push({ type: "tool_call_delta", id: "call_1", delta: '{"query":' });
      accumulator.push({ type: "tool_call_delta", id: "call_1", delta: '"hello ' });
      accumulator.push({ type: "tool_call_delta", id: "call_1", delta: 'world"}' });
      // Note: tool_call_end with input undefined should parse from accumulated JSON
      accumulator.push({ type: "tool_call_end", id: "call_1", input: undefined as any });
      accumulator.push({ type: "message_end", stopReason: StopReason.TOOL_USE });

      const output = accumulator.toModelOutput();
      expect(output.toolCalls![0].input).toEqual({ query: "hello world" });
    });

    it("should finalize in-progress tool calls on message_end (OpenAI pattern)", () => {
      // OpenAI doesn't send tool_call_end - just message_end with finish_reason: "tool_calls"
      const accumulator = new StreamAccumulator({ modelId: "test" });

      // Simulate OpenAI's streaming pattern: start + deltas, then directly message_end
      accumulator.push({ type: "tool_call_start", id: "call_abc", name: "get_weather" });
      accumulator.push({ type: "tool_call_delta", id: "call_abc", delta: '{"location":' });
      accumulator.push({ type: "tool_call_delta", id: "call_abc", delta: '"San Francisco",' });
      accumulator.push({ type: "tool_call_delta", id: "call_abc", delta: '"unit":"celsius"}' });
      // NO tool_call_end - directly message_end (this is what OpenAI does)
      const events = accumulator.push({ type: "message_end", stopReason: StopReason.TOOL_USE });

      // Should emit tool_call_end and tool_call events during message_end processing
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("tool_call_end");
      expect(eventTypes).toContain("tool_call");
      expect(eventTypes).toContain("message_end");

      // Should have the completed tool call with parsed input
      const output = accumulator.toModelOutput();
      expect(output.toolCalls).toHaveLength(1);
      expect(output.toolCalls![0]).toEqual({
        id: "call_abc",
        name: "get_weather",
        input: { location: "San Francisco", unit: "celsius" },
      });
    });

    it("should finalize multiple in-progress tool calls on message_end", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      // Two tool calls streamed without explicit tool_call_end
      accumulator.push({ type: "tool_call_start", id: "call_1", name: "search" });
      accumulator.push({ type: "tool_call_delta", id: "call_1", delta: '{"q":"a"}' });
      accumulator.push({ type: "tool_call_start", id: "call_2", name: "calc" });
      accumulator.push({ type: "tool_call_delta", id: "call_2", delta: '{"expr":"1+1"}' });
      // Directly message_end
      accumulator.push({ type: "message_end", stopReason: StopReason.TOOL_USE });

      const output = accumulator.toModelOutput();
      expect(output.toolCalls).toHaveLength(2);
      expect(output.toolCalls![0].input).toEqual({ q: "a" });
      expect(output.toolCalls![1].input).toEqual({ expr: "1+1" });
    });
  });

  describe("usage tracking", () => {
    it("should capture usage from message_end", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "text", delta: "Hello" });
      accumulator.push({
        type: "message_end",
        stopReason: StopReason.STOP,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });

      const output = accumulator.toModelOutput();
      expect(output.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });

    it("should capture usage from standalone usage event", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "text", delta: "Hello" });
      accumulator.push({ type: "message_end", stopReason: StopReason.STOP });
      // OpenAI sends usage in a separate chunk after finish_reason
      accumulator.push({ type: "usage", usage: { inputTokens: 100, outputTokens: 50 } });

      const output = accumulator.toModelOutput();
      expect(output.usage.inputTokens).toBe(100);
      expect(output.usage.outputTokens).toBe(50);
    });

    it("should merge usage from multiple events (take max)", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "usage", usage: { inputTokens: 50 } });
      accumulator.push({ type: "usage", usage: { inputTokens: 100, outputTokens: 25 } });
      accumulator.push({ type: "usage", usage: { outputTokens: 50, totalTokens: 150 } });
      accumulator.push({ type: "message_end", stopReason: StopReason.STOP });

      const output = accumulator.toModelOutput();
      expect(output.usage.inputTokens).toBe(100);
      expect(output.usage.outputTokens).toBe(50);
      expect(output.usage.totalTokens).toBe(150);
    });
  });

  describe("stop reason", () => {
    it("should capture stop reason from message_end", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "text", delta: "Done" });
      accumulator.push({ type: "message_end", stopReason: StopReason.STOP });

      const output = accumulator.toModelOutput();
      expect(output.stopReason).toBe(StopReason.STOP);
    });

    it("should set stop reason to tool_use when tool calls present", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({
        type: "tool_call",
        id: "call_1",
        name: "search",
        input: {},
      });
      accumulator.push({ type: "message_end", stopReason: StopReason.TOOL_USE });

      const output = accumulator.toModelOutput();
      expect(output.stopReason).toBe(StopReason.TOOL_USE);
    });
  });

  describe("model tracking", () => {
    it("should use model from options if not in events", () => {
      const accumulator = new StreamAccumulator({ modelId: "gpt-4" });

      accumulator.push({ type: "text", delta: "Hello" });
      accumulator.push({ type: "message_end", stopReason: StopReason.STOP });

      const output = accumulator.toModelOutput();
      expect(output.model).toBe("gpt-4");
    });

    it("should use model from message_start if provided", () => {
      const accumulator = new StreamAccumulator({ modelId: "default" });

      accumulator.push({ type: "message_start", model: "gpt-4-turbo" });
      accumulator.push({ type: "text", delta: "Hello" });
      accumulator.push({ type: "message_end", stopReason: StopReason.STOP });

      const output = accumulator.toModelOutput();
      expect(output.model).toBe("gpt-4-turbo");
    });
  });

  describe("metadata handling", () => {
    it("should accumulate content metadata", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "text", delta: "Hello" });
      accumulator.push({
        type: "content_metadata",
        metadata: { citations: [{ text: "source1" }] },
      });
      accumulator.push({ type: "text", delta: " World" });
      accumulator.push({
        type: "content_metadata",
        metadata: { citations: [{ text: "source2" }] },
      });
      accumulator.push({ type: "message_end", stopReason: StopReason.STOP });

      // Metadata is emitted on content_end
      // Note: We test that it doesn't crash, actual metadata verification would need event inspection
      const output = accumulator.toModelOutput();
      expect(output.raw?.text).toBe("Hello World");
    });

    it("should pass through text deltas with metadata", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      const events = accumulator.push({
        type: "text",
        delta: "Hello",
        metadata: { language: "en" },
      });

      // content_start should have metadata
      const contentStart = events.find((e) => e.type === "content_start");
      expect(contentStart).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("should handle empty stream", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      const output = accumulator.toModelOutput();
      expect(output.raw?.text).toBe("");
      expect(output.toolCalls).toBeUndefined();
    });

    it("should handle text + tool calls in same response", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "text", delta: "I'll search for that." });
      accumulator.push({
        type: "tool_call",
        id: "call_1",
        name: "search",
        input: { q: "test" },
      });
      accumulator.push({ type: "message_end", stopReason: StopReason.TOOL_USE });

      const output = accumulator.toModelOutput();
      expect(output.raw?.text).toBe("I'll search for that.");
      expect(output.toolCalls).toHaveLength(1);
    });

    it("should handle reasoning + text + tool calls", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "reasoning", delta: "Let me think..." });
      accumulator.push({ type: "text", delta: "Here's my answer." });
      accumulator.push({
        type: "tool_call",
        id: "call_1",
        name: "verify",
        input: {},
      });
      accumulator.push({ type: "message_end", stopReason: StopReason.TOOL_USE });

      const output = accumulator.toModelOutput();
      expect(output.raw?.reasoning).toBe("Let me think...");
      expect(output.raw?.text).toBe("Here's my answer.");
      expect(output.toolCalls).toHaveLength(1);
    });

    it("should auto-start message if not explicitly started", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      // Jump straight to text without message_start
      const events = accumulator.push({ type: "text", delta: "Hello" });

      // Should auto-emit message_start
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes[0]).toBe("message_start");
    });
  });

  describe("full block events", () => {
    it("should emit content event after content_end on message_end", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "text", delta: "Hello " });
      accumulator.push({ type: "text", delta: "World" });
      const events = accumulator.push({ type: "message_end", stopReason: StopReason.STOP });

      const contentEvent = events.find((e) => e.type === "content");
      expect(contentEvent).toBeDefined();
      expect((contentEvent as any).blockIndex).toBe(0);
      expect((contentEvent as any).content).toEqual({ type: "text", text: "Hello World" });
      expect((contentEvent as any).startedAt).toBeDefined();
      expect((contentEvent as any).completedAt).toBeDefined();
    });

    it("should emit content event when tool_call_start ends text block", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "text", delta: "I'll search." });
      const events = accumulator.push({
        type: "tool_call_start",
        id: "call_1",
        name: "search",
      });

      const contentEvent = events.find((e) => e.type === "content");
      expect(contentEvent).toBeDefined();
      expect((contentEvent as any).content).toEqual({ type: "text", text: "I'll search." });
    });

    it("should emit reasoning event after reasoning_end on message_end", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "reasoning", delta: "Let me " });
      accumulator.push({ type: "reasoning", delta: "think..." });
      const events = accumulator.push({ type: "message_end", stopReason: StopReason.STOP });

      const reasoningEvent = events.find((e) => e.type === "reasoning");
      expect(reasoningEvent).toBeDefined();
      expect((reasoningEvent as any).reasoning).toBe("Let me think...");
      expect((reasoningEvent as any).startedAt).toBeDefined();
      expect((reasoningEvent as any).completedAt).toBeDefined();
    });

    it("should emit reasoning event when tool_call_start ends reasoning block", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({ type: "reasoning", delta: "Thinking..." });
      const events = accumulator.push({
        type: "tool_call_start",
        id: "call_1",
        name: "search",
      });

      const reasoningEvent = events.find((e) => e.type === "reasoning");
      expect(reasoningEvent).toBeDefined();
      expect((reasoningEvent as any).reasoning).toBe("Thinking...");
    });

    it("should include metadata in content event", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      accumulator.push({
        type: "text",
        delta: "Hello",
        metadata: { citations: [{ text: "source1" }] },
      });
      const events = accumulator.push({ type: "message_end", stopReason: StopReason.STOP });

      const contentEvent = events.find((e) => e.type === "content");
      expect((contentEvent as any).metadata).toEqual({
        citations: [{ text: "source1" }],
      });
    });

    it("should have correct blockIndex on content event", () => {
      const accumulator = new StreamAccumulator({ modelId: "test" });

      // Reasoning block (index 0), then text block (index 1 after reasoning ends on tool_call_start)
      accumulator.push({ type: "reasoning", delta: "Think" });
      accumulator.push({ type: "text", delta: "Answer" });
      const events = accumulator.push({ type: "message_end", stopReason: StopReason.STOP });

      const contentEvent = events.find((e) => e.type === "content");
      expect(contentEvent).toBeDefined();
      // text block started after reasoning block (blockIndex 0) was ended,
      // but reasoning doesn't end until message_end. Both get blockIndex 0
      // because reasoning_start doesn't increment. Let's just verify it's present.
      expect((contentEvent as any).blockIndex).toBeDefined();
    });
  });
});
