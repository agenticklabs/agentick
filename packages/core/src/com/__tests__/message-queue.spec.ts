/**
 * COM Message Queue Tests
 *
 * These tests verify the message queuing and timeline management
 * functionality of the Context Object Model (COM).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { COM } from "../object-model";
import type { Message } from "@tentickle/shared";

describe("COM Message Queue", () => {
  let com: COM;

  beforeEach(() => {
    com = new COM();
  });

  describe("queueMessage", () => {
    it("should queue a user message", () => {
      com.queueMessage({
        id: "msg-1",
        type: "user",
        content: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      });

      const queued = com.getQueuedMessages();
      expect(queued.length).toBe(1);
      expect(queued[0].type).toBe("user");
    });

    it("should queue multiple messages", () => {
      com.queueMessage({
        id: "msg-1",
        type: "user",
        content: { role: "user", content: [{ type: "text", text: "First" }] },
      });

      com.queueMessage({
        id: "msg-2",
        type: "user",
        content: { role: "user", content: [{ type: "text", text: "Second" }] },
      });

      const queued = com.getQueuedMessages();
      expect(queued.length).toBe(2);
    });

    it("should preserve message order", () => {
      com.queueMessage({
        id: "msg-1",
        type: "user",
        content: { role: "user", content: [{ type: "text", text: "First" }] },
      });

      com.queueMessage({
        id: "msg-2",
        type: "user",
        content: { role: "user", content: [{ type: "text", text: "Second" }] },
      });

      const queued = com.getQueuedMessages();
      expect((queued[0].content as any).content[0].text).toBe("First");
      expect((queued[1].content as any).content[0].text).toBe("Second");
    });
  });

  describe("getQueuedMessages", () => {
    it("should return empty array when no messages queued", () => {
      const queued = com.getQueuedMessages();
      expect(queued).toEqual([]);
    });

    it("should return copy of queued messages", () => {
      com.queueMessage({
        id: "msg-1",
        type: "user",
        content: { role: "user", content: [{ type: "text", text: "Test" }] },
      });

      const queued1 = com.getQueuedMessages();
      const queued2 = com.getQueuedMessages();

      // Should be different array instances
      expect(queued1).not.toBe(queued2);
      // But same content
      expect(queued1).toEqual(queued2);
    });
  });

  describe("clearQueuedMessages", () => {
    it("should clear all queued messages", () => {
      com.queueMessage({
        id: "msg-1",
        type: "user",
        content: { role: "user", content: [{ type: "text", text: "Test" }] },
      });

      expect(com.getQueuedMessages().length).toBe(1);

      com.clearQueuedMessages();

      expect(com.getQueuedMessages().length).toBe(0);
    });
  });

  describe("clear() behavior", () => {
    it("should NOT clear queued messages on clear()", () => {
      com.queueMessage({
        id: "msg-1",
        type: "user",
        content: { role: "user", content: [{ type: "text", text: "Test" }] },
      });

      com.clear();

      // Queued messages should persist through clear()
      expect(com.getQueuedMessages().length).toBe(1);
    });

    it("should clear timeline on clear()", () => {
      com.addMessage({
        role: "user",
        content: [{ type: "text", text: "Timeline message" }],
      });

      expect(com.getTimeline().length).toBe(1);

      com.clear();

      expect(com.getTimeline().length).toBe(0);
    });
  });
});

describe("COM Timeline", () => {
  let com: COM;

  beforeEach(() => {
    com = new COM();
  });

  describe("addMessage", () => {
    it("should add user message to timeline", () => {
      com.addMessage({
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      });

      const timeline = com.getTimeline();
      expect(timeline.length).toBe(1);
      expect(timeline[0].message?.role).toBe("user");
    });

    it("should add assistant message to timeline", () => {
      com.addMessage({
        role: "assistant",
        content: [{ type: "text", text: "Response" }],
      });

      const timeline = com.getTimeline();
      expect(timeline.length).toBe(1);
      expect(timeline[0].message?.role).toBe("assistant");
    });

    it("should route system message to systemMessages", () => {
      com.addMessage({
        role: "system",
        content: [{ type: "text", text: "System prompt" }],
      });

      // Timeline should not contain system message
      const timeline = com.getTimeline();
      expect(timeline.length).toBe(0);

      // System messages should be in separate array
      const systemMessages = com.getSystemMessages();
      expect(systemMessages.length).toBe(1);
    });

    it("should set kind to 'message'", () => {
      com.addMessage({
        role: "user",
        content: [{ type: "text", text: "Test" }],
      });

      const timeline = com.getTimeline();
      expect(timeline[0].kind).toBe("message");
    });

    it("should include tags when provided", () => {
      com.addMessage(
        {
          role: "user",
          content: [{ type: "text", text: "Tagged" }],
        },
        { tags: ["user_input"] as any },
      );

      const timeline = com.getTimeline();
      expect(timeline[0].tags).toContain("user_input");
    });
  });

  describe("getTimeline", () => {
    it("should return empty array when no messages", () => {
      const timeline = com.getTimeline();
      expect(timeline).toEqual([]);
    });

    it("should return messages in order added", () => {
      com.addMessage({
        role: "user",
        content: [{ type: "text", text: "First" }],
      });

      com.addMessage({
        role: "assistant",
        content: [{ type: "text", text: "Second" }],
      });

      com.addMessage({
        role: "user",
        content: [{ type: "text", text: "Third" }],
      });

      const timeline = com.getTimeline();
      expect(timeline.length).toBe(3);
      expect(timeline[0].message?.content[0]).toEqual({ type: "text", text: "First" });
      expect(timeline[1].message?.content[0]).toEqual({ type: "text", text: "Second" });
      expect(timeline[2].message?.content[0]).toEqual({ type: "text", text: "Third" });
    });
  });

  describe("toInput", () => {
    it("should include timeline in toInput()", () => {
      com.addMessage({
        role: "user",
        content: [{ type: "text", text: "Test" }],
      });

      const input = com.toInput();

      expect(input.timeline.length).toBe(1);
      expect(input.timeline[0].message?.role).toBe("user");
    });

    it("should include system messages in toInput()", () => {
      com.addMessage({
        role: "system",
        content: [{ type: "text", text: "System" }],
      });

      const input = com.toInput();

      expect(input.system.length).toBe(1);
      expect(input.system[0].message?.role).toBe("system");
    });

    it("should include tools in toInput()", async () => {
      await com.addTool({
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

      const input = com.toInput();

      expect(input.tools.length).toBe(1);
      expect(input.tools[0].name).toBe("test_tool");
    });
  });
});

describe("COM Integration", () => {
  describe("queue to timeline flow", () => {
    it("should allow queued messages to be added to timeline", () => {
      const com = new COM();

      // Queue a message (simulating session.send)
      com.queueMessage({
        id: "msg-1",
        type: "user",
        content: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      });

      // Clear timeline (simulating start of compileTick)
      com.clear();

      // Get queued messages and add to timeline (simulating our fix)
      const queued = com.getQueuedMessages();
      for (const q of queued) {
        if (
          q.type === "user" &&
          q.content &&
          typeof q.content === "object" &&
          "role" in q.content
        ) {
          com.addMessage(q.content as Message);
        }
      }

      // Timeline should now have the message
      const timeline = com.getTimeline();
      expect(timeline.length).toBe(1);
      expect(timeline[0].message?.role).toBe("user");

      // toInput should include the message
      const input = com.toInput();
      expect(input.timeline.length).toBe(1);
    });
  });
});
