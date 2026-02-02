/**
 * Channel Integration Tests
 *
 * Tests the full client → server → client channel flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import http from "http";
import { createTentickleHandler } from "../router";
import type { App, Session } from "@tentickle/core/app";
import { Channel } from "@tentickle/core";

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockSessionWithRealChannels(): Session & {
  _channels: Map<string, Channel>;
} {
  const channels = new Map<string, Channel>();

  return {
    _channels: channels,
    id: "test-session",
    status: "idle",
    currentTick: 0,
    isAborted: false,
    queuedMessages: [],
    schedulerState: null,

    queue: { exec: vi.fn() } as any,
    send: vi.fn(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "tick_end", tick: 1 };
      },
      result: Promise.resolve({
        response: "Done",
        outputs: {},
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: "end_turn",
        raw: {},
      }),
      sessionId: "test-session",
    })),
    tick: vi.fn(),
    interrupt: vi.fn(),
    clearAbort: vi.fn(),
    events: vi.fn(() => (async function* () {})()),
    snapshot: vi.fn(() => ({})),
    inspect: vi.fn(() => ({
      id: "test-session",
      status: "idle" as const,
      currentTick: 0,
      queuedMessages: [],
      currentPhase: undefined,
      isAborted: false,
      lastOutput: null,
      lastModelOutput: null,
      lastToolCalls: [],
      lastToolResults: [],
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      tickCount: 0,
      components: { count: 0, names: [] },
      hooks: { count: 0, byType: {} },
    })),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    getRecording: vi.fn(),
    getSnapshotAt: vi.fn(),
    // Use real Channel instances
    channel: vi.fn((name: string) => {
      let channel = channels.get(name);
      if (!channel) {
        channel = new Channel(name);
        channels.set(name, channel);
      }
      return channel;
    }),
    close: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    once: vi.fn(),
    prependListener: vi.fn(),
    prependOnceListener: vi.fn(),
    listeners: vi.fn(),
    rawListeners: vi.fn(),
    listenerCount: vi.fn(),
    eventNames: vi.fn(),
    removeAllListeners: vi.fn(),
    setMaxListeners: vi.fn(),
    getMaxListeners: vi.fn(),
  } as any;
}

function createMockAppWithRealChannels(): App & {
  _sessions: Map<string, ReturnType<typeof createMockSessionWithRealChannels>>;
} {
  const sessions = new Map<string, ReturnType<typeof createMockSessionWithRealChannels>>();

  return {
    _sessions: sessions,
    run: { exec: vi.fn() } as any,
    send: vi.fn(),
    session: vi.fn((id) => {
      let session = sessions.get(id);
      if (!session) {
        session = createMockSessionWithRealChannels();
        (session as any).id = id;
        sessions.set(id, session);
      }
      return session;
    }),
    close: vi.fn(async (id) => {
      sessions.delete(id);
    }),
    get sessions() {
      return Array.from(sessions.keys());
    },
    has: vi.fn((id) => sessions.has(id)),
    onSessionCreate: vi.fn(() => () => {}),
    onSessionClose: vi.fn(() => () => {}),
  } as any;
}

// ============================================================================
// Integration Tests
// ============================================================================

describe("Channel Integration", () => {
  let expressApp: Express;
  let mockApp: ReturnType<typeof createMockAppWithRealChannels>;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    expressApp = express();
    expressApp.use(express.json());
    mockApp = createMockAppWithRealChannels();

    const handler = createTentickleHandler(mockApp);
    expressApp.use("/api", handler);

    // Start server on random port
    await new Promise<void>((resolve) => {
      server = expressApp.listen(0, () => {
        const address = server.address() as { port: number };
        baseUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe("Client → Server channel publish", () => {
    it("publishes event and triggers session channel", async () => {
      // Create session
      const session = mockApp.session("test-session");

      // Set up listener on session channel
      const receivedEvents: unknown[] = [];
      session.channel("notifications").subscribe((event) => {
        receivedEvents.push(event);
      });

      // Publish via HTTP
      const response = await fetch(`${baseUrl}/api/channel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "test-session",
          channel: "notifications",
          type: "user_action",
          payload: { action: "click", target: "button" },
        }),
      });

      expect(response.ok).toBe(true);
      const body = await response.json();
      expect((body as { success: boolean }).success).toBe(true);

      // Verify channel received the event
      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]).toMatchObject({
        type: "user_action",
        channel: "notifications",
        payload: { action: "click", target: "button" },
      });
    });

    it("includes correlation id for request/response", async () => {
      const session = mockApp.session("test-session");

      const receivedEvents: unknown[] = [];
      session.channel("rpc").subscribe((event) => {
        receivedEvents.push(event);
      });

      const response = await fetch(`${baseUrl}/api/channel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "test-session",
          channel: "rpc",
          type: "request",
          payload: { method: "getData" },
          id: "req-123",
        }),
      });

      expect(response.ok).toBe(true);

      expect(receivedEvents).toHaveLength(1);
      expect((receivedEvents[0] as any).id).toBe("req-123");
    });
  });

  describe("Server → Client channel events (via SSE)", () => {
    it("forwards channel events to subscribed connections", async () => {
      // Create session
      const session = mockApp.session("test-session");

      // Subscribe to channel
      const subscribeResponse = await fetch(`${baseUrl}/api/channel/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "test-session",
          channel: "notifications",
        }),
      });

      expect(subscribeResponse.ok).toBe(true);

      // Start SSE connection
      const controller = new AbortController();
      const ssePromise = fetch(`${baseUrl}/api/events?subscribe=test-session`, {
        signal: controller.signal,
      });

      // Wait for connection to be established
      const sseResponse = await ssePromise;
      expect(sseResponse.ok).toBe(true);
      expect(sseResponse.headers.get("content-type")).toContain("text/event-stream");

      // Collect SSE events
      const events: string[] = [];
      const reader = sseResponse.body!.getReader();
      const decoder = new TextDecoder();

      // Read a few events
      const readTimeout = setTimeout(() => controller.abort(), 500);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          events.push(decoder.decode(value));

          // Once we have the connection event, trigger a channel event
          const fullText = events.join("");
          if (fullText.includes("connectionId") && events.length === 1) {
            // Publish event to channel from server side
            session.channel("notifications").publish({
              type: "server_notification",
              channel: "notifications",
              payload: { message: "Hello from server" },
            });
          }

          // Stop after receiving a channel event
          if (fullText.includes("server_notification")) {
            break;
          }
        }
      } catch {
        // AbortError is expected
      } finally {
        clearTimeout(readTimeout);
        controller.abort();
      }

      const fullText = events.join("");
      expect(fullText).toContain("connection");
      expect(fullText).toContain("server_notification");
      expect(fullText).toContain("Hello from server");
    });
  });

  describe("Bidirectional channel flow", () => {
    it("supports request/response pattern", async () => {
      const session = mockApp.session("test-session");

      // Subscribe to channel on server
      await fetch(`${baseUrl}/api/channel/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "test-session",
          channel: "rpc",
        }),
      });

      // Set up responder on server
      session.channel("rpc").subscribe((event: any) => {
        if (event.type === "request" && event.id) {
          // Respond
          session.channel("rpc").publish({
            type: "response",
            channel: "rpc",
            id: event.id,
            payload: { result: `processed: ${event.payload?.data}` },
          });
        }
      });

      // Start SSE connection
      const controller = new AbortController();
      const sseResponse = await fetch(`${baseUrl}/api/events?subscribe=test-session`, {
        signal: controller.signal,
      });

      // Collect events
      const events: string[] = [];
      const reader = sseResponse.body!.getReader();
      const decoder = new TextDecoder();

      const readEvents = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            events.push(decoder.decode(value));
            if (events.join("").includes("processed:")) break;
          }
        } catch {
          // Expected on abort
        }
      };

      const readPromise = readEvents();

      // Wait for connection
      await new Promise((r) => setTimeout(r, 50));

      // Send request from "client" side
      await fetch(`${baseUrl}/api/channel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "test-session",
          channel: "rpc",
          type: "request",
          payload: { data: "test-input" },
          id: "req-456",
        }),
      });

      // Wait for response to come back
      const timeout = setTimeout(() => controller.abort(), 500);
      await readPromise;
      clearTimeout(timeout);
      controller.abort();

      const fullText = events.join("");
      expect(fullText).toContain("processed: test-input");
      expect(fullText).toContain("req-456");
    });
  });
});
