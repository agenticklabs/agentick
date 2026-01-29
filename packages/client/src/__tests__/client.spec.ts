/**
 * TentickleClient Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TentickleClient, createClient } from "../client.js";
import type { Transport, ConnectionState, ChannelEvent } from "../types.js";
import { FrameworkChannels } from "@tentickle/shared";
import type { StreamEvent } from "@tentickle/shared";

// Mock transport
function createMockTransport(): Transport & {
  _state: ConnectionState;
  _setState: (state: ConnectionState) => void;
  _receiveEvent: (event: ChannelEvent) => void;
} {
  let state: ConnectionState = "disconnected";
  const receiveHandlers = new Set<(event: ChannelEvent) => void>();
  const stateHandlers = new Set<(state: ConnectionState) => void>();

  return {
    name: "mock",

    get state() {
      return state;
    },

    _state: state,
    _setState(newState: ConnectionState) {
      state = newState;
      stateHandlers.forEach((h) => h(newState));
    },

    _receiveEvent(event: ChannelEvent) {
      receiveHandlers.forEach((h) => h(event));
    },

    connect: vi.fn(async () => {
      state = "connected";
      stateHandlers.forEach((h) => h("connected"));
    }),

    disconnect: vi.fn(async () => {
      state = "disconnected";
      stateHandlers.forEach((h) => h("disconnected"));
    }),

    send: vi.fn(async () => {}),

    onReceive(handler) {
      receiveHandlers.add(handler);
      return () => receiveHandlers.delete(handler);
    },

    onStateChange(handler) {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },
  };
}

// Mock fetch
function createMockFetch(responses: Map<string, Response | (() => Response)>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const urlPath = new URL(url).pathname;
    const response = responses.get(urlPath);
    if (!response) {
      throw new Error(`No mock response for ${urlPath}`);
    }
    return typeof response === "function" ? response() : response;
  });
}

describe("TentickleClient", () => {
  let transport: ReturnType<typeof createMockTransport>;
  let client: TentickleClient;
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    transport = createMockTransport();
    mockFetch = createMockFetch(
      new Map([
        [
          "/sessions",
          () =>
            new Response(JSON.stringify({ sessionId: "test-123", status: "created" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        ],
        [
          "/sessions/test-123",
          () =>
            new Response(
              JSON.stringify({ sessionId: "test-123", status: "idle", tick: 0, queuedMessages: 0 }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
        ],
      ]),
    );

    client = new TentickleClient(
      {
        baseUrl: "https://api.example.com",
        fetch: mockFetch as any,
      },
      transport,
    );
  });

  afterEach(() => {
    client.destroy();
  });

  describe("createSession", () => {
    it("creates a session via POST", async () => {
      const result = await client.createSession();

      expect(result.sessionId).toBe("test-123");
      expect(result.status).toBe("created");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/sessions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("passes sessionId and props", async () => {
      await client.createSession({ sessionId: "custom-id", props: { theme: "dark" } });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.sessionId).toBe("custom-id");
      expect(body.props).toEqual({ theme: "dark" });
    });

    it("includes authorization header when token provided", async () => {
      const clientWithToken = new TentickleClient(
        {
          baseUrl: "https://api.example.com",
          token: "my-jwt",
          fetch: mockFetch as any,
        },
        transport,
      );

      await clientWithToken.createSession();

      const call = mockFetch.mock.calls[0];
      expect(call[1]?.headers).toHaveProperty("Authorization", "Bearer my-jwt");

      clientWithToken.destroy();
    });
  });

  describe("getSessionState", () => {
    it("fetches session state", async () => {
      const state = await client.getSessionState("test-123");

      expect(state.sessionId).toBe("test-123");
      expect(state.status).toBe("idle");
    });
  });

  describe("connect", () => {
    it("connects transport to session", async () => {
      await client.connect("session-1");

      expect(transport.connect).toHaveBeenCalledWith("session-1", {
        sessionId: "session-1",
        userId: undefined,
      });
      expect(client.sessionId).toBe("session-1");
    });

    it("throws if already connected", async () => {
      await client.connect("session-1");

      await expect(client.connect("session-2")).rejects.toThrow("Already connected");
    });
  });

  describe("disconnect", () => {
    it("disconnects transport", async () => {
      await client.connect("session-1");
      await client.disconnect();

      expect(transport.disconnect).toHaveBeenCalled();
      expect(client.sessionId).toBeUndefined();
    });
  });

  describe("send", () => {
    it("sends message via transport", async () => {
      await client.connect("session-1");
      await client.send("Hello!");

      expect(transport.send).toHaveBeenCalledWith({
        channel: FrameworkChannels.MESSAGES,
        type: "message",
        payload: {
          role: "user",
          content: [{ type: "text", text: "Hello!" }],
        },
      });
    });

    it("accepts ContentBlock array", async () => {
      await client.connect("session-1");
      await client.send([{ type: "text", text: "Hello!" }]);

      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: {
            role: "user",
            content: [{ type: "text", text: "Hello!" }],
          },
        }),
      );
    });
  });

  describe("tick", () => {
    it("sends tick control event", async () => {
      await client.connect("session-1");
      await client.tick({ mode: "fast" });

      expect(transport.send).toHaveBeenCalledWith({
        channel: FrameworkChannels.CONTROL,
        type: "tick",
        payload: { props: { mode: "fast" } },
      });
    });
  });

  describe("abort", () => {
    it("sends abort control event", async () => {
      await client.connect("session-1");
      await client.abort("User cancelled");

      expect(transport.send).toHaveBeenCalledWith({
        channel: FrameworkChannels.CONTROL,
        type: "abort",
        payload: { reason: "User cancelled" },
      });
    });
  });

  describe("event handlers", () => {
    it("routes stream events to onEvent handlers", async () => {
      const events: StreamEvent[] = [];
      client.onEvent((event) => events.push(event));

      await client.connect("session-1");

      transport._receiveEvent({
        channel: FrameworkChannels.EVENTS,
        type: "content_delta",
        payload: { type: "content_delta", delta: "Hello" },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "content_delta", delta: "Hello" });
    });

    it("routes results to onResult handlers", async () => {
      const results: any[] = [];
      client.onResult((result) => results.push(result));

      await client.connect("session-1");

      transport._receiveEvent({
        channel: FrameworkChannels.RESULT,
        type: "result",
        payload: {
          response: "Done",
          outputs: {},
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      });

      expect(results).toHaveLength(1);
      expect(results[0].response).toBe("Done");
    });

    it("handles tool confirmation requests", async () => {
      const confirmationHandler = vi.fn((request, respond) => {
        respond({ approved: true });
      });
      client.onToolConfirmation(confirmationHandler);

      await client.connect("session-1");

      transport._receiveEvent({
        channel: FrameworkChannels.TOOL_CONFIRMATION,
        type: "request",
        id: "req-1",
        payload: {
          toolUseId: "tool-1",
          name: "delete_file",
          arguments: { path: "/tmp/test.txt" },
        },
      });

      expect(confirmationHandler).toHaveBeenCalled();
      expect(transport.send).toHaveBeenCalledWith({
        channel: FrameworkChannels.TOOL_CONFIRMATION,
        type: "response",
        id: "req-1",
        payload: { approved: true },
      });
    });

    it("supports typed event subscriptions via on()", async () => {
      const deltas: string[] = [];
      client.on("content_delta", (event) => {
        deltas.push(event.delta);
      });

      await client.connect("session-1");

      transport._receiveEvent({
        channel: FrameworkChannels.EVENTS,
        type: "content_delta",
        payload: { type: "content_delta", delta: "Hello" },
      });

      expect(deltas).toEqual(["Hello"]);
    });
  });

  describe("application channels", () => {
    it("creates channel accessors", () => {
      const channel = client.channel("my-channel");

      expect(channel.name).toBe("my-channel");
    });

    it("subscribes to channel events", async () => {
      const channel = client.channel("my-channel");
      const events: unknown[] = [];

      channel.subscribe((payload) => events.push(payload));

      await client.connect("session-1");

      transport._receiveEvent({
        channel: "my-channel",
        type: "update",
        payload: { data: "test" },
      });

      expect(events).toEqual([{ data: "test" }]);
    });

    it("publishes to channel", async () => {
      const channel = client.channel("my-channel");

      await client.connect("session-1");
      await channel.publish("create", { item: "test" });

      expect(transport.send).toHaveBeenCalledWith({
        channel: "my-channel",
        type: "create",
        payload: { item: "test" },
        metadata: expect.objectContaining({ timestamp: expect.any(Number) }),
      });
    });

    it("supports request/response pattern", async () => {
      const channel = client.channel("my-channel");

      await client.connect("session-1");

      // Start request
      const requestPromise = channel.request("get_items", {});

      // Wait a tick for the send to be called
      await new Promise((r) => setTimeout(r, 0));

      // Get the request ID from the send call
      const sendCall = transport.send.mock.calls[0][0] as ChannelEvent;
      const requestId = sendCall.id;

      // Simulate response
      transport._receiveEvent({
        channel: "my-channel",
        type: "response",
        id: requestId,
        payload: { items: ["a", "b", "c"] },
      });

      const result = await requestPromise;
      expect(result).toEqual({ items: ["a", "b", "c"] });
    });

    it("times out request/response", async () => {
      const channel = client.channel("my-channel");
      await client.connect("session-1");

      // Use a short timeout with real timers
      const requestPromise = channel.request("get_items", {}, 50);

      // Wait for timeout
      await expect(requestPromise).rejects.toThrow("Request timed out");
    });
  });

  describe("connection state", () => {
    it("exposes current state", async () => {
      expect(client.state).toBe("disconnected");

      await client.connect("session-1");
      expect(client.state).toBe("connected");

      await client.disconnect();
      expect(client.state).toBe("disconnected");
    });

    it("notifies on state changes", async () => {
      const states: ConnectionState[] = [];
      client.onConnectionChange((state) => states.push(state));

      await client.connect("session-1");
      await client.disconnect();

      expect(states).toEqual(["connected", "disconnected"]);
    });
  });

  describe("destroy", () => {
    it("cleans up all resources", async () => {
      const channel = client.channel("my-channel");
      const events: unknown[] = [];
      channel.subscribe((payload) => events.push(payload));

      await client.connect("session-1");

      client.destroy();

      // Should not receive events after destroy
      transport._receiveEvent({
        channel: "my-channel",
        type: "update",
        payload: { data: "test" },
      });

      expect(events).toHaveLength(0);
    });
  });
});

describe("createClient", () => {
  it("creates client with default transport", () => {
    // This would normally use HTTPTransport, but we're just testing the factory
    const mockFetch = vi.fn();
    const client = createClient({
      baseUrl: "https://api.example.com",
      fetch: mockFetch as any,
    });

    expect(client).toBeInstanceOf(TentickleClient);
    client.destroy();
  });
});
