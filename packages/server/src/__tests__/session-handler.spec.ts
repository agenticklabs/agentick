/**
 * Session Handler Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionHandler, SessionNotFoundError } from "../session-handler.js";
import type { App, Session, SendResult } from "@tentickle/core/app";
import type { Message, StreamEvent } from "@tentickle/shared";

// Mock session implementation
function createMockSession(): Session & {
  _queuedMessages: Message[];
  _tickCalls: Array<{ props?: Record<string, unknown> }>;
} {
  const queuedMessages: Message[] = [];
  const tickCalls: Array<{ props?: Record<string, unknown> }> = [];

  return {
    _queuedMessages: queuedMessages,
    _tickCalls: tickCalls,

    queueMessage(msg: Message) {
      queuedMessages.push(msg);
    },

    tick(props?: Record<string, unknown>) {
      tickCalls.push({ props });

      const events: StreamEvent[] = [
        { type: "tick_start", tick: 1 },
        { type: "content_delta", delta: "Hello" },
        { type: "tick_end", tick: 1 },
      ];

      const result: SendResult = {
        response: "Hello, world!",
        outputs: {},
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        stopReason: "end_turn",
      };

      // Return async iterable with result promise
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const event of events) {
            yield event;
          }
        },
        result: Promise.resolve(result),
      };
    },

    inspect() {
      return {
        status: "idle" as const,
        currentTick: 0,
        queuedMessages,
      };
    },

    // Minimal stubs for unused methods
    sendMessage: vi.fn(),
    interrupt: vi.fn(),
    channel: vi.fn(() => ({
      publish: vi.fn(),
      subscribe: vi.fn(),
    })),
    snapshot: vi.fn(),
    events: vi.fn(),
    destroy: vi.fn(),
    close: vi.fn(),
  } as any;
}

// Mock app
function createMockApp(): App {
  return {
    createSession: vi.fn(() => createMockSession()),
  } as any;
}

describe("SessionHandler", () => {
  let app: App;
  let sessionHandler: ReturnType<typeof createSessionHandler>;

  beforeEach(() => {
    app = createMockApp();
    sessionHandler = createSessionHandler({ app });
  });

  describe("create", () => {
    it("creates a new session with generated ID", async () => {
      const { sessionId, session } = await sessionHandler.create({});

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe("string");
      expect(session).toBeDefined();
      expect(app.createSession).toHaveBeenCalled();
    });

    it("uses provided session ID", async () => {
      const { sessionId } = await sessionHandler.create({ sessionId: "my-session" });

      expect(sessionId).toBe("my-session");
    });

    it("returns existing session if ID already exists", async () => {
      const first = await sessionHandler.create({ sessionId: "existing" });
      const second = await sessionHandler.create({ sessionId: "existing" });

      expect(second.session).toBe(first.session);
      // createSession should only be called once
      expect(app.createSession).toHaveBeenCalledTimes(1);
    });

    it("queues initial messages if provided", async () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ];

      const { session } = await sessionHandler.create({ messages });

      const mockSession = session as unknown as ReturnType<typeof createMockSession>;
      expect(mockSession._queuedMessages).toHaveLength(1);
      expect(mockSession._queuedMessages[0]).toBe(messages[0]);
    });
  });

  describe("send", () => {
    it("sends messages and returns result", async () => {
      await sessionHandler.create({ sessionId: "test" });

      const result = await sessionHandler.send("test", {
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      });

      expect(result.response).toBe("Hello, world!");
      expect(result.usage.totalTokens).toBe(15);
    });

    it("throws SessionNotFoundError for unknown session", async () => {
      await expect(sessionHandler.send("nonexistent", {})).rejects.toThrow(
        SessionNotFoundError,
      );
    });

    it("calls tick with props", async () => {
      await sessionHandler.create({ sessionId: "test" });
      const session = sessionHandler.getSession("test") as any;

      await sessionHandler.send("test", { props: { mode: "fast" } });

      expect(session._tickCalls[0].props).toEqual({ mode: "fast" });
    });
  });

  describe("stream", () => {
    it("streams events from session", async () => {
      await sessionHandler.create({ sessionId: "test" });

      const events: StreamEvent[] = [];
      for await (const event of sessionHandler.stream("test", {})) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe("tick_start");
      expect(events[1].type).toBe("content_delta");
      expect(events[2].type).toBe("tick_end");
    });

    it("throws SessionNotFoundError for unknown session", () => {
      expect(() => sessionHandler.stream("nonexistent", {})).toThrow(
        SessionNotFoundError,
      );
    });
  });

  describe("getState", () => {
    it("returns session state", async () => {
      await sessionHandler.create({ sessionId: "test" });

      const state = sessionHandler.getState("test");

      expect(state).toEqual({
        sessionId: "test",
        status: "idle",
        tick: 0,
        queuedMessages: 0,
      });
    });

    it("returns undefined for unknown session", () => {
      expect(sessionHandler.getState("nonexistent")).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("deletes session", async () => {
      await sessionHandler.create({ sessionId: "test" });
      expect(sessionHandler.getSession("test")).toBeDefined();

      const deleted = sessionHandler.delete("test");

      expect(deleted).toBe(true);
      expect(sessionHandler.getSession("test")).toBeUndefined();
    });

    it("returns false for unknown session", () => {
      expect(sessionHandler.delete("nonexistent")).toBe(false);
    });
  });

  describe("list", () => {
    it("lists all session IDs", async () => {
      await sessionHandler.create({ sessionId: "a" });
      await sessionHandler.create({ sessionId: "b" });
      await sessionHandler.create({ sessionId: "c" });

      const ids = sessionHandler.list();

      expect(ids).toContain("a");
      expect(ids).toContain("b");
      expect(ids).toContain("c");
      expect(ids).toHaveLength(3);
    });
  });
});
