import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageLog } from "../message-log";
import { createMockClient, makeEvent } from "../testing";
import type { ChatMessage } from "../chat-types";
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
});
