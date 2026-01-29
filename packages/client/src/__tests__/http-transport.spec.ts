/**
 * HTTP Transport Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HTTPTransport, createHTTPTransport } from "../transports/http.js";
import type { ChannelEvent } from "../types.js";
import { FrameworkChannels } from "@tentickle/shared";

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  static autoConnect = true; // Can be disabled for failing connection tests

  url: string;
  readyState = 0;
  withCredentials: boolean;
  onopen?: () => void;
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: Event) => void;

  private listeners = new Map<string, Set<EventListener>>();

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);

    // Simulate async connection (can be disabled)
    if (MockEventSource.autoConnect) {
      setTimeout(() => {
        this.readyState = 1;
        this.dispatchEvent("open", new Event("open"));
      }, 0);
    }
  }

  addEventListener(type: string, listener: EventListener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(type: string, event: Event | MessageEvent) {
    this.listeners.get(type)?.forEach((l) => l(event as Event));
    return true;
  }

  close() {
    this.readyState = 2;
  }

  // Test helpers
  simulateMessage(data: string) {
    this.dispatchEvent("message", new MessageEvent("message", { data }));
  }

  simulateError() {
    this.dispatchEvent("error", new Event("error"));
  }

  static reset() {
    MockEventSource.instances = [];
    MockEventSource.autoConnect = true;
  }
}

describe("HTTPTransport", () => {
  let transport: HTTPTransport;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    MockEventSource.reset();

    mockFetch = vi.fn(async () => new Response(null, { status: 200 }));

    transport = new HTTPTransport({
      baseUrl: "https://api.example.com",
      fetch: mockFetch as any,
      EventSource: MockEventSource as any,
    });
  });

  afterEach(() => {
    transport.disconnect();
  });

  describe("connect", () => {
    it("creates EventSource with session ID", async () => {
      await transport.connect("session-1");

      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.instances[0].url).toContain("sessionId=session-1");
    });

    it("includes userId in query params", async () => {
      await transport.connect("session-1", { userId: "user-123" });

      expect(MockEventSource.instances[0].url).toContain("userId=user-123");
    });

    it("includes token in query when authTokenInQuery is true", async () => {
      const transportWithToken = new HTTPTransport({
        baseUrl: "https://api.example.com",
        fetch: mockFetch as any,
        EventSource: MockEventSource as any,
        token: "my-jwt",
        authTokenInQuery: true,
      });

      await transportWithToken.connect("session-1");

      expect(MockEventSource.instances[0].url).toContain("token=my-jwt");

      transportWithToken.disconnect();
    });

    it("does not include token in query by default", async () => {
      const transportWithToken = new HTTPTransport({
        baseUrl: "https://api.example.com",
        fetch: mockFetch as any,
        EventSource: MockEventSource as any,
        token: "my-jwt",
      });

      await transportWithToken.connect("session-1");

      expect(MockEventSource.instances[0].url).not.toContain("token=my-jwt");

      transportWithToken.disconnect();
    });

    it("sets withCredentials when configured", async () => {
      const transportWithCreds = new HTTPTransport({
        baseUrl: "https://api.example.com",
        fetch: mockFetch as any,
        EventSource: MockEventSource as any,
        withCredentials: true,
      });

      await transportWithCreds.connect("session-1");

      expect(MockEventSource.instances[0].withCredentials).toBe(true);

      transportWithCreds.disconnect();
    });

    it("updates state to connected", async () => {
      expect(transport.state).toBe("disconnected");

      await transport.connect("session-1");

      expect(transport.state).toBe("connected");
    });

    it("throws if already connected", async () => {
      await transport.connect("session-1");

      await expect(transport.connect("session-2")).rejects.toThrow("Already connected");
    });
  });

  describe("disconnect", () => {
    it("closes EventSource", async () => {
      await transport.connect("session-1");
      const eventSource = MockEventSource.instances[0];

      await transport.disconnect();

      expect(eventSource.readyState).toBe(2); // CLOSED
    });

    it("updates state to disconnected", async () => {
      await transport.connect("session-1");
      await transport.disconnect();

      expect(transport.state).toBe("disconnected");
    });
  });

  describe("send", () => {
    it("sends event via POST", async () => {
      await transport.connect("session-1");

      await transport.send({
        channel: FrameworkChannels.MESSAGES,
        type: "message",
        payload: { role: "user", content: [{ type: "text", text: "Hello" }] },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/events",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("includes session metadata in event", async () => {
      await transport.connect("session-1", { userId: "user-123" });

      await transport.send({
        channel: FrameworkChannels.MESSAGES,
        type: "message",
        payload: {},
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.metadata.sessionId).toBe("session-1");
      expect(body.metadata.userId).toBe("user-123");
      expect(body.metadata.timestamp).toBeDefined();
    });

    it("includes Authorization header when token configured", async () => {
      const transportWithToken = new HTTPTransport({
        baseUrl: "https://api.example.com",
        fetch: mockFetch as any,
        EventSource: MockEventSource as any,
        token: "my-jwt",
      });

      await transportWithToken.connect("session-1");
      await transportWithToken.send({
        channel: FrameworkChannels.MESSAGES,
        type: "message",
        payload: {},
      });

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer my-jwt");

      transportWithToken.disconnect();
    });

    it("includes custom headers", async () => {
      const transportWithHeaders = new HTTPTransport({
        baseUrl: "https://api.example.com",
        fetch: mockFetch as any,
        EventSource: MockEventSource as any,
        headers: { "X-API-Key": "my-key", Authorization: "Basic abc" },
      });

      await transportWithHeaders.connect("session-1");
      await transportWithHeaders.send({
        channel: FrameworkChannels.MESSAGES,
        type: "message",
        payload: {},
      });

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["X-API-Key"]).toBe("my-key");
      expect(headers.Authorization).toBe("Basic abc"); // Custom takes precedence

      transportWithHeaders.disconnect();
    });

    it("throws if not connected", async () => {
      await expect(
        transport.send({
          channel: FrameworkChannels.MESSAGES,
          type: "message",
          payload: {},
        }),
      ).rejects.toThrow("Not connected");
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response("Bad Request", { status: 400, statusText: "Bad Request" }),
      );

      await transport.connect("session-1");

      await expect(
        transport.send({
          channel: FrameworkChannels.MESSAGES,
          type: "message",
          payload: {},
        }),
      ).rejects.toThrow("Failed to send event: 400");
    });
  });

  describe("receive", () => {
    it("parses and dispatches SSE messages", async () => {
      const events: ChannelEvent[] = [];
      transport.onReceive((event) => events.push(event));

      await transport.connect("session-1");

      const eventSource = MockEventSource.instances[0];
      eventSource.simulateMessage(
        JSON.stringify({
          channel: FrameworkChannels.EVENTS,
          type: "content_delta",
          payload: { delta: "Hello" },
        }),
      );

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("content_delta");
    });

    it("handles malformed JSON gracefully", async () => {
      const events: ChannelEvent[] = [];
      transport.onReceive((event) => events.push(event));

      await transport.connect("session-1");

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const eventSource = MockEventSource.instances[0];
      eventSource.simulateMessage("not json");

      expect(events).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("state changes", () => {
    it("notifies handlers on state change", async () => {
      const states: string[] = [];
      transport.onStateChange((state) => states.push(state));

      await transport.connect("session-1");
      await transport.disconnect();

      expect(states).toEqual(["connecting", "connected", "disconnected"]);
    });
  });

  describe("reconnection", () => {
    it("attempts reconnection on error", async () => {
      // Connect first with real timers
      await transport.connect("session-1");

      // Track state changes
      const states: string[] = [];
      transport.onStateChange((state) => states.push(state));

      // Simulate error - should trigger reconnection attempt
      const eventSource = MockEventSource.instances[0];
      eventSource.simulateError();

      // Wait for reconnect timer (default 1000ms) plus a bit
      await new Promise((r) => setTimeout(r, 1200));

      // A new EventSource should be created for the reconnection
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);
    });

    it("gives up after max attempts", async () => {
      // Disable auto-connect so we can control when errors fire
      MockEventSource.autoConnect = false;

      try {
        const transportWithLowRetry = new HTTPTransport({
          baseUrl: "https://api.example.com",
          fetch: mockFetch as any,
          EventSource: MockEventSource as any,
          maxReconnectAttempts: 2,
          reconnectDelay: 20,
        });

        const states: string[] = [];
        transportWithLowRetry.onStateChange((state) => states.push(state));

        // Start connection (won't auto-succeed now)
        const connectPromise = transportWithLowRetry.connect("session-1");

        // Simulate connection failure
        await new Promise((r) => setTimeout(r, 10));
        MockEventSource.instances[MockEventSource.instances.length - 1].simulateError();

        // Wait for connect to reject
        await expect(connectPromise).rejects.toThrow();

        // Wait for reconnection attempts to fail (3 total attempts)
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 50));
          const latest = MockEventSource.instances[MockEventSource.instances.length - 1];
          if (latest) {
            latest.simulateError();
          }
        }

        // Should be in error state after max attempts
        expect(transportWithLowRetry.state).toBe("error");
        transportWithLowRetry.disconnect();
      } finally {
        // Restore auto-connect for other tests
        MockEventSource.autoConnect = true;
      }
    });
  });

  describe("custom paths", () => {
    it("uses custom events path", async () => {
      const transportWithPath = new HTTPTransport({
        baseUrl: "https://api.example.com",
        fetch: mockFetch as any,
        EventSource: MockEventSource as any,
        paths: { events: "/api/v2/events" },
      });

      await transportWithPath.connect("session-1");

      expect(MockEventSource.instances[0].url).toContain("/api/v2/events");

      await transportWithPath.send({
        channel: FrameworkChannels.MESSAGES,
        type: "message",
        payload: {},
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/api/v2/events",
        expect.anything(),
      );

      transportWithPath.disconnect();
    });
  });
});

describe("createHTTPTransport", () => {
  it("creates transport instance", () => {
    const transport = createHTTPTransport({
      baseUrl: "https://api.example.com",
    });

    expect(transport).toBeInstanceOf(HTTPTransport);
    transport.disconnect();
  });
});
