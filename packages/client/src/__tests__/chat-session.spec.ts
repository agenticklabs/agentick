import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatSession } from "../chat-session.js";
import { createMockClient, makeEvent } from "../testing.js";
import type { ChatMessage, TimelineEntry } from "../chat-types.js";
import type { ContentBlock } from "@agentick/shared";

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
  };
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

describe("ChatSession", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient(vi.fn);
  });

  describe("initial state", () => {
    it("starts with empty messages by default", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      expect(session.messages).toEqual([]);
      expect(session.chatMode).toBe("idle");
      expect(session.toolConfirmation).toBeNull();
      expect(session.lastSubmitted).toBeNull();
      expect(session.isExecuting).toBe(false);

      session.destroy();
    });

    it("initializes with provided messages", () => {
      const initial: ChatMessage[] = [
        { id: "u1", role: "user", content: "Hello", toolCalls: undefined },
        { id: "a1", role: "assistant", content: "Hi!", toolCalls: undefined },
      ];

      const session = new ChatSession(client, {
        sessionId: "s1",
        initialMessages: initial,
      });

      expect(session.messages).toHaveLength(2);
      expect(session.messages[0].id).toBe("u1");
      expect(session.messages[1].id).toBe("a1");

      session.destroy();
    });

    it("initialMessages sets messageCount for dedup", () => {
      const initial: ChatMessage[] = [
        { id: "u1", role: "user", content: "Hello" },
        { id: "a1", role: "assistant", content: "Hi!" },
      ];

      const session = new ChatSession(client, {
        sessionId: "s1",
        initialMessages: initial,
      });

      // Simulate execution_end with full timeline that includes the initial messages
      const fullTimeline = [
        makeTimelineEntry({ role: "user", content: [textBlock("Hello")], id: "u1" }),
        makeTimelineEntry({ role: "assistant", content: [textBlock("Hi!")], id: "a1" }),
      ];

      client._emitSessionEvent("s1", makeExecutionEndEvent({ outputTimeline: fullTimeline }));

      // Should not re-add existing messages
      expect(session.messages).toHaveLength(2);

      session.destroy();
    });
  });

  describe("message accumulation", () => {
    it("accumulates messages from execution_end with delta", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      const delta = [
        makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" }),
        makeTimelineEntry({ role: "assistant", content: [textBlock("Hello!")], id: "a1" }),
      ];

      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta }));

      expect(session.messages).toHaveLength(2);
      expect(session.messages[0]).toMatchObject({ id: "u1", role: "user" });
      expect(session.messages[1]).toMatchObject({ id: "a1", role: "assistant" });

      session.destroy();
    });

    it("accumulates messages from execution_end with full timeline fallback", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      const timeline = [
        makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" }),
        makeTimelineEntry({ role: "assistant", content: [textBlock("Hello!")], id: "a1" }),
      ];

      client._emitSessionEvent("s1", makeExecutionEndEvent({ outputTimeline: timeline }));

      expect(session.messages).toHaveLength(2);

      session.destroy();
    });

    it("deduplicates on subsequent execution_end with full timeline", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      // First execution
      const delta1 = [
        makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" }),
        makeTimelineEntry({ role: "assistant", content: [textBlock("Hello!")], id: "a1" }),
      ];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta1 }));
      expect(session.messages).toHaveLength(2);

      // Second execution with full timeline
      const fullTimeline = [
        makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" }),
        makeTimelineEntry({ role: "assistant", content: [textBlock("Hello!")], id: "a1" }),
        makeTimelineEntry({ role: "user", content: [textBlock("What's up?")], id: "u2" }),
        makeTimelineEntry({ role: "assistant", content: [textBlock("Not much!")], id: "a2" }),
      ];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ outputTimeline: fullTimeline }));

      expect(session.messages).toHaveLength(4);

      session.destroy();
    });
  });

  describe("chatMode transitions", () => {
    it("idle → streaming → idle", () => {
      const session = new ChatSession(client, { sessionId: "s1" });
      const listener = vi.fn();
      session.onStateChange(listener);

      expect(session.chatMode).toBe("idle");

      client._emitSessionEvent("s1", makeEvent("execution_start"));
      expect(session.chatMode).toBe("streaming");

      client._emitSessionEvent("s1", makeExecutionEndEvent({}));
      expect(session.chatMode).toBe("idle");

      session.destroy();
    });

    it("idle → streaming → confirming_tool → streaming → idle", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      client._emitSessionEvent("s1", makeEvent("execution_start"));
      expect(session.chatMode).toBe("streaming");

      client._emitToolConfirmation("s1", {
        toolUseId: "tu-1",
        name: "write_file",
        arguments: { path: "/test.ts" },
      });
      expect(session.chatMode).toBe("confirming_tool");
      expect(session.toolConfirmation).not.toBeNull();
      expect(session.toolConfirmation!.request.name).toBe("write_file");

      session.respondToConfirmation({ approved: true });
      expect(session.chatMode).toBe("streaming");
      expect(session.toolConfirmation).toBeNull();

      client._emitSessionEvent("s1", makeExecutionEndEvent({}));
      expect(session.chatMode).toBe("idle");

      session.destroy();
    });
  });

  describe("tool duration tracking", () => {
    it("tracks tool_call_start/tool_result durations", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(1000);

      client._emitSessionEvent("s1", {
        ...makeEvent("tool_call_start"),
        callId: "tc-1",
      } as any);

      nowSpy.mockReturnValue(1500);

      client._emitSessionEvent("s1", {
        ...makeEvent("tool_result"),
        callId: "tc-1",
      } as any);

      // Now trigger execution_end with a message containing that tool call
      const delta = [
        makeTimelineEntry({
          role: "assistant",
          content: [textBlock("Done"), toolUseBlock("tc-1", "glob")],
          id: "a1",
        }),
      ];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta }));

      expect(session.messages[0].toolCalls).toEqual([
        { id: "tc-1", name: "glob", status: "done", duration: 500 },
      ]);

      nowSpy.mockRestore();
      session.destroy();
    });
  });

  describe("respondToConfirmation", () => {
    it("calls respond function and resumes streaming", () => {
      const session = new ChatSession(client, { sessionId: "s1" });
      const respondFn = vi.fn();

      // Execution must be active for chatMode to derive correctly
      client._emitSessionEvent("s1", makeEvent("execution_start"));

      client._emitToolConfirmation(
        "s1",
        { toolUseId: "tu-1", name: "shell", arguments: { cmd: "rm -rf /" } },
        respondFn,
      );

      expect(session.chatMode).toBe("confirming_tool");

      session.respondToConfirmation({ approved: false, reason: "dangerous" });

      expect(respondFn).toHaveBeenCalledWith({ approved: false, reason: "dangerous" });
      expect(session.chatMode).toBe("streaming");
      expect(session.toolConfirmation).toBeNull();

      session.destroy();
    });

    it("is a no-op without pending confirmation", () => {
      const session = new ChatSession(client, { sessionId: "s1" });
      const listener = vi.fn();
      session.onStateChange(listener);

      session.respondToConfirmation({ approved: true });

      expect(listener).not.toHaveBeenCalled();

      session.destroy();
    });
  });

  describe("submit and lastSubmitted", () => {
    it("sets lastSubmitted on submit", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      session.submit("Hello");

      expect(session.lastSubmitted).toBe("Hello");

      session.destroy();
    });

    it("clears lastSubmitted on execution_end", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      session.submit("Hello");
      expect(session.lastSubmitted).toBe("Hello");

      client._emitSessionEvent("s1", makeExecutionEndEvent({}));
      expect(session.lastSubmitted).toBeNull();

      session.destroy();
    });
  });

  describe("delegation to steering", () => {
    it("submit delegates to steering", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      session.submit("Hello");

      expect(client.send).toHaveBeenCalledWith(
        { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] },
        { sessionId: "s1" },
      );

      session.destroy();
    });

    it("queue delegates to steering", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      session.queue("Later");

      expect(session.queued).toHaveLength(1);

      session.destroy();
    });

    it("steer delegates to steering", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      session.steer("Force");

      expect(client.send).toHaveBeenCalledWith(
        { messages: [{ role: "user", content: [{ type: "text", text: "Force" }] }] },
        { sessionId: "s1" },
      );

      session.destroy();
    });

    it("interrupt delegates to steering", async () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      await session.interrupt("Stop");

      const accessor = client.getAccessor("s1");
      expect(accessor.interrupt).toHaveBeenCalled();

      session.destroy();
    });

    it("flush delegates to steering", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      session.queue("A");
      session.queue("B");
      session.flush();

      expect(client.send).toHaveBeenCalled();

      session.destroy();
    });

    it("setMode delegates to steering", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      session.setMode("queue");
      expect(session.mode).toBe("queue");

      session.destroy();
    });
  });

  describe("clearMessages", () => {
    it("resets all message state", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      // Accumulate some state
      session.submit("Hello");
      session.queue("Queued");

      const delta = [
        makeTimelineEntry({ role: "user", content: [textBlock("Hello")], id: "u1" }),
        makeTimelineEntry({ role: "assistant", content: [textBlock("Hi!")], id: "a1" }),
      ];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta }));

      expect(session.messages).toHaveLength(2);

      session.clearMessages();

      expect(session.messages).toHaveLength(0);
      expect(session.lastSubmitted).toBeNull();
      expect(session.queued).toHaveLength(0);

      session.destroy();
    });
  });

  describe("snapshot / subscription", () => {
    it("onStateChange fires on state mutation", () => {
      const session = new ChatSession(client, { sessionId: "s1" });
      const listener = vi.fn();
      session.onStateChange(listener);

      session.submit("test");

      expect(listener).toHaveBeenCalledTimes(1);

      session.destroy();
    });

    it("snapshot is immutable — new reference on each change", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      const snap1 = session.state;
      session.submit("test");
      const snap2 = session.state;

      expect(snap1).not.toBe(snap2);

      session.destroy();
    });

    it("unsubscribe stops notifications", () => {
      const session = new ChatSession(client, { sessionId: "s1" });
      const listener = vi.fn();
      const unsub = session.onStateChange(listener);

      session.submit("first");
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      session.submit("second");
      expect(listener).toHaveBeenCalledTimes(1);

      session.destroy();
    });
  });

  describe("option passthrough", () => {
    it("transform option customizes message extraction", () => {
      const customTransform = vi
        .fn()
        .mockReturnValue([{ id: "custom-1", role: "assistant", content: "transformed" }]);

      const session = new ChatSession(client, {
        sessionId: "s1",
        transform: customTransform,
      });

      const delta = [makeTimelineEntry({ role: "user", content: [textBlock("Hi")], id: "u1" })];
      client._emitSessionEvent("s1", makeExecutionEndEvent({ newTimelineEntries: delta }));

      expect(customTransform).toHaveBeenCalledTimes(1);
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].id).toBe("custom-1");

      session.destroy();
    });

    it("confirmationPolicy auto-approves matching tools", () => {
      const respondFn = vi.fn();
      const session = new ChatSession(client, {
        sessionId: "s1",
        confirmationPolicy: (req) =>
          req.name === "read_file" ? { action: "approve" } : { action: "prompt" },
      });

      // Auto-approved — not surfaced as pending
      client._emitToolConfirmation(
        "s1",
        { toolUseId: "tu-1", name: "read_file", arguments: {} },
        respondFn,
      );
      expect(session.toolConfirmation).toBeNull();
      expect(respondFn).toHaveBeenCalledWith({ approved: true });

      // Prompted — surfaced as pending
      client._emitToolConfirmation("s1", {
        toolUseId: "tu-2",
        name: "write_file",
        arguments: {},
      });
      expect(session.toolConfirmation).not.toBeNull();
      expect(session.toolConfirmation!.request.name).toBe("write_file");

      session.destroy();
    });

    it("deriveMode customizes chatMode derivation", () => {
      type CustomMode = "idle" | "working" | "needs_approval";

      const session = new ChatSession<CustomMode>(client, {
        sessionId: "s1",
        deriveMode: ({ isExecuting, hasPendingConfirmation }) => {
          if (hasPendingConfirmation) return "needs_approval";
          if (isExecuting) return "working";
          return "idle";
        },
      });

      expect(session.chatMode).toBe("idle");

      client._emitSessionEvent("s1", makeEvent("execution_start"));
      expect(session.chatMode).toBe("working");

      client._emitToolConfirmation("s1", {
        toolUseId: "tu-1",
        name: "shell",
        arguments: {},
      });
      expect(session.chatMode).toBe("needs_approval");

      session.destroy();
    });

    it("onEvent fires for every event before processing", () => {
      const onEvent = vi.fn();
      const session = new ChatSession(client, {
        sessionId: "s1",
        onEvent,
      });

      client._emitSessionEvent("s1", makeEvent("execution_start"));
      client._emitSessionEvent("s1", makeExecutionEndEvent({}));

      expect(onEvent).toHaveBeenCalledTimes(2);
      expect(onEvent.mock.calls[0][0].type).toBe("execution_start");
      expect(onEvent.mock.calls[1][0].type).toBe("execution_end");

      session.destroy();
    });

    it("steering options (mode, flushMode) pass through", () => {
      const session = new ChatSession(client, {
        sessionId: "s1",
        mode: "queue",
        flushMode: "batched",
      });

      expect(session.mode).toBe("queue");

      // In queue mode during execution, submit queues instead of sending
      client._emitSessionEvent("s1", makeEvent("execution_start"));
      session.submit("A");
      session.submit("B");
      expect(session.queued).toHaveLength(2);
      expect(client.send).toHaveBeenCalledTimes(0);

      // On execution_end with autoFlush, batched mode sends all queued as one
      client._emitSessionEvent("s1", makeExecutionEndEvent({}));
      expect(session.queued).toHaveLength(0);
      expect(client.send).toHaveBeenCalledTimes(1);
      const sentMessages = (client.send as any).mock.calls[0][0].messages;
      expect(sentMessages).toHaveLength(2);

      session.destroy();
    });
  });

  describe("autoSubscribe", () => {
    it("subscribes to SSE transport by default", () => {
      const session = new ChatSession(client, { sessionId: "s1" });
      const accessor = client.getAccessor("s1");

      expect(accessor.subscribe).toHaveBeenCalledTimes(1);

      session.destroy();
      expect(accessor.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("does not subscribe when autoSubscribe is false", () => {
      const session = new ChatSession(client, {
        sessionId: "s1",
        autoSubscribe: false,
      });
      const accessor = client.getAccessor("s1");

      expect(accessor.subscribe).not.toHaveBeenCalled();

      session.destroy();
      expect(accessor.unsubscribe).not.toHaveBeenCalled();
    });

    it("does not subscribe without sessionId", () => {
      const session = new ChatSession(client);

      expect(client.session).not.toHaveBeenCalled();

      session.destroy();
    });
  });

  describe("destroy", () => {
    it("cleans up all subscriptions", () => {
      const session = new ChatSession(client, { sessionId: "s1" });
      const listener = vi.fn();
      session.onStateChange(listener);

      session.destroy();

      client._emitSessionEvent("s1", makeEvent("execution_start"));
      expect(listener).not.toHaveBeenCalled();
    });

    it("double destroy is safe", () => {
      const session = new ChatSession(client, { sessionId: "s1" });

      session.destroy();
      expect(() => session.destroy()).not.toThrow();
    });
  });
});
