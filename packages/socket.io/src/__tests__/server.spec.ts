/**
 * Socket.IO Server Adapter Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSocketIOAdapter, CHANNEL_EVENT, JOIN_SESSION } from "../server.js";
import type { ChannelEvent } from "@tentickle/shared";

// Mock Socket.IO types
interface MockSocket {
  id: string;
  data: Record<string, unknown>;
  emit: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  _listeners: Map<string, Set<(...args: any[]) => void>>;
  _triggerEvent: (event: string, ...args: any[]) => Promise<void>;
}

interface MockIO {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  to: ReturnType<typeof vi.fn>;
  _connectionListener?: (socket: MockSocket) => void;
  _simulateConnection: (socket: MockSocket) => void;
  _toRoom: ReturnType<typeof vi.fn>;
}

function createMockSocket(id = "socket-1"): MockSocket {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();

  return {
    id,
    data: {},
    emit: vi.fn(),
    join: vi.fn(async () => {}),
    disconnect: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(handler);
    }),
    _listeners: listeners,
    async _triggerEvent(event: string, ...args: any[]) {
      const handlers = listeners.get(event);
      if (handlers) {
        for (const handler of handlers) {
          await handler(...args);
        }
      }
    },
  };
}

function createMockIO(): MockIO {
  let connectionListener: ((socket: MockSocket) => void) | undefined;
  const toRoom = vi.fn((event: ChannelEvent) => {});

  return {
    on: vi.fn((event: string, handler: (socket: MockSocket) => void) => {
      if (event === "connection") {
        connectionListener = handler;
      }
    }),
    off: vi.fn((event: string, handler: (socket: MockSocket) => void) => {
      if (event === "connection" && connectionListener === handler) {
        connectionListener = undefined;
      }
    }),
    to: vi.fn(() => ({ emit: toRoom })),
    get _connectionListener() {
      return connectionListener;
    },
    _simulateConnection(socket: MockSocket) {
      if (connectionListener) {
        connectionListener(socket);
      }
    },
    _toRoom: toRoom,
  };
}

describe("createSocketIOAdapter", () => {
  let io: MockIO;
  let adapter: ReturnType<typeof createSocketIOAdapter>;
  let onEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    io = createMockIO();
    onEvent = vi.fn();
    adapter = createSocketIOAdapter({ io: io as any, onEvent });
  });

  afterEach(() => {
    adapter.destroy();
  });

  it("creates adapter with correct name", () => {
    expect(adapter.name).toBe("socket.io");
  });

  it("registers connection listener on io", () => {
    expect(io.on).toHaveBeenCalledWith("connection", expect.any(Function));
  });

  describe("connection handling", () => {
    it("handles JOIN_SESSION event", async () => {
      const socket = createMockSocket("socket-1");
      io._simulateConnection(socket);

      // Trigger join session (await because join is async)
      await socket._triggerEvent(JOIN_SESSION, {
        sessionId: "session-1",
        metadata: { foo: "bar" },
      });

      // Should join the room
      expect(socket.join).toHaveBeenCalledWith("session:session-1");

      // Should store connection in socket.data
      expect(socket.data.connection).toBeDefined();
      expect((socket.data.connection as any).sessionId).toBe("session-1");
    });

    it("handles CHANNEL_EVENT and calls onEvent", async () => {
      const socket = createMockSocket("socket-1");
      socket.data.userId = "user-1";
      io._simulateConnection(socket);

      // First join a session
      await socket._triggerEvent(JOIN_SESSION, {
        sessionId: "session-1",
        metadata: {},
      });

      // Then send a channel event
      const event: ChannelEvent = {
        channel: "test:channel",
        type: "test",
        payload: { data: "hello" },
      };
      await socket._triggerEvent(CHANNEL_EVENT, event);

      // onEvent should be called with connection and event
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "socket-1",
          sessionId: "session-1",
          userId: "user-1",
        }),
        event
      );
    });

    it("ignores CHANNEL_EVENT before JOIN_SESSION", async () => {
      const socket = createMockSocket("socket-1");
      io._simulateConnection(socket);

      // Send channel event without joining first
      const event: ChannelEvent = {
        channel: "test:channel",
        type: "test",
        payload: {},
      };
      await socket._triggerEvent(CHANNEL_EVENT, event);

      // onEvent should NOT be called
      expect(onEvent).not.toHaveBeenCalled();
    });

    it("connection.send emits CHANNEL_EVENT", async () => {
      const socket = createMockSocket("socket-1");
      io._simulateConnection(socket);

      await socket._triggerEvent(JOIN_SESSION, {
        sessionId: "session-1",
        metadata: {},
      });

      const connection = socket.data.connection as any;
      const event: ChannelEvent = {
        channel: "response",
        type: "data",
        payload: { result: "ok" },
      };
      await connection.send(event);

      expect(socket.emit).toHaveBeenCalledWith(CHANNEL_EVENT, event);
    });

    it("connection.close disconnects socket", async () => {
      const socket = createMockSocket("socket-1");
      io._simulateConnection(socket);

      await socket._triggerEvent(JOIN_SESSION, {
        sessionId: "session-1",
        metadata: {},
      });

      const connection = socket.data.connection as any;
      connection.close();

      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe("sendToSession", () => {
    it("broadcasts to session room", async () => {
      const event: ChannelEvent = {
        channel: "events",
        type: "update",
        payload: { delta: "hello" },
      };

      await adapter.sendToSession("session-1", event);

      expect(io.to).toHaveBeenCalledWith("session:session-1");
      expect(io._toRoom).toHaveBeenCalledWith(CHANNEL_EVENT, event);
    });
  });

  describe("destroy", () => {
    it("removes connection listener", () => {
      const listenerBefore = io._connectionListener;
      expect(listenerBefore).toBeDefined();

      adapter.destroy();

      expect(io.off).toHaveBeenCalledWith("connection", listenerBefore);
    });

    it("disconnects all tracked sockets", async () => {
      const socket1 = createMockSocket("socket-1");
      const socket2 = createMockSocket("socket-2");

      io._simulateConnection(socket1);
      io._simulateConnection(socket2);

      await socket1._triggerEvent(JOIN_SESSION, { sessionId: "s1", metadata: {} });
      await socket2._triggerEvent(JOIN_SESSION, { sessionId: "s2", metadata: {} });

      adapter.destroy();

      expect(socket1.disconnect).toHaveBeenCalledWith(true);
      expect(socket2.disconnect).toHaveBeenCalledWith(true);
    });

    it("handles disconnect event cleaning up socket tracking", async () => {
      const socket = createMockSocket("socket-1");
      io._simulateConnection(socket);
      await socket._triggerEvent(JOIN_SESSION, { sessionId: "s1", metadata: {} });

      // Simulate disconnect
      await socket._triggerEvent("disconnect");

      // Now destroy - socket should not be in the set anymore
      adapter.destroy();

      // disconnect should only be called once (not again by destroy)
      // since it was already removed from tracking
      expect(socket.disconnect).not.toHaveBeenCalled();
    });
  });
});
