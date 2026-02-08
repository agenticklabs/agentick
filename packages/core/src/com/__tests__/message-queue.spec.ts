/**
 * COM Message Queue Tests
 *
 * These tests verify the message queuing and timeline management
 * functionality of the Context Object Model (COM).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { COM } from "../object-model";
import type { Message } from "@agentick/shared";

describe("COM Message Queue", () => {
  let ctx: COM;

  beforeEach(() => {
    ctx = new COM();
  });

  describe("queueMessage", () => {
    it("should queue a user message", () => {
      ctx.queueMessage({
        id: "msg-1",
        type: "user",
        content: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      });

      const queued = ctx.getQueuedMessages();
      expect(queued.length).toBe(1);
      expect(queued[0].type).toBe("user");
    });

    it("should queue multiple messages", () => {
      ctx.queueMessage({
        id: "msg-1",
        type: "user",
        content: { role: "user", content: [{ type: "text", text: "First" }] },
      });

      ctx.queueMessage({
        id: "msg-2",
        type: "user",
        content: { role: "user", content: [{ type: "text", text: "Second" }] },
      });

      const queued = ctx.getQueuedMessages();
      expect(queued.length).toBe(2);
    });

    it("should preserve message order", () => {
      ctx.queueMessage({
        id: "msg-1",
        type: "user",
        content: { role: "user", content: [{ type: "text", text: "First" }] },
      });

      ctx.queueMessage({
        id: "msg-2",
        type: "user",
        content: { role: "user", content: [{ type: "text", text: "Second" }] },
      });

      const queued = ctx.getQueuedMessages();
      expect((queued[0].content as any).content[0].text).toBe("First");
      expect((queued[1].content as any).content[0].text).toBe("Second");
    });
  });

  describe("getQueuedMessages", () => {
    it("should return empty array when no messages queued", () => {
      const queued = ctx.getQueuedMessages();
      expect(queued).toEqual([]);
    });

    it("should return copy of queued messages", () => {
      ctx.queueMessage({
        id: "msg-1",
        type: "user",
        content: { role: "user", content: [{ type: "text", text: "Test" }] },
      });

      const queued1 = ctx.getQueuedMessages();
      const queued2 = ctx.getQueuedMessages();

      // Should be different array instances
      expect(queued1).not.toBe(queued2);
      // But same content
      expect(queued1).toEqual(queued2);
    });
  });

  describe("clearQueuedMessages", () => {
    it("should clear all queued messages", () => {
      ctx.queueMessage({
        id: "msg-1",
        type: "user",
        content: { role: "user", content: [{ type: "text", text: "Test" }] },
      });

      expect(ctx.getQueuedMessages().length).toBe(1);

      ctx.clearQueuedMessages();

      expect(ctx.getQueuedMessages().length).toBe(0);
    });
  });

  describe("clear() behavior", () => {
    it("should NOT clear queued messages on clear()", () => {
      ctx.queueMessage({
        id: "msg-1",
        type: "user",
        content: { role: "user", content: [{ type: "text", text: "Test" }] },
      });

      ctx.clear();

      // Queued messages should persist through clear()
      expect(ctx.getQueuedMessages().length).toBe(1);
    });

    it("should clear timeline on clear()", () => {
      ctx.addMessage({
        role: "user",
        content: [{ type: "text", text: "Timeline message" }],
      });

      expect(ctx.getTimeline().length).toBe(1);

      ctx.clear();

      expect(ctx.getTimeline().length).toBe(0);
    });
  });
});

describe("COM Timeline", () => {
  let ctx: COM;

  beforeEach(() => {
    ctx = new COM();
  });

  describe("addMessage", () => {
    it("should add user message to timeline", () => {
      ctx.addMessage({
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      });

      const timeline = ctx.getTimeline();
      expect(timeline.length).toBe(1);
      expect(timeline[0].message?.role).toBe("user");
    });

    it("should add assistant message to timeline", () => {
      ctx.addMessage({
        role: "assistant",
        content: [{ type: "text", text: "Response" }],
      });

      const timeline = ctx.getTimeline();
      expect(timeline.length).toBe(1);
      expect(timeline[0].message?.role).toBe("assistant");
    });

    it("should route system message to systemMessages", () => {
      ctx.addMessage({
        role: "system",
        content: [{ type: "text", text: "System prompt" }],
      });

      // Timeline should not contain system message
      const timeline = ctx.getTimeline();
      expect(timeline.length).toBe(0);

      // System messages should be in separate array
      const systemMessages = ctx.getSystemMessages();
      expect(systemMessages.length).toBe(1);
    });

    it("should set kind to 'message'", () => {
      ctx.addMessage({
        role: "user",
        content: [{ type: "text", text: "Test" }],
      });

      const timeline = ctx.getTimeline();
      expect(timeline[0].kind).toBe("message");
    });

    it("should include tags when provided", () => {
      ctx.addMessage(
        {
          role: "user",
          content: [{ type: "text", text: "Tagged" }],
        },
        { tags: ["user_input"] as any },
      );

      const timeline = ctx.getTimeline();
      expect(timeline[0].tags).toContain("user_input");
    });
  });

  describe("getTimeline", () => {
    it("should return empty array when no messages", () => {
      const timeline = ctx.getTimeline();
      expect(timeline).toEqual([]);
    });

    it("should return messages in order added", () => {
      ctx.addMessage({
        role: "user",
        content: [{ type: "text", text: "First" }],
      });

      ctx.addMessage({
        role: "assistant",
        content: [{ type: "text", text: "Second" }],
      });

      ctx.addMessage({
        role: "user",
        content: [{ type: "text", text: "Third" }],
      });

      const timeline = ctx.getTimeline();
      expect(timeline.length).toBe(3);
      expect(timeline[0].message?.content[0]).toEqual({ type: "text", text: "First" });
      expect(timeline[1].message?.content[0]).toEqual({ type: "text", text: "Second" });
      expect(timeline[2].message?.content[0]).toEqual({ type: "text", text: "Third" });
    });
  });

  describe("toInput", () => {
    it("should include timeline in toInput()", () => {
      ctx.addMessage({
        role: "user",
        content: [{ type: "text", text: "Test" }],
      });

      const input = ctx.toInput();

      expect(input.timeline.length).toBe(1);
      expect(input.timeline[0].message?.role).toBe("user");
    });

    it("should include system messages in toInput()", () => {
      ctx.addMessage({
        role: "system",
        content: [{ type: "text", text: "System" }],
      });

      const input = ctx.toInput();

      expect(input.system.length).toBe(1);
      expect(input.system[0].message?.role).toBe("system");
    });

    it("should include tools in toInput()", async () => {
      await ctx.addTool({
        metadata: {
          name: "test_tool",
          description: "A test tool",
        },
        definition: {
          name: "test_tool",
          description: "A test tool",
          input: { type: "object", properties: {} },
        },
        handler: async () => ({ result: "ok" }),
      } as any);

      const input = ctx.toInput();

      expect(input.tools.length).toBe(1);
      expect(input.tools[0].name).toBe("test_tool");
    });
  });
});

describe("COM Integration", () => {
  describe("queue to timeline flow", () => {
    it("should allow queued messages to be added to timeline", () => {
      const ctx = new COM();

      // Queue a message (simulating session.send)
      ctx.queueMessage({
        id: "msg-1",
        type: "user",
        content: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      });

      // Clear timeline (simulating start of compileTick)
      ctx.clear();

      // Get queued messages and add to timeline (simulating our fix)
      const queued = ctx.getQueuedMessages();
      for (const q of queued) {
        if (
          q.type === "user" &&
          q.content &&
          typeof q.content === "object" &&
          "role" in q.content
        ) {
          ctx.addMessage(q.content as Message);
        }
      }

      // Timeline should now have the message
      const timeline = ctx.getTimeline();
      expect(timeline.length).toBe(1);
      expect(timeline[0].message?.role).toBe("user");

      // toInput should include the message
      const input = ctx.toInput();
      expect(input.timeline.length).toBe(1);
    });
  });
});
