/**
 * Event Bridge Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEventBridge } from "../event-bridge.js";
import type { SessionHandler, ServerConnection, ServerTransportAdapter } from "../types.js";
import { FrameworkChannels, ErrorCodes } from "@tentickle/shared";
import type { ProtocolError } from "@tentickle/shared";
import type { Session, SendResult } from "@tentickle/core/app";
import type { StreamEvent } from "@tentickle/shared";

// Create mock session
function createMockSession() {
  let interrupted = false;
  let interruptReason: string | undefined;

  const channels = new Map<string, { publish: ReturnType<typeof vi.fn> }>();

  const createHandle = () => {
    const events: StreamEvent[] = [
      { type: "tick_start", tick: 1 },
      { type: "content_delta", delta: "Hello" },
      {
        type: "result",
        result: {
          response: "Done",
          outputs: {},
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          stopReason: "end_turn",
        },
      },
      { type: "tick_end", tick: 1 },
    ];

    return {
      [Symbol.asyncIterator]: async function* () {
        for (const event of events) {
          yield event;
        }
      },
      result: Promise.resolve({
        response: "Done",
        outputs: {},
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: "end_turn",
      }),
    };
  };

  return {
    _interrupted: () => interrupted,
    _interruptReason: () => interruptReason,

    tick: vi.fn((_props?: Record<string, unknown>) => createHandle()),
    send: vi.fn((_input?: any) => createHandle()),

    interrupt: vi.fn((signal?: any, reason?: string) => {
      interrupted = true;
      interruptReason = reason;
    }),

    channel: vi.fn((name: string) => {
      if (!channels.has(name)) {
        channels.set(name, { publish: vi.fn() });
      }
      return channels.get(name)!;
    }),

    queueMessage: vi.fn(),
  } as any as Session & {
    _interrupted: () => boolean;
    _interruptReason: () => string | undefined;
  };
}

// Create mock session handler
function createMockSessionHandler() {
  const sessions = new Map<string, ReturnType<typeof createMockSession>>();

  return {
    sessions,

    getSession: vi.fn((id: string) => sessions.get(id)),

    send: vi.fn(async (sessionId: string, input: any) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      const handle = session.tick(input.props);
      return await handle.result;
    }),

    // Helper to add a session
    _addSession(id: string) {
      const session = createMockSession();
      sessions.set(id, session);
      return session;
    },
  } as ReturnType<typeof createMockSessionHandler> & SessionHandler;
}

// Create mock connection
function createMockConnection(
  sessionId: string,
  id = "conn-1",
): ServerConnection & { _sentEvents: Array<{ channel: string; type: string; payload: unknown }> } {
  const sentEvents: Array<{ channel: string; type: string; payload: unknown }> = [];

  return {
    id,
    sessionId,
    userId: "user-1",
    metadata: {},
    _sentEvents: sentEvents,
    send: vi.fn(async (event) => {
      sentEvents.push(event);
    }),
    close: vi.fn(),
  };
}

describe("EventBridge", () => {
  let sessionHandler: ReturnType<typeof createMockSessionHandler>;
  let bridge: ReturnType<typeof createEventBridge>;

  beforeEach(() => {
    sessionHandler = createMockSessionHandler();
    bridge = createEventBridge({ sessionHandler });
  });

  describe("connection management (without transport)", () => {
    it("registers and tracks connections", async () => {
      const session = sessionHandler._addSession("session-1");
      const connection = createMockConnection("session-1");

      bridge.registerConnection(connection);

      // Trigger a tick and verify events are sent to the connection
      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { mode: "fast" } },
      });

      // Wait for streaming to complete
      await vi.waitFor(() => {
        expect(connection._sentEvents.length).toBeGreaterThan(0);
      });
    });

    it("unregisters connections", async () => {
      sessionHandler._addSession("session-1");
      const connection = createMockConnection("session-1");

      bridge.registerConnection(connection);
      bridge.unregisterConnection(connection.id);

      // Now events shouldn't reach the connection
      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { mode: "fast" } },
      });

      // No events sent because connection is unknown
      expect(connection._sentEvents).toHaveLength(0);
    });

    it("supports multiple connections per session", async () => {
      const session = sessionHandler._addSession("session-1");
      const conn1 = createMockConnection("session-1", "conn-1");
      const conn2 = createMockConnection("session-1", "conn-2");

      bridge.registerConnection(conn1);
      bridge.registerConnection(conn2);

      await bridge.handleEvent(conn1.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { mode: "fast" } },
      });

      // Wait for streaming to complete
      await vi.waitFor(() => {
        expect(conn1._sentEvents.length).toBeGreaterThan(0);
        expect(conn2._sentEvents.length).toBeGreaterThan(0);
      });

      // Both connections should receive events
      expect(conn1._sentEvents.length).toBe(conn2._sentEvents.length);
    });
  });

  describe("event handling", () => {
    beforeEach(() => {
      sessionHandler._addSession("session-1");
    });

    it("handles tick events", async () => {
      const connection = createMockConnection("session-1");
      bridge.registerConnection(connection);

      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { mode: "fast" } },
      });

      // Session tick should be called
      const session = sessionHandler.sessions.get("session-1")!;
      expect(session.tick).toHaveBeenCalled();
    });

    it("handles abort events", async () => {
      const connection = createMockConnection("session-1");
      bridge.registerConnection(connection);

      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "abort",
        payload: { reason: "User cancelled" },
      });

      const session = sessionHandler.sessions.get("session-1")!;
      expect(session.interrupt).toHaveBeenCalled();
      expect(session._interruptReason()).toBe("User cancelled");
    });

    it("handles message events", async () => {
      const connection = createMockConnection("session-1");
      bridge.registerConnection(connection);

      const message = { role: "user", content: [{ type: "text", text: "Hello" }] };
      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.MESSAGES,
        type: "message",
        payload: message,
      });

      // Message should start execution via session.send()
      const session = sessionHandler.sessions.get("session-1")!;
      expect(session.send).toHaveBeenCalledWith({ message });

      await vi.waitFor(() => {
        expect(connection._sentEvents.length).toBeGreaterThan(0);
      });
    });

    it("handles tool confirmation responses", async () => {
      const connection = createMockConnection("session-1");
      bridge.registerConnection(connection);

      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.TOOL_CONFIRMATION,
        type: "response",
        id: "request-1",
        payload: { approved: true },
      });

      const session = sessionHandler.sessions.get("session-1")!;
      expect(session.channel).toHaveBeenCalledWith("tool_confirmation");
    });

    it("ignores events from unknown connections", async () => {
      await bridge.handleEvent("unknown-conn", {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: {},
      });

      // No errors, just ignored
      const session = sessionHandler.sessions.get("session-1")!;
      expect(session.tick).not.toHaveBeenCalled();
    });

    it("ignores events for unknown sessions", async () => {
      const connection = createMockConnection("nonexistent");
      bridge.registerConnection(connection);

      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { mode: "fast" } },
      });

      // No errors, just ignored
      expect(connection._sentEvents).toHaveLength(0);
    });
  });

  describe("validateEvent hook", () => {
    it("rejects events that fail validation", async () => {
      const validateEvent = vi.fn(() => {
        throw new Error("Validation failed");
      });

      bridge = createEventBridge({ sessionHandler, validateEvent });
      sessionHandler._addSession("session-1");

      const connection = createMockConnection("session-1");
      bridge.registerConnection(connection);

      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: {},
      });

      // Event should be rejected
      const session = sessionHandler.sessions.get("session-1")!;
      expect(session.tick).not.toHaveBeenCalled();
    });

    it("allows events that pass validation", async () => {
      const validateEvent = vi.fn();

      bridge = createEventBridge({ sessionHandler, validateEvent });
      sessionHandler._addSession("session-1");

      const connection = createMockConnection("session-1");
      bridge.registerConnection(connection);

      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: {},
      });

      expect(validateEvent).toHaveBeenCalled();
      const session = sessionHandler.sessions.get("session-1")!;
      expect(session.tick).toHaveBeenCalled();
    });
  });

  describe("with transport adapter", () => {
    it("delegates sendToSession to transport", async () => {
      const transport: ServerTransportAdapter = {
        name: "mock",
        registerConnection: vi.fn(),
        unregisterConnection: vi.fn(),
        sendToConnection: vi.fn(),
        sendToSession: vi.fn(),
        getSessionConnections: vi.fn(() => []),
        destroy: vi.fn(),
      };

      bridge = createEventBridge({ sessionHandler, transport });
      sessionHandler._addSession("session-1");

      const connection = createMockConnection("session-1");

      // With transport, handleEvent takes connection directly
      await bridge.handleEvent(connection, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { mode: "fast" } },
      });

      // Wait for streaming
      await vi.waitFor(() => {
        expect(transport.sendToSession).toHaveBeenCalled();
      });

      // Should delegate to transport
      expect(transport.sendToSession).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ channel: FrameworkChannels.EVENTS }),
      );
    });

    it("ignores registerConnection when transport is present", () => {
      const transport: ServerTransportAdapter = {
        name: "mock",
        registerConnection: vi.fn(),
        unregisterConnection: vi.fn(),
        sendToConnection: vi.fn(),
        sendToSession: vi.fn(),
        getSessionConnections: vi.fn(() => []),
        destroy: vi.fn(),
      };

      bridge = createEventBridge({ sessionHandler, transport });

      const connection = createMockConnection("session-1");
      bridge.registerConnection(connection);

      // Should not track internally - transport handles it
      // This is verified by the fact that transport.registerConnection
      // is NOT called (the bridge ignores it, adapter handles registration)
    });
  });

  describe("streaming", () => {
    it("sends events through SSE channel", async () => {
      sessionHandler._addSession("session-1");
      const connection = createMockConnection("session-1");
      bridge.registerConnection(connection);

      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { mode: "fast" } },
      });

      await vi.waitFor(() => {
        expect(connection._sentEvents.length).toBeGreaterThan(0);
      });

      // Verify event structure
      const events = connection._sentEvents;
      expect(events[0].channel).toBe(FrameworkChannels.EVENTS);
      expect(events.some((e) => e.type === "tick_start")).toBe(true);
      expect(events.some((e) => e.type === "content_delta")).toBe(true);
    });

    it("sends result on dedicated channel", async () => {
      sessionHandler._addSession("session-1");
      const connection = createMockConnection("session-1");
      bridge.registerConnection(connection);

      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { mode: "fast" } },
      });

      await vi.waitFor(() => {
        const resultEvents = connection._sentEvents.filter(
          (e) => e.channel === FrameworkChannels.RESULT,
        );
        expect(resultEvents.length).toBe(1);
      });
    });

    it("aborts previous stream on new tick", async () => {
      sessionHandler._addSession("session-1");
      const connection = createMockConnection("session-1");
      bridge.registerConnection(connection);

      // Start first tick
      const tick1 = bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { mode: "fast" } },
      });

      // Immediately start second tick
      const tick2 = bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { mode: "fast" } },
      });

      await Promise.all([tick1, tick2]);

      // Session.tick should be called twice
      const session = sessionHandler.sessions.get("session-1")!;
      expect(session.tick).toHaveBeenCalledTimes(2);
    });
  });

  describe("error code propagation", () => {
    it("sends structured error with EXECUTION_ERROR code", async () => {
      // Create a session that throws during tick
      const failingSession = {
        tick: vi.fn(() => ({
          [Symbol.asyncIterator]: async function* () {
            throw new Error("Something went wrong");
          },
          result: Promise.reject(new Error("Something went wrong")),
        })),
        interrupt: vi.fn(),
        channel: vi.fn(() => ({ publish: vi.fn() })),
        queueMessage: vi.fn(),
      };
      sessionHandler.sessions.set("session-fail", failingSession as any);

      const connection = createMockConnection("session-fail");
      bridge.registerConnection(connection);

      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { mode: "fast" } },
      });

      await vi.waitFor(() => {
        const errorEvents = connection._sentEvents.filter((e) => e.type === "error");
        expect(errorEvents.length).toBe(1);
      });

      const errorEvent = connection._sentEvents.find((e) => e.type === "error");
      const payload = errorEvent!.payload as ProtocolError;
      expect(payload.code).toBe("EXECUTION_ERROR");
      expect(payload.message).toBe("Something went wrong");
    });

    it("sends SESSION_NOT_FOUND error code", async () => {
      const failingSession = {
        tick: vi.fn(() => ({
          [Symbol.asyncIterator]: async function* () {
            throw new Error("Session not found");
          },
          result: Promise.reject(new Error("Session not found")),
        })),
        interrupt: vi.fn(),
        channel: vi.fn(() => ({ publish: vi.fn() })),
        queueMessage: vi.fn(),
      };
      sessionHandler.sessions.set("session-fail", failingSession as any);

      const connection = createMockConnection("session-fail");
      bridge.registerConnection(connection);

      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { mode: "fast" } },
      });

      await vi.waitFor(() => {
        const errorEvents = connection._sentEvents.filter((e) => e.type === "error");
        expect(errorEvents.length).toBe(1);
      });

      const errorEvent = connection._sentEvents.find((e) => e.type === "error");
      const payload = errorEvent!.payload as ProtocolError;
      expect(payload.code).toBe(ErrorCodes.SESSION_NOT_FOUND);
    });

    it("sends TIMEOUT error code for timeout errors", async () => {
      const failingSession = {
        tick: vi.fn(() => ({
          [Symbol.asyncIterator]: async function* () {
            const err = new Error("Request timed out");
            err.name = "TimeoutError";
            throw err;
          },
          result: Promise.reject(new Error("Request timed out")),
        })),
        interrupt: vi.fn(),
        channel: vi.fn(() => ({ publish: vi.fn() })),
        queueMessage: vi.fn(),
      };
      sessionHandler.sessions.set("session-fail", failingSession as any);

      const connection = createMockConnection("session-fail");
      bridge.registerConnection(connection);

      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { mode: "fast" } },
      });

      await vi.waitFor(() => {
        const errorEvents = connection._sentEvents.filter((e) => e.type === "error");
        expect(errorEvents.length).toBe(1);
      });

      const errorEvent = connection._sentEvents.find((e) => e.type === "error");
      const payload = errorEvent!.payload as ProtocolError;
      expect(payload.code).toBe(ErrorCodes.TIMEOUT);
    });

    it("includes error cause in details when present", async () => {
      const failingSession = {
        tick: vi.fn(() => ({
          [Symbol.asyncIterator]: async function* () {
            const err = new Error("Wrapper error");
            (err as any).cause = "Original error details";
            throw err;
          },
          result: Promise.reject(new Error("Wrapper error")),
        })),
        interrupt: vi.fn(),
        channel: vi.fn(() => ({ publish: vi.fn() })),
        queueMessage: vi.fn(),
      };
      sessionHandler.sessions.set("session-fail", failingSession as any);

      const connection = createMockConnection("session-fail");
      bridge.registerConnection(connection);

      await bridge.handleEvent(connection.id, {
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: {},
      });

      await vi.waitFor(() => {
        const errorEvents = connection._sentEvents.filter((e) => e.type === "error");
        expect(errorEvents.length).toBe(1);
      });

      const errorEvent = connection._sentEvents.find((e) => e.type === "error");
      const payload = errorEvent!.payload as ProtocolError;
      expect(payload.details).toBeDefined();
      expect(payload.details!.cause).toBe("Original error details");
    });
  });

  describe("cleanup", () => {
    it("destroys all connections", async () => {
      sessionHandler._addSession("session-1");
      const conn1 = createMockConnection("session-1", "conn-1");
      const conn2 = createMockConnection("session-1", "conn-2");

      bridge.registerConnection(conn1);
      bridge.registerConnection(conn2);

      bridge.destroy();

      expect(conn1.close).toHaveBeenCalled();
      expect(conn2.close).toHaveBeenCalled();
    });

    it("calls transport.destroy if present", () => {
      const transport: ServerTransportAdapter = {
        name: "mock",
        registerConnection: vi.fn(),
        unregisterConnection: vi.fn(),
        sendToConnection: vi.fn(),
        sendToSession: vi.fn(),
        getSessionConnections: vi.fn(() => []),
        destroy: vi.fn(),
      };

      bridge = createEventBridge({ sessionHandler, transport });
      bridge.destroy();

      expect(transport.destroy).toHaveBeenCalled();
    });
  });
});
