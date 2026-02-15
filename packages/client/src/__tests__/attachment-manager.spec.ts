import { describe, it, expect, vi } from "vitest";
import {
  AttachmentManager,
  defaultAttachmentValidator,
  defaultAttachmentToBlock,
} from "../attachment-manager";
import { MessageSteering } from "../message-steering";
import { ChatSession } from "../chat-session";
import { createMockClient, makeEvent } from "../testing";
import type { Attachment } from "../chat-types";
import type { ContentBlock } from "@agentick/shared";

describe("AttachmentManager", () => {
  describe("initial state", () => {
    it("starts empty", () => {
      const mgr = new AttachmentManager();
      expect(mgr.count).toBe(0);
      expect(mgr.isEmpty).toBe(true);
      expect(mgr.attachments).toEqual([]);
    });
  });

  describe("add()", () => {
    it("adds with base64 string source", () => {
      const mgr = new AttachmentManager();
      const att = mgr.add({
        name: "photo.png",
        mimeType: "image/png",
        source: "iVBORw0KGgo=",
      });

      expect(att.id).toMatch(/^att_/);
      expect(att.name).toBe("photo.png");
      expect(att.mimeType).toBe("image/png");
      expect(att.source).toEqual({ type: "base64", data: "iVBORw0KGgo=" });
      expect(mgr.count).toBe(1);
      expect(mgr.isEmpty).toBe(false);
    });

    it("adds with URL string source", () => {
      const mgr = new AttachmentManager();
      const att = mgr.add({
        name: "image.jpg",
        mimeType: "image/jpeg",
        source: "https://example.com/image.jpg",
      });

      expect(att.source).toEqual({ type: "url", url: "https://example.com/image.jpg" });
    });

    it("adds with data: URL", () => {
      const mgr = new AttachmentManager();
      const att = mgr.add({
        name: "img.png",
        mimeType: "image/png",
        source: "data:image/png;base64,abc123",
      });

      expect(att.source).toEqual({ type: "url", url: "data:image/png;base64,abc123" });
    });

    it("adds with blob: URL", () => {
      const mgr = new AttachmentManager();
      const att = mgr.add({
        name: "capture.png",
        mimeType: "image/png",
        source: "blob:https://example.com/abc-123",
      });

      expect(att.source).toEqual({ type: "url", url: "blob:https://example.com/abc-123" });
    });

    it("adds with structured source (passthrough)", () => {
      const mgr = new AttachmentManager();
      const att = mgr.add({
        name: "doc.pdf",
        mimeType: "application/pdf",
        source: { type: "base64", data: "JVBERi0=" },
      });

      expect(att.source).toEqual({ type: "base64", data: "JVBERi0=" });
    });

    it("preserves optional size", () => {
      const mgr = new AttachmentManager();
      const att = mgr.add({
        name: "photo.png",
        mimeType: "image/png",
        source: "abc",
        size: 1024,
      });

      expect(att.size).toBe(1024);
    });

    it("throws on validation failure", () => {
      const mgr = new AttachmentManager();

      expect(() => mgr.add({ name: "file.txt", mimeType: "text/plain", source: "abc" })).toThrow(
        "Invalid attachment: Unsupported mime type: text/plain",
      );
    });

    it("throws when max attachments reached", () => {
      const mgr = new AttachmentManager({ maxAttachments: 2 });

      mgr.add({ name: "a.png", mimeType: "image/png", source: "a" });
      mgr.add({ name: "b.png", mimeType: "image/png", source: "b" });

      expect(() => mgr.add({ name: "c.png", mimeType: "image/png", source: "c" })).toThrow(
        "Maximum attachments (2) reached",
      );
    });

    it("uses custom validator", () => {
      const mgr = new AttachmentManager({
        validator: (input) =>
          input.name.endsWith(".png")
            ? { valid: true }
            : { valid: false, reason: "Only PNG allowed" },
      });

      expect(() => mgr.add({ name: "photo.jpg", mimeType: "image/jpeg", source: "abc" })).toThrow(
        "Invalid attachment: Only PNG allowed",
      );

      const att = mgr.add({ name: "photo.png", mimeType: "image/png", source: "abc" });
      expect(att.name).toBe("photo.png");
    });
  });

  describe("remove()", () => {
    it("removes by ID", () => {
      const mgr = new AttachmentManager();
      const att = mgr.add({ name: "a.png", mimeType: "image/png", source: "a" });

      mgr.remove(att.id);

      expect(mgr.count).toBe(0);
      expect(mgr.isEmpty).toBe(true);
    });

    it("is a no-op for unknown ID", () => {
      const mgr = new AttachmentManager();
      mgr.add({ name: "a.png", mimeType: "image/png", source: "a" });

      const listener = vi.fn();
      mgr.onStateChange(listener);

      mgr.remove("nonexistent");

      expect(mgr.count).toBe(1);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("clear()", () => {
    it("empties the list", () => {
      const mgr = new AttachmentManager();
      mgr.add({ name: "a.png", mimeType: "image/png", source: "a" });
      mgr.add({ name: "b.png", mimeType: "image/png", source: "b" });

      mgr.clear();

      expect(mgr.count).toBe(0);
      expect(mgr.isEmpty).toBe(true);
    });

    it("is a no-op when already empty", () => {
      const mgr = new AttachmentManager();
      const listener = vi.fn();
      mgr.onStateChange(listener);

      mgr.clear();

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("consume()", () => {
    it("returns empty array when no attachments", () => {
      const mgr = new AttachmentManager();
      expect(mgr.consume()).toEqual([]);
    });

    it("converts image to ImageBlock and clears atomically", () => {
      const mgr = new AttachmentManager();
      mgr.add({
        name: "photo.png",
        mimeType: "image/png",
        source: { type: "base64", data: "abc" },
      });

      const blocks = mgr.consume();

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({
        type: "image",
        source: { type: "base64", data: "abc" },
        mimeType: "image/png",
      });
      expect(mgr.count).toBe(0);
    });

    it("converts PDF to DocumentBlock with title", () => {
      const mgr = new AttachmentManager();
      mgr.add({
        name: "report.pdf",
        mimeType: "application/pdf",
        source: { type: "base64", data: "JVBERi0=" },
      });

      const blocks = mgr.consume();

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({
        type: "document",
        source: { type: "base64", data: "JVBERi0=" },
        mimeType: "application/pdf",
        title: "report.pdf",
      });
    });

    it("uses custom toBlock mapper", () => {
      const mgr = new AttachmentManager({
        toBlock: (att) => ({ type: "text", text: `[File: ${att.name}]` }) as ContentBlock,
      });

      mgr.add({ name: "a.png", mimeType: "image/png", source: "abc" });

      const blocks = mgr.consume();
      expect(blocks).toEqual([{ type: "text", text: "[File: a.png]" }]);
    });

    it("handles multiple attachments", () => {
      const mgr = new AttachmentManager();
      mgr.add({ name: "a.png", mimeType: "image/png", source: "a" });
      mgr.add({ name: "b.pdf", mimeType: "application/pdf", source: "b" });

      const blocks = mgr.consume();

      expect(blocks).toHaveLength(2);
      expect((blocks[0] as any).type).toBe("image");
      expect((blocks[1] as any).type).toBe("document");
      expect(mgr.count).toBe(0);
    });
  });

  describe("onStateChange", () => {
    it("notifies on add", () => {
      const mgr = new AttachmentManager();
      const listener = vi.fn();
      mgr.onStateChange(listener);

      mgr.add({ name: "a.png", mimeType: "image/png", source: "a" });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies on remove", () => {
      const mgr = new AttachmentManager();
      const att = mgr.add({ name: "a.png", mimeType: "image/png", source: "a" });

      const listener = vi.fn();
      mgr.onStateChange(listener);

      mgr.remove(att.id);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies on clear", () => {
      const mgr = new AttachmentManager();
      mgr.add({ name: "a.png", mimeType: "image/png", source: "a" });

      const listener = vi.fn();
      mgr.onStateChange(listener);

      mgr.clear();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies on consume", () => {
      const mgr = new AttachmentManager();
      mgr.add({ name: "a.png", mimeType: "image/png", source: "a" });

      const listener = vi.fn();
      mgr.onStateChange(listener);

      mgr.consume();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("does not notify on empty consume", () => {
      const mgr = new AttachmentManager();
      const listener = vi.fn();
      mgr.onStateChange(listener);

      mgr.consume();

      expect(listener).not.toHaveBeenCalled();
    });

    it("unsubscribe stops notifications", () => {
      const mgr = new AttachmentManager();
      const listener = vi.fn();
      const unsub = mgr.onStateChange(listener);

      mgr.add({ name: "a.png", mimeType: "image/png", source: "a" });
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      mgr.add({ name: "b.png", mimeType: "image/png", source: "b" });
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe("consume() error handling", () => {
    it("preserves attachments if toBlock throws", () => {
      let callCount = 0;
      const mgr = new AttachmentManager({
        toBlock: (att) => {
          callCount++;
          if (callCount === 2) throw new Error("mapper failed");
          return { type: "text", text: att.name } as ContentBlock;
        },
      });

      mgr.add({ name: "a.png", mimeType: "image/png", source: "a" });
      mgr.add({ name: "b.png", mimeType: "image/png", source: "b" });

      expect(() => mgr.consume()).toThrow("mapper failed");
      // Attachments should NOT have been cleared
      expect(mgr.count).toBe(2);
    });
  });

  describe("destroy()", () => {
    it("clears attachments and silences listeners", () => {
      const mgr = new AttachmentManager();
      mgr.add({ name: "a.png", mimeType: "image/png", source: "a" });

      const listener = vi.fn();
      mgr.onStateChange(listener);

      mgr.destroy();

      expect(mgr.count).toBe(0);

      // After destroy, adding should not notify the old listener.
      // Use a custom validator to bypass the default (which would reject
      // after destroy since _attachments is empty, count < max is fine).
      // Actually, we can just add — the manager still works, listeners are just gone.
      const mgr2 = new AttachmentManager();
      const listener2 = vi.fn();
      mgr2.onStateChange(listener2);
      mgr2.add({ name: "x.png", mimeType: "image/png", source: "x" });
      mgr2.destroy();
      mgr2.add({ name: "y.png", mimeType: "image/png", source: "y" });
      // listener2 was called once (for x.png), but not for y.png after destroy
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  describe("defaultAttachmentValidator", () => {
    it("accepts supported types", () => {
      for (const mime of [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/pdf",
      ]) {
        expect(defaultAttachmentValidator({ name: "f", mimeType: mime, source: "a" })).toEqual({
          valid: true,
        });
      }
    });

    it("rejects unsupported types", () => {
      const result = defaultAttachmentValidator({ name: "f", mimeType: "text/plain", source: "a" });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain("text/plain");
      }
    });
  });

  describe("defaultAttachmentToBlock", () => {
    it("maps image/* to ImageBlock", () => {
      const att: Attachment = {
        id: "att_1",
        name: "photo.png",
        mimeType: "image/png",
        source: { type: "base64", data: "abc" },
      };

      const block = defaultAttachmentToBlock(att);
      expect(block).toEqual({
        type: "image",
        source: { type: "base64", data: "abc" },
        mimeType: "image/png",
      });
    });

    it("maps non-image to DocumentBlock", () => {
      const att: Attachment = {
        id: "att_1",
        name: "report.pdf",
        mimeType: "application/pdf",
        source: { type: "url", url: "https://example.com/report.pdf" },
      };

      const block = defaultAttachmentToBlock(att);
      expect(block).toEqual({
        type: "document",
        source: { type: "url", url: "https://example.com/report.pdf" },
        mimeType: "application/pdf",
        title: "report.pdf",
      });
    });
  });
});

describe("ChatSession attachment integration", () => {
  it("submit with pending attachments sends extraBlocks and clears", () => {
    const client = createMockClient(vi.fn);
    const session = new ChatSession(client, { sessionId: "s1" });

    session.attachments.add({
      name: "photo.png",
      mimeType: "image/png",
      source: { type: "base64", data: "abc" },
    });

    expect(session.state.attachments).toHaveLength(1);

    session.submit("Describe this image");

    // Attachments should be consumed (cleared)
    expect(session.state.attachments).toHaveLength(0);

    // The send call should contain the image block before the text block
    expect(client.send).toHaveBeenCalledWith(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", data: "abc" }, mimeType: "image/png" },
              { type: "text", text: "Describe this image" },
            ],
          },
        ],
      },
      { sessionId: "s1" },
    );

    session.destroy();
  });

  it("submit without attachments sends text only", () => {
    const client = createMockClient(vi.fn);
    const session = new ChatSession(client, { sessionId: "s1" });

    session.submit("Hello");

    expect(client.send).toHaveBeenCalledWith(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      },
      { sessionId: "s1" },
    );

    session.destroy();
  });

  it("attachment add triggers ChatSession state change", () => {
    const client = createMockClient(vi.fn);
    const session = new ChatSession(client, { sessionId: "s1" });
    const listener = vi.fn();
    session.onStateChange(listener);

    session.attachments.add({
      name: "a.png",
      mimeType: "image/png",
      source: "abc",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.state.attachments).toHaveLength(1);

    session.destroy();
  });

  it("attachments in snapshot after add", () => {
    const client = createMockClient(vi.fn);
    const session = new ChatSession(client, { sessionId: "s1" });

    session.attachments.add({
      name: "doc.pdf",
      mimeType: "application/pdf",
      source: "JVBERi0=",
    });

    const snap = session.state;
    expect(snap.attachments).toHaveLength(1);
    expect(snap.attachments[0].name).toBe("doc.pdf");

    session.destroy();
  });

  it("submit with renderMode includes extraBlocks in pushed user message", () => {
    const client = createMockClient(vi.fn);
    const session = new ChatSession(client, {
      sessionId: "s1",
      renderMode: "streaming",
    });

    session.attachments.add({
      name: "photo.png",
      mimeType: "image/png",
      source: { type: "base64", data: "abc" },
    });

    session.submit("What is this?");

    // In renderMode, the user message is pushed immediately with multimodal content
    const userMsg = session.messages[0];
    expect(userMsg.role).toBe("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    const blocks = userMsg.content as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as any).type).toBe("image");
    expect((blocks[1] as any).type).toBe("text");
    expect((blocks[1] as any).text).toBe("What is this?");

    session.destroy();
  });

  it("submit in queue mode during execution queues message with attachments", () => {
    const client = createMockClient(vi.fn);
    const session = new ChatSession(client, {
      sessionId: "s1",
      mode: "queue",
    });

    // Start execution so queue mode kicks in
    client._emitSessionEvent("s1", makeEvent("execution_start"));

    session.attachments.add({
      name: "photo.png",
      mimeType: "image/png",
      source: { type: "base64", data: "abc" },
    });

    session.submit("Describe this");

    // Should have been queued, not sent
    expect(client.send).not.toHaveBeenCalled();
    expect(session.queued).toHaveLength(1);

    // The queued message should have the image block + text block
    const queued = session.queued[0];
    expect(Array.isArray(queued.content)).toBe(true);
    const blocks = queued.content as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as any).type).toBe("image");
    expect((blocks[1] as any).type).toBe("text");

    // Attachments should be consumed
    expect(session.state.attachments).toHaveLength(0);

    session.destroy();
  });
});

describe("MessageLog pushUserMessage", () => {
  // We need to import MessageLog
  it("pushUserMessage with extraBlocks produces ContentBlock[] content", async () => {
    const { MessageLog } = await import("../message-log");
    const client = createMockClient(vi.fn);
    const log = new MessageLog(client, { sessionId: "s1", renderMode: "block" });

    const imageBlock = {
      type: "image",
      source: { type: "base64", data: "abc" },
      mimeType: "image/png",
    } as ContentBlock;

    log.pushUserMessage("Describe this", [imageBlock]);

    const msgs = log.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(Array.isArray(msgs[0].content)).toBe(true);
    const blocks = msgs[0].content as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as any).type).toBe("image");
    expect((blocks[1] as any).type).toBe("text");
    expect((blocks[1] as any).text).toBe("Describe this");

    log.destroy();
  });

  it("pushUserMessage without extraBlocks produces string content", async () => {
    const { MessageLog } = await import("../message-log");
    const client = createMockClient(vi.fn);
    const log = new MessageLog(client, { sessionId: "s1", renderMode: "block" });

    log.pushUserMessage("Hello");

    const msgs = log.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Hello");

    log.destroy();
  });
});

describe("ChatSession steer/interrupt drain attachments", () => {
  it("steer() drains pending attachments", () => {
    const client = createMockClient(vi.fn);
    const session = new ChatSession(client, { sessionId: "s1" });

    session.attachments.add({
      name: "photo.png",
      mimeType: "image/png",
      source: { type: "base64", data: "abc" },
    });

    session.steer("Look at this");

    expect(session.state.attachments).toHaveLength(0);
    expect(client.send).toHaveBeenCalledWith(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", data: "abc" }, mimeType: "image/png" },
              { type: "text", text: "Look at this" },
            ],
          },
        ],
      },
      { sessionId: "s1" },
    );

    session.destroy();
  });

  it("interrupt() drains pending attachments", () => {
    const client = createMockClient(vi.fn);
    const session = new ChatSession(client, { sessionId: "s1" });

    session.attachments.add({
      name: "doc.pdf",
      mimeType: "application/pdf",
      source: { type: "base64", data: "JVBERi0=" },
    });

    session.interrupt("Stop and look at this");

    expect(session.state.attachments).toHaveLength(0);

    // interrupt() calls accessor.interrupt which uses the mock
    const accessor = client.session("s1");
    expect(accessor.interrupt).toHaveBeenCalledWith({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", data: "JVBERi0=" },
              mimeType: "application/pdf",
              title: "doc.pdf",
            },
            { type: "text", text: "Stop and look at this" },
          ],
        },
      ],
    });

    session.destroy();
  });

  it("steer() without attachments sends text only", () => {
    const client = createMockClient(vi.fn);
    const session = new ChatSession(client, { sessionId: "s1" });

    session.steer("Just text");

    expect(client.send).toHaveBeenCalledWith(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "Just text" }] }],
      },
      { sessionId: "s1" },
    );

    session.destroy();
  });
});

describe("ChatSession single-notify on submit", () => {
  it("submit with attachments fires exactly one state change notification", () => {
    const client = createMockClient(vi.fn);
    const session = new ChatSession(client, { sessionId: "s1" });
    const listener = vi.fn();
    session.onStateChange(listener);

    session.attachments.add({
      name: "photo.png",
      mimeType: "image/png",
      source: "abc",
    });

    // Reset after add notification
    listener.mockClear();

    session.submit("Describe this");

    // Should fire exactly once (not twice from consume + submit)
    expect(listener).toHaveBeenCalledTimes(1);

    session.destroy();
  });

  it("steer with attachments fires exactly one state change notification", () => {
    const client = createMockClient(vi.fn);
    const session = new ChatSession(client, { sessionId: "s1" });
    const listener = vi.fn();
    session.onStateChange(listener);

    session.attachments.add({
      name: "photo.png",
      mimeType: "image/png",
      source: "abc",
    });

    listener.mockClear();

    session.steer("Now");

    expect(listener).toHaveBeenCalledTimes(1);

    session.destroy();
  });
});

describe("MessageSteering extraBlocks", () => {
  it("submit with extraBlocks sends multimodal message", () => {
    const client = createMockClient(vi.fn);
    const steering = new MessageSteering(client, { sessionId: "s1" });

    const imageBlock = {
      type: "image",
      source: { type: "base64", data: "abc" },
      mimeType: "image/png",
    } as ContentBlock;

    steering.submit("Describe this", [imageBlock]);

    expect(client.send).toHaveBeenCalledWith(
      {
        messages: [
          {
            role: "user",
            content: [imageBlock, { type: "text", text: "Describe this" }],
          },
        ],
      },
      { sessionId: "s1" },
    );

    steering.destroy();
  });

  it("submit without extraBlocks sends text-only message", () => {
    const client = createMockClient(vi.fn);
    const steering = new MessageSteering(client, { sessionId: "s1" });

    steering.submit("Hello");

    expect(client.send).toHaveBeenCalledWith(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      },
      { sessionId: "s1" },
    );

    steering.destroy();
  });

  it("queue with extraBlocks stores multimodal message", () => {
    const client = createMockClient(vi.fn);
    const steering = new MessageSteering(client, { sessionId: "s1", mode: "queue" });

    const docBlock = {
      type: "document",
      source: { type: "base64", data: "JVBERi0=" },
      mimeType: "application/pdf",
      title: "report.pdf",
    } as ContentBlock;

    // Simulate executing so submit queues
    client._emitSessionEvent("s1", makeEvent("execution_start"));
    steering.submit("Summarize this", [docBlock]);

    expect(steering.queued).toHaveLength(1);
    const queued = steering.queued[0];
    expect(Array.isArray(queued.content)).toBe(true);
    const blocks = queued.content as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as any).type).toBe("document");
    expect((blocks[1] as any).type).toBe("text");

    steering.destroy();
  });

  it("steer with extraBlocks sends multimodal message", () => {
    const client = createMockClient(vi.fn);
    const steering = new MessageSteering(client, { sessionId: "s1" });

    const imageBlock = {
      type: "image",
      source: { type: "base64", data: "abc" },
      mimeType: "image/png",
    } as ContentBlock;

    steering.steer("Look at this", [imageBlock]);

    expect(client.send).toHaveBeenCalledWith(
      {
        messages: [
          {
            role: "user",
            content: [imageBlock, { type: "text", text: "Look at this" }],
          },
        ],
      },
      { sessionId: "s1" },
    );

    steering.destroy();
  });

  it("interrupt with extraBlocks sends multimodal message", async () => {
    const client = createMockClient(vi.fn);
    const steering = new MessageSteering(client, { sessionId: "s1" });

    const docBlock = {
      type: "document",
      source: { type: "base64", data: "JVBERi0=" },
      mimeType: "application/pdf",
      title: "report.pdf",
    } as ContentBlock;

    steering.interrupt("Stop and read", [docBlock]);

    const accessor = client.session("s1");
    expect(accessor.interrupt).toHaveBeenCalledWith({
      messages: [
        {
          role: "user",
          content: [docBlock, { type: "text", text: "Stop and read" }],
        },
      ],
    });

    steering.destroy();
  });
});
