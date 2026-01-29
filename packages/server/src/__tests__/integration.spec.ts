/**
 * Client-Server Integration Tests
 *
 * These tests verify the full communication flow between client and server
 * using mock transports that simulate the wire protocol.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEventBridge } from "../event-bridge.js";
import { createSessionHandler } from "../session-handler.js";
import type { ServerConnection, ServerTransportAdapter } from "../types.js";
import { FrameworkChannels } from "@tentickle/shared";
import type { ChannelEvent, StreamEvent } from "@tentickle/shared";
import type { App, Session, SendResult } from "@tentickle/core/app";

// ============================================================================
// Mock Infrastructure
// ============================================================================

/**
 * In-memory transport that connects client and server directly.
 * Simulates the wire protocol without actual network.
 */
class InMemoryTransport {
  private serverConnections = new Map<string, ServerConnection>();
  private clientHandlers = new Map<string, Set<(event: ChannelEvent) => void>>();
  private eventBridge?: ReturnType<typeof createEventBridge>;

  setEventBridge(bridge: ReturnType<typeof createEventBridge>) {
    this.eventBridge = bridge;
  }

  // Server-side transport adapter
  createServerAdapter(): ServerTransportAdapter {
    const self = this;

    return {
      name: "in-memory",

      registerConnection(connection: ServerConnection) {
        self.serverConnections.set(connection.id, connection);
      },

      unregisterConnection(connectionId: string) {
        self.serverConnections.delete(connectionId);
      },

      async sendToConnection(connectionId: string, event: ChannelEvent) {
        self.deliverToClient(connectionId, event);
      },

      async sendToSession(sessionId: string, event: ChannelEvent) {
        for (const [connId, conn] of self.serverConnections) {
          if (conn.sessionId === sessionId) {
            self.deliverToClient(connId, event);
          }
        }
      },

      getSessionConnections(sessionId: string) {
        return Array.from(self.serverConnections.values()).filter(
          (c) => c.sessionId === sessionId,
        );
      },

      destroy() {
        self.serverConnections.clear();
      },
    };
  }

  // Client-side connection
  createClientConnection(
    sessionId: string,
    connectionId = `conn-${Date.now()}`,
    userId?: string,
  ): {
    send: (event: ChannelEvent) => Promise<void>;
    onReceive: (handler: (event: ChannelEvent) => void) => () => void;
    disconnect: () => void;
  } {
    const self = this;
    const handlers = new Set<(event: ChannelEvent) => void>();
    this.clientHandlers.set(connectionId, handlers);

    // Create server connection
    const serverConnection: ServerConnection = {
      id: connectionId,
      sessionId,
      userId,
      metadata: {},
      send: async (event) => {
        self.deliverToClient(connectionId, event);
      },
      close: () => {
        self.serverConnections.delete(connectionId);
        self.clientHandlers.delete(connectionId);
      },
    };

    this.serverConnections.set(connectionId, serverConnection);

    return {
      send: async (event) => {
        // Deliver to server
        if (this.eventBridge) {
          await this.eventBridge.handleEvent(serverConnection, event);
        }
      },
      onReceive: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      disconnect: () => {
        serverConnection.close();
      },
    };
  }

  private deliverToClient(connectionId: string, event: ChannelEvent) {
    const handlers = this.clientHandlers.get(connectionId);
    if (handlers) {
      for (const handler of handlers) {
        handler(event);
      }
    }
  }
}

// Mock session that generates predictable events
function createMockSession(): Session & {
  tick: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
} {
  let messageQueue: any[] = [];
  let tickCount = 0;
  let interrupted = false;

  const channels = new Map<string, { publish: ReturnType<typeof vi.fn>; subscribers: Set<(event: any) => void> }>();

  const session = {
    queueMessage(msg: any) {
      messageQueue.push(msg);
    },

    tick: vi.fn((props?: Record<string, unknown>) => {
      tickCount++;
      interrupted = false;
      const currentTick = tickCount;

      const events: StreamEvent[] = [
        { type: "tick_start", tick: currentTick },
        { type: "content_delta", delta: "Hello " },
        { type: "content_delta", delta: "World!" },
        {
          type: "result",
          result: {
            response: "Hello World!",
            outputs: {},
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            stopReason: "end_turn",
          },
        },
        { type: "tick_end", tick: currentTick },
      ];

      const result: SendResult = {
        response: "Hello World!",
        outputs: {},
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        stopReason: "end_turn",
      };

      return {
        [Symbol.asyncIterator]: async function* () {
          for (const event of events) {
            if (interrupted) break;
            yield event;
            // Small delay to simulate real streaming
            await new Promise((r) => setTimeout(r, 1));
          }
        },
        result: Promise.resolve(result),
      };
    }),

    interrupt: vi.fn((signal?: any, reason?: string) => {
      interrupted = true;
    }),

    channel(name: string) {
      if (!channels.has(name)) {
        channels.set(name, {
          publish: vi.fn((event) => {
            const ch = channels.get(name)!;
            ch.subscribers.forEach((s) => s(event));
          }),
          subscribers: new Set(),
        });
      }
      const ch = channels.get(name)!;
      return {
        publish: ch.publish,
        subscribe: (handler: (event: any) => void) => {
          ch.subscribers.add(handler);
          return () => ch.subscribers.delete(handler);
        },
      };
    },

    inspect() {
      return {
        status: "idle" as const,
        currentTick: tickCount,
        queuedMessages: messageQueue,
      };
    },

    sendMessage: vi.fn(),
    snapshot: vi.fn(),
    events: vi.fn(),
    destroy: vi.fn(),
    close: vi.fn(),
  };

  return session as any;
}

// Mock app
function createMockApp(): App {
  return {
    createSession: vi.fn(() => createMockSession()),
  } as any;
}

// ============================================================================
// Tests
// ============================================================================

describe("Client-Server Integration", () => {
  let transport: InMemoryTransport;
  let sessionHandler: ReturnType<typeof createSessionHandler>;
  let eventBridge: ReturnType<typeof createEventBridge>;

  beforeEach(() => {
    transport = new InMemoryTransport();
    sessionHandler = createSessionHandler({ app: createMockApp() });

    const adapter = transport.createServerAdapter();
    eventBridge = createEventBridge({
      sessionHandler,
      transport: adapter,
    });
    transport.setEventBridge(eventBridge);
  });

  afterEach(() => {
    eventBridge.destroy();
  });

  describe("basic message flow", () => {
    it("sends message from client and receives response stream", async () => {
      // Create session
      const { sessionId } = await sessionHandler.create({});

      // Connect client
      const client = transport.createClientConnection(sessionId);
      const receivedEvents: ChannelEvent[] = [];
      client.onReceive((event) => receivedEvents.push(event));

      // Send message
      await client.send({
        channel: FrameworkChannels.MESSAGES,
        type: "message",
        payload: { role: "user", content: [{ type: "text", text: "Hello" }] },
      });

      // Wait for events to arrive
      await vi.waitFor(
        () => {
          expect(receivedEvents.length).toBeGreaterThan(0);
        },
        { timeout: 1000 },
      );

      // Verify event structure
      const streamEvents = receivedEvents.filter(
        (e) => e.channel === FrameworkChannels.EVENTS,
      );
      const resultEvents = receivedEvents.filter(
        (e) => e.channel === FrameworkChannels.RESULT,
      );

      expect(streamEvents.length).toBeGreaterThan(0);
      expect(resultEvents.length).toBe(1);

      // Verify content
      const contentDeltas = streamEvents
        .filter((e) => e.type === "content_delta")
        .map((e) => (e.payload as any).delta);
      expect(contentDeltas.join("")).toBe("Hello World!");

      client.disconnect();
    });

    it("supports multiple clients on same session", async () => {
      const { sessionId } = await sessionHandler.create({});

      const client1 = transport.createClientConnection(sessionId, "conn-1");
      const client2 = transport.createClientConnection(sessionId, "conn-2");

      const events1: ChannelEvent[] = [];
      const events2: ChannelEvent[] = [];

      client1.onReceive((e) => events1.push(e));
      client2.onReceive((e) => events2.push(e));

      // Trigger tick from client 1
      await client1.send({
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: {},
      });

      await vi.waitFor(() => {
        expect(events1.length).toBeGreaterThan(0);
        expect(events2.length).toBeGreaterThan(0);
      });

      // Both clients should receive the same events
      expect(events1.length).toBe(events2.length);

      client1.disconnect();
      client2.disconnect();
    });
  });

  describe("abort handling", () => {
    it("aborts execution on client request", async () => {
      const { sessionId, session } = await sessionHandler.create({});

      const client = transport.createClientConnection(sessionId);
      const receivedEvents: ChannelEvent[] = [];
      client.onReceive((e) => receivedEvents.push(e));

      // Start tick
      const tickPromise = client.send({
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: {},
      });

      // Immediately abort
      await client.send({
        channel: FrameworkChannels.CONTROL,
        type: "abort",
        payload: { reason: "User cancelled" },
      });

      await tickPromise;

      expect(session.interrupt).toHaveBeenCalled();

      client.disconnect();
    });
  });

  describe("tool confirmation flow", () => {
    it("sends confirmation request and receives response", async () => {
      const { sessionId, session } = await sessionHandler.create({});

      const client = transport.createClientConnection(sessionId);
      const receivedEvents: ChannelEvent[] = [];
      client.onReceive((e) => receivedEvents.push(e));

      // Get the tool confirmation channel
      const tcChannel = session.channel("tool_confirmation");

      // Subscribe to responses
      let responseReceived = false;
      tcChannel.subscribe((event: any) => {
        if (event.type === "response") {
          responseReceived = true;
        }
      });

      // Simulate sending a confirmation response from client
      await client.send({
        channel: FrameworkChannels.TOOL_CONFIRMATION,
        type: "response",
        id: "request-1",
        payload: { approved: true },
      });

      // Verify the response was published to the session channel
      expect(tcChannel.publish).toHaveBeenCalled();

      client.disconnect();
    });
  });

  describe("validation", () => {
    it("rejects invalid events via validateEvent hook", async () => {
      // Create bridge with validation
      const validateEvent = vi.fn((connection, event) => {
        if (event.channel === "forbidden:channel") {
          throw new Error("Channel not allowed");
        }
      });

      const validatingBridge = createEventBridge({
        sessionHandler,
        transport: transport.createServerAdapter(),
        validateEvent,
      });
      transport.setEventBridge(validatingBridge);

      const { sessionId, session } = await sessionHandler.create({});
      const client = transport.createClientConnection(sessionId);

      // Send to forbidden channel
      await client.send({
        channel: "forbidden:channel",
        type: "test",
        payload: {},
      });

      // Validation should have been called
      expect(validateEvent).toHaveBeenCalled();

      // Session should not have been affected
      expect(session.tick).not.toHaveBeenCalled();

      client.disconnect();
      validatingBridge.destroy();
    });
  });

  describe("session lifecycle", () => {
    it("handles session not found gracefully", async () => {
      const client = transport.createClientConnection("nonexistent-session");
      const receivedEvents: ChannelEvent[] = [];
      client.onReceive((e) => receivedEvents.push(e));

      // This should not throw, just be ignored
      await client.send({
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: {},
      });

      // No events should be sent
      expect(receivedEvents.length).toBe(0);

      client.disconnect();
    });

    it("handles client disconnect during streaming", async () => {
      const { sessionId } = await sessionHandler.create({});

      const client = transport.createClientConnection(sessionId);

      // Start tick
      await client.send({
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: {},
      });

      // Disconnect immediately
      client.disconnect();

      // Should not throw, stream should complete gracefully
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe("concurrent ticks", () => {
    it("aborts previous tick when new one starts", async () => {
      const { sessionId, session } = await sessionHandler.create({});

      const client = transport.createClientConnection(sessionId);

      // Start first tick
      await client.send({
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { request: 1 } },
      });

      // Start second tick immediately
      await client.send({
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { request: 2 } },
      });

      // Wait for completion
      await new Promise((r) => setTimeout(r, 50));

      // Both ticks should have been called (second aborts first)
      expect(session.tick).toHaveBeenCalledTimes(2);

      client.disconnect();
    });
  });
});
