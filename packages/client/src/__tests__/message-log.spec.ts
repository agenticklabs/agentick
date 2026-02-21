import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageLog } from "../message-log.js";
import { createMockClient, makeEvent } from "../testing.js";
import type { ChatMessage } from "../chat-types.js";
import type { ContentBlock, TimelineEntry } from "@agentick/shared";

function textBlock(text: string): ContentBlock {
  return { type: "text", text } as ContentBlock;
}

function toolUseBlock(id: string, name: string): ContentBlock {
  return { type: "tool_use", id, name, input: {} } as ContentBlock;
}

function makeTimelineEntry(overrides: {
  role: string;
  content: ContentBlock[];
  id?: string;
}): TimelineEntry {
  return {
    kind: "message",
    message: {
      id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
      role: overrides.role,
      content: overrides.content,
    },
  } as TimelineEntry;
}

function makeExecutionEndEvent(options: {
  newTimelineEntries?: TimelineEntry[];
  outputTimeline?: TimelineEntry[];
}) {
  return {
    ...makeEvent("execution_end"),
    newTimelineEntries: options.newTimelineEntries,
    output: options.outputTimeline ? { timeline: options.outputTimeline } : undefined,
  };
}

describe("MessageLog", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  describe("initial state", () => {
    it("starts with empty messages", () => {
      const log = new MessageLog(client, { sessionId: "s1" });
      expect(log.messages).toEqual([]);
      log.destroy();
    });

    it("initializes with provided messages", () => {
      const initial: ChatMessage[] = [
        { id: "u1", role: "user", content: "Hello" },
        { id: "a1", role: "assistant", content: "Hi!" },
      ];
      const log = new MessageLog(client, { sessionId: "s1", initialMessages: initial });
      expect(log.messages).toHaveLength(2);
      expect(log.messages[0].id).toBe("u1");
      log.destroy();
    });

    it("initialMessages sets messageCount for dedup", () => {
      const initial: ChatMessage[] = [
        { id: "u1", role: "user", content: "Hello" },
        { id: "a1", role: "assistant", content: "Hi!" },
      ];
      const log = new MessageLog(client, { sessionId: "s1", initialMessages: initial });

      const fullTimeline = [
        makeTimelineEntry({ role: "user", content: [textBlock("Hello")], id: "u1" }),
        makeTimelineEntry({ role: "assistant", content: [textBlock("Hi!")], id: "a1" }),
      ];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ outputTimeline: fullTimeline }));

      expect(log.messages).toHaveLength(2);
      log.destroy();
    });
  });

  describe("message accumulation", () => {
    it("accumulates from execution_end with delta", () => {
      const log = new MessageLog(client, { sessionId: "s1" });
      const delta = [
        makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" }),
        makeTimelineEntry({ role: "assistant", content: [textBlock("Hello!")], id: "a1" }),
      ];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta }));

      expect(log.messages).toHaveLength(2);
      expect(log.messages[0]).toMatchObject({ id: "u1", role: "user" });
      expect(log.messages[1]).toMatchObject({ id: "a1", role: "assistant" });
      log.destroy();
    });

    it("accumulates from execution_end with full timeline fallback", () => {
      const log = new MessageLog(client, { sessionId: "s1" });
      const timeline = [
        makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" }),
        makeTimelineEntry({ role: "assistant", content: [textBlock("Hello!")], id: "a1" }),
      ];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ outputTimeline: timeline }));

      expect(log.messages).toHaveLength(2);
      log.destroy();
    });

    it("deduplicates on subsequent execution_end with full timeline", () => {
      const log = new MessageLog(client, { sessionId: "s1" });

      const delta1 = [
        makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" }),
        makeTimelineEntry({ role: "assistant", content: [textBlock("Hello!")], id: "a1" }),
      ];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta1 }));
      expect(log.messages).toHaveLength(2);

      const fullTimeline = [
        makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" }),
        makeTimelineEntry({ role: "assistant", content: [textBlock("Hello!")], id: "a1" }),
        makeTimelineEntry({ role: "user", content: [textBlock("What's up?")], id: "u2" }),
        makeTimelineEntry({ role: "assistant", content: [textBlock("Not much!")], id: "a2" }),
      ];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ outputTimeline: fullTimeline }));

      expect(log.messages).toHaveLength(4);
      log.destroy();
    });
  });

  describe("tool duration tracking", () => {
    it("tracks tool_call_start/tool_result durations", () => {
      const log = new MessageLog(client, { sessionId: "s1" });
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(1000);

      client._emitSessionEvent("s1", { ...makeEvent("tool_call_start"), callId: "tc-1" } as any);
      nowSpy.mockReturnValue(1500);
      client._emitSessionEvent("s1", { ...makeEvent("tool_result"), callId: "tc-1" } as any);

      const delta = [
        makeTimelineEntry({
          role: "assistant",
          content: [textBlock("Done"), toolUseBlock("tc-1", "glob")],
          id: "a1",
        }),
      ];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta }));

      expect(log.messages[0].toolCalls).toEqual([
        { id: "tc-1", name: "glob", status: "done", duration: 500 },
      ]);

      nowSpy.mockRestore();
      log.destroy();
    });

    it("clears tool durations between executions", () => {
      const log = new MessageLog(client, { sessionId: "s1" });
      const nowSpy = vi.spyOn(Date, "now");

      // Execution 1: tool tc-1 takes 500ms
      nowSpy.mockReturnValue(1000);
      client._emitSessionEvent("s1", { ...makeEvent("tool_call_start"), callId: "tc-1" } as any);
      nowSpy.mockReturnValue(1500);
      client._emitSessionEvent("s1", { ...makeEvent("tool_result"), callId: "tc-1" } as any);

      const delta1 = [
        makeTimelineEntry({
          role: "assistant",
          content: [textBlock("Done"), toolUseBlock("tc-1", "glob")],
          id: "a1",
        }),
      ];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta1 }));
      expect(log.messages[0].toolCalls![0].duration).toBe(500);

      // Execution 2: tool tc-2 takes 200ms — tc-1 duration should NOT leak
      nowSpy.mockReturnValue(2000);
      client._emitSessionEvent("s1", { ...makeEvent("tool_call_start"), callId: "tc-2" } as any);
      nowSpy.mockReturnValue(2200);
      client._emitSessionEvent("s1", { ...makeEvent("tool_result"), callId: "tc-2" } as any);

      const delta2 = [
        makeTimelineEntry({
          role: "assistant",
          content: [textBlock("Again"), toolUseBlock("tc-1", "glob"), toolUseBlock("tc-2", "grep")],
          id: "a2",
        }),
      ];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta2 }));

      // tc-2 should have duration, tc-1 should NOT (stale from previous execution)
      const toolCalls = log.messages[1].toolCalls!;
      expect(toolCalls.find((t) => t.id === "tc-2")!.duration).toBe(200);
      expect(toolCalls.find((t) => t.id === "tc-1")!.duration).toBeUndefined();

      nowSpy.mockRestore();
      log.destroy();
    });
  });

  describe("subscribe: false (externally driven)", () => {
    it("does not self-subscribe when subscribe is false", () => {
      const log = new MessageLog(client, { sessionId: "s1", subscribe: false });

      const delta = [makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" })];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta }));

      // Should not have received the event
      expect(log.messages).toHaveLength(0);
      log.destroy();
    });

    it("processes events via processEvent() when externally driven", () => {
      const log = new MessageLog(client, { sessionId: "s1", subscribe: false });

      const delta = [makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" })];
      log.processEvent(makeExecutionEndEvent({ newTimelineEntries: delta }) as any);

      expect(log.messages).toHaveLength(1);
      log.destroy();
    });
  });

  describe("custom transform", () => {
    it("uses custom transform function", () => {
      const customTransform = vi.fn(() => [
        { id: "custom-1", role: "assistant" as const, content: "Custom!" },
      ]);

      const log = new MessageLog(client, {
        sessionId: "s1",
        transform: customTransform,
      });

      const delta = [makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" })];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta }));

      expect(customTransform).toHaveBeenCalledTimes(1);
      expect(log.messages[0].id).toBe("custom-1");
      log.destroy();
    });
  });

  describe("clear", () => {
    it("resets all state", () => {
      const log = new MessageLog(client, { sessionId: "s1" });

      const delta = [makeTimelineEntry({ role: "user", content: [textBlock("Hello")], id: "u1" })];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta }));
      expect(log.messages).toHaveLength(1);

      log.clear();
      expect(log.messages).toHaveLength(0);
      log.destroy();
    });
  });

  describe("snapshot / subscription", () => {
    it("notifies listeners on state change", () => {
      const log = new MessageLog(client, { sessionId: "s1" });
      const listener = vi.fn();
      log.onStateChange(listener);

      const delta = [makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" })];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta }));

      expect(listener).toHaveBeenCalledTimes(1);
      log.destroy();
    });

    it("unsubscribe stops notifications", () => {
      const log = new MessageLog(client, { sessionId: "s1" });
      const listener = vi.fn();
      const unsub = log.onStateChange(listener);

      unsub();

      const delta = [makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" })];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta }));

      expect(listener).not.toHaveBeenCalled();
      log.destroy();
    });

    it("snapshot is immutable — new reference on each change", () => {
      const log = new MessageLog(client, { sessionId: "s1" });
      const snap1 = log.state;

      const delta = [makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" })];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta }));
      const snap2 = log.state;

      expect(snap1).not.toBe(snap2);
      log.destroy();
    });
  });

  describe("destroy", () => {
    it("cleans up subscriptions", () => {
      const log = new MessageLog(client, { sessionId: "s1" });
      const listener = vi.fn();
      log.onStateChange(listener);

      log.destroy();

      const delta = [makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" })];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta }));
      expect(listener).not.toHaveBeenCalled();
    });

    it("double destroy is safe", () => {
      const log = new MessageLog(client, { sessionId: "s1" });
      log.destroy();
      expect(() => log.destroy()).not.toThrow();
    });
  });

  // =========================================================================
  // Progressive rendering modes
  // =========================================================================

  describe("renderMode: message", () => {
    it("adds assistant message on message event", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "message",
        subscribe: false,
      });

      log.processEvent({
        ...makeEvent("message"),
        message: { role: "assistant", content: [textBlock("Hello!")] },
        stopReason: "stop",
      } as any);

      expect(log.messages).toHaveLength(1);
      expect(log.messages[0].role).toBe("assistant");
      expect(log.messages[0].content).toEqual([textBlock("Hello!")]);
      log.destroy();
    });

    it("does not react to content or content_delta events", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "message",
        subscribe: false,
      });

      log.processEvent({ ...makeEvent("content_delta"), delta: "Hello" } as any);
      log.processEvent({ ...makeEvent("content"), content: textBlock("Hello") } as any);

      expect(log.messages).toHaveLength(0);
      log.destroy();
    });
  });

  describe("renderMode: block", () => {
    it("adds content blocks progressively", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "block",
        subscribe: false,
      });
      const listener = vi.fn();
      log.onStateChange(listener);

      // message_start creates in-progress
      log.processEvent(makeEvent("message_start") as any);

      // First content block
      log.processEvent({
        ...makeEvent("content"),
        blockIndex: 0,
        content: textBlock("First block"),
      } as any);

      // Should show in-progress message with one block
      expect(log.messages).toHaveLength(1);
      expect(log.messages[0].role).toBe("assistant");
      const content0 = log.messages[0].content as ContentBlock[];
      expect(content0).toHaveLength(1);
      expect((content0[0] as any).text).toBe("First block");

      // Second content block
      log.processEvent({
        ...makeEvent("content"),
        blockIndex: 1,
        content: textBlock("Second block"),
      } as any);

      expect(log.messages).toHaveLength(1);
      const content1 = log.messages[0].content as ContentBlock[];
      expect(content1).toHaveLength(2);

      // message_end finalizes
      log.processEvent({ ...makeEvent("message_end"), stopReason: "stop" } as any);

      expect(log.messages).toHaveLength(1);
      const finalContent = log.messages[0].content as ContentBlock[];
      expect(finalContent).toHaveLength(2);

      // Listener called multiple times (progressive updates)
      expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
      log.destroy();
    });

    it("adds tool calls progressively", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "block",
        subscribe: false,
      });

      log.processEvent(makeEvent("message_start") as any);
      log.processEvent({
        ...makeEvent("tool_call"),
        callId: "tc-1",
        name: "search",
        input: { q: "test" },
        blockIndex: 0,
      } as any);

      expect(log.messages).toHaveLength(1);
      expect(log.messages[0].toolCalls).toHaveLength(1);
      expect(log.messages[0].toolCalls![0].name).toBe("search");

      log.processEvent({ ...makeEvent("message_end"), stopReason: "tool_use" } as any);
      expect(log.messages).toHaveLength(1);
      log.destroy();
    });

    it("updates tool durations after message_end (tool_result arrives post-finalize)", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "block",
        subscribe: false,
      });
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(1000);

      // tool_call_start tracked for duration
      log.processEvent({ ...makeEvent("tool_call_start"), callId: "tc-1" } as any);

      log.processEvent(makeEvent("message_start") as any);
      log.processEvent({
        ...makeEvent("tool_call"),
        callId: "tc-1",
        name: "search",
        input: { q: "test" },
        blockIndex: 0,
      } as any);
      log.processEvent({ ...makeEvent("message_end"), stopReason: "tool_use" } as any);

      // Message is finalized — tool call exists but no duration yet
      expect(log.messages[0].toolCalls![0].duration).toBeUndefined();

      // tool_result arrives AFTER message_end
      nowSpy.mockReturnValue(1500);
      log.processEvent({ ...makeEvent("tool_result"), callId: "tc-1" } as any);

      // Duration should be updated on the finalized message
      expect(log.messages[0].toolCalls![0].duration).toBe(500);

      nowSpy.mockRestore();
      log.destroy();
    });

    it("does not react to content_delta events", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "block",
        subscribe: false,
      });

      log.processEvent(makeEvent("message_start") as any);
      log.processEvent({ ...makeEvent("content_delta"), delta: "Hello" } as any);

      // Only in-progress message with no content (deltas ignored in block mode)
      const content = log.messages[0]?.content as ContentBlock[] | undefined;
      expect(content ?? []).toHaveLength(0);
      log.destroy();
    });

    it("handles message event as fallback for non-streaming responses", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "block",
        subscribe: false,
      });

      log.processEvent({
        ...makeEvent("message"),
        message: { role: "assistant", content: [textBlock("Non-streamed")] },
      } as any);

      expect(log.messages).toHaveLength(1);
      expect((log.messages[0].content as ContentBlock[])[0]).toEqual(textBlock("Non-streamed"));
      log.destroy();
    });
  });

  describe("renderMode: streaming", () => {
    it("updates on each content_delta", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "streaming",
        subscribe: false,
      });

      log.processEvent(makeEvent("message_start") as any);
      log.processEvent({ ...makeEvent("content_start"), blockIndex: 0 } as any);
      log.processEvent({ ...makeEvent("content_delta"), delta: "Hel", blockIndex: 0 } as any);

      // In-progress message with in-progress block
      expect(log.messages).toHaveLength(1);
      const content = log.messages[0].content as ContentBlock[];
      expect(content).toHaveLength(1);
      expect((content[0] as any).text).toBe("Hel");

      log.processEvent({ ...makeEvent("content_delta"), delta: "lo!", blockIndex: 0 } as any);
      const content2 = log.messages[0].content as ContentBlock[];
      expect((content2[0] as any).text).toBe("Hello!");

      // content_end finalizes the block
      log.processEvent({ ...makeEvent("content_end"), blockIndex: 0 } as any);
      log.processEvent({ ...makeEvent("message_end"), stopReason: "stop" } as any);

      expect(log.messages).toHaveLength(1);
      const finalContent = log.messages[0].content as ContentBlock[];
      expect((finalContent[0] as any).text).toBe("Hello!");
      log.destroy();
    });

    it("handles content_delta without content_start", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "streaming",
        subscribe: false,
      });

      log.processEvent(makeEvent("message_start") as any);
      log.processEvent({ ...makeEvent("content_delta"), delta: "Hello" } as any);

      expect(log.messages).toHaveLength(1);
      const content = log.messages[0].content as ContentBlock[];
      expect((content[0] as any).text).toBe("Hello");
      log.destroy();
    });

    it("tracks streaming tool calls", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "streaming",
        subscribe: false,
      });

      log.processEvent(makeEvent("message_start") as any);
      log.processEvent({
        ...makeEvent("tool_call_start"),
        callId: "tc-1",
        name: "search",
      } as any);
      log.processEvent({
        ...makeEvent("tool_call_delta"),
        callId: "tc-1",
        delta: '{"q":"test"}',
      } as any);
      log.processEvent({
        ...makeEvent("tool_call_end"),
        callId: "tc-1",
      } as any);

      expect(log.messages).toHaveLength(1);
      expect(log.messages[0].toolCalls).toHaveLength(1);
      expect(log.messages[0].toolCalls![0].name).toBe("search");

      // Finalize
      // tool_call event (emitted by accumulator after tool_call_end) should be deduped
      log.processEvent({
        ...makeEvent("tool_call"),
        callId: "tc-1",
        name: "search",
        input: { q: "test" },
      } as any);

      // Should still only have 1 tool call (deduped)
      expect(log.messages[0].toolCalls).toHaveLength(1);
      log.destroy();
    });
  });

  describe("pushUserMessage", () => {
    it("adds user message immediately", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "block",
        subscribe: false,
      });

      log.pushUserMessage("Hello!");
      expect(log.messages).toHaveLength(1);
      expect(log.messages[0].role).toBe("user");
      expect(log.messages[0].content).toBe("Hello!");
      log.destroy();
    });

    it("prevents duplicate user messages at execution_end", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "block",
        subscribe: false,
      });

      log.pushUserMessage("Hello!");

      // Simulate stream events
      log.processEvent({
        ...makeEvent("message"),
        message: { role: "assistant", content: [textBlock("Hi!")] },
      } as any);

      // execution_end with timeline that includes the user message
      const delta = [
        makeTimelineEntry({ role: "user", content: [textBlock("Hello!")], id: "u1" }),
        makeTimelineEntry({ role: "assistant", content: [textBlock("Hi!")], id: "a1" }),
      ];
      log.processEvent(makeExecutionEndEvent({ newTimelineEntries: delta }) as any);

      // Should have: pushed user message + message event assistant = 2
      // Should NOT duplicate the user message from timeline
      expect(log.messages).toHaveLength(2);
      expect(log.messages[0].role).toBe("user");
      expect(log.messages[1].role).toBe("assistant");
      log.destroy();
    });
  });

  describe("reasoning in progressive modes", () => {
    it("adds reasoning blocks in block mode", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "block",
        subscribe: false,
      });

      log.processEvent(makeEvent("message_start") as any);
      log.processEvent({
        ...makeEvent("reasoning"),
        blockIndex: 0,
        reasoning: "Let me think about this...",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T00:00:01Z",
      } as any);

      expect(log.messages).toHaveLength(1);
      const content = log.messages[0].content as ContentBlock[];
      expect(content).toHaveLength(1);
      expect((content[0] as any).type).toBe("reasoning");
      expect((content[0] as any).text).toBe("Let me think about this...");
      log.destroy();
    });

    it("streams reasoning deltas in streaming mode", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "streaming",
        subscribe: false,
      });

      log.processEvent(makeEvent("message_start") as any);
      log.processEvent({ ...makeEvent("reasoning_start"), blockIndex: 0 } as any);
      log.processEvent({ ...makeEvent("reasoning_delta"), delta: "Let me ", blockIndex: 0 } as any);
      log.processEvent({ ...makeEvent("reasoning_delta"), delta: "think", blockIndex: 0 } as any);

      // In-progress reasoning block visible in snapshot
      expect(log.messages).toHaveLength(1);
      const content = log.messages[0].content as ContentBlock[];
      expect(content).toHaveLength(1);
      expect((content[0] as any).type).toBe("reasoning");
      expect((content[0] as any).text).toBe("Let me think");

      // Finalize reasoning block
      log.processEvent({ ...makeEvent("reasoning_end"), blockIndex: 0 } as any);

      const finalContent = log.messages[0].content as ContentBlock[];
      expect(finalContent).toHaveLength(1);
      expect((finalContent[0] as any).type).toBe("reasoning");
      expect((finalContent[0] as any).text).toBe("Let me think");
      log.destroy();
    });

    it("handles reasoning followed by content in streaming mode", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "streaming",
        subscribe: false,
      });

      log.processEvent(makeEvent("message_start") as any);

      // Reasoning phase
      log.processEvent({ ...makeEvent("reasoning_start"), blockIndex: 0 } as any);
      log.processEvent({
        ...makeEvent("reasoning_delta"),
        delta: "Thinking...",
        blockIndex: 0,
      } as any);
      log.processEvent({ ...makeEvent("reasoning_end"), blockIndex: 0 } as any);

      // Content phase
      log.processEvent({ ...makeEvent("content_start"), blockIndex: 1 } as any);
      log.processEvent({ ...makeEvent("content_delta"), delta: "Hello!", blockIndex: 1 } as any);
      log.processEvent({ ...makeEvent("content_end"), blockIndex: 1 } as any);

      log.processEvent({ ...makeEvent("message_end"), stopReason: "stop" } as any);

      expect(log.messages).toHaveLength(1);
      const content = log.messages[0].content as ContentBlock[];
      expect(content).toHaveLength(2);
      expect((content[0] as any).type).toBe("reasoning");
      expect((content[0] as any).text).toBe("Thinking...");
      expect((content[1] as any).type).toBe("text");
      expect((content[1] as any).text).toBe("Hello!");
      log.destroy();
    });

    it("ignores reasoning events in message mode", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "message",
        subscribe: false,
      });

      // These should all be ignored
      log.processEvent({ ...makeEvent("reasoning_start"), blockIndex: 0 } as any);
      log.processEvent({
        ...makeEvent("reasoning_delta"),
        delta: "Thinking",
        blockIndex: 0,
      } as any);
      log.processEvent({ ...makeEvent("reasoning_end"), blockIndex: 0 } as any);
      log.processEvent({
        ...makeEvent("reasoning"),
        blockIndex: 0,
        reasoning: "Full reasoning",
      } as any);

      // No messages should be created from reasoning events alone
      expect(log.messages).toHaveLength(0);
      log.destroy();
    });
  });

  describe("execution_end in progressive mode", () => {
    it("finalizes leftover in-progress message", () => {
      const log = new MessageLog(client, {
        sessionId: "s1",
        renderMode: "block",
        subscribe: false,
      });

      log.processEvent(makeEvent("message_start") as any);
      log.processEvent({
        ...makeEvent("content"),
        blockIndex: 0,
        content: textBlock("Partial"),
      } as any);

      // No message_end — execution_end should finalize
      log.processEvent(makeExecutionEndEvent({}) as any);

      expect(log.messages).toHaveLength(1);
      expect(log.messages[0].role).toBe("assistant");
      const content = log.messages[0].content as ContentBlock[];
      expect((content[0] as any).text).toBe("Partial");
      log.destroy();
    });
  });
});
