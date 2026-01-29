/**
 * Tests for TentickleService (Signals-based API)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { firstValueFrom, take, toArray } from "rxjs";

import type { StreamingTextState } from "@tentickle/client";

// Streaming text state for mock
let mockStreamingTextState: StreamingTextState = { text: "", isStreaming: false };
let mockStreamingTextHandlers = new Set<(state: StreamingTextState) => void>();

const emitMockStreamingText = (state: StreamingTextState) => {
  mockStreamingTextState = state;
  for (const handler of mockStreamingTextHandlers) {
    handler(state);
  }
};

// Mock the client module before importing service
const mockClient = {
  createSession: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
  tick: vi.fn(),
  abort: vi.fn(),
  channel: vi.fn(),
  destroy: vi.fn(),
  onConnectionChange: vi.fn(),
  onEvent: vi.fn(),
  onResult: vi.fn(),
  onStreamingText: vi.fn((handler: (state: StreamingTextState) => void) => {
    mockStreamingTextHandlers.add(handler);
    handler(mockStreamingTextState);
    return () => mockStreamingTextHandlers.delete(handler);
  }),
  clearStreamingText: vi.fn(() => {
    emitMockStreamingText({ text: "", isStreaming: false });
  }),
  get streamingText() {
    return mockStreamingTextState;
  },
};

vi.mock("@tentickle/client", () => ({
  createClient: vi.fn(() => mockClient),
}));

import { TentickleService, TENTICKLE_CONFIG, provideTentickle } from "./tentickle.service.js";
import type { StreamEvent, ConnectionState } from "@tentickle/client";

describe("TentickleService", () => {
  let service: TentickleService;
  let connectionChangeHandler: (state: ConnectionState) => void;
  let eventHandler: (event: StreamEvent) => void;
  let resultHandler: (result: unknown) => void;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset streaming text state
    mockStreamingTextState = { text: "", isStreaming: false };
    mockStreamingTextHandlers.clear();

    // Reset streaming text mock implementations
    mockClient.onStreamingText.mockImplementation((handler: (state: StreamingTextState) => void) => {
      mockStreamingTextHandlers.add(handler);
      handler(mockStreamingTextState);
      return () => mockStreamingTextHandlers.delete(handler);
    });
    mockClient.clearStreamingText.mockImplementation(() => {
      emitMockStreamingText({ text: "", isStreaming: false });
    });

    // Capture handlers when client subscribes
    mockClient.onConnectionChange.mockImplementation((handler) => {
      connectionChangeHandler = handler;
      return () => {};
    });
    mockClient.onEvent.mockImplementation((handler) => {
      eventHandler = handler;
      return () => {};
    });
    mockClient.onResult.mockImplementation((handler) => {
      resultHandler = handler;
      return () => {};
    });

    // Create service with config
    service = new TentickleService({ baseUrl: "https://api.example.com" });
  });

  afterEach(() => {
    service.ngOnDestroy();
  });

  // ============================================================================
  // Configuration
  // ============================================================================

  describe("configuration", () => {
    it("throws error when config is not provided", () => {
      expect(() => new TentickleService(undefined)).toThrow(
        "TentickleService requires TENTICKLE_CONFIG to be provided"
      );
    });

    it("creates client with provided config", async () => {
      const { createClient } = await import("@tentickle/client");
      expect(createClient).toHaveBeenCalledWith({
        baseUrl: "https://api.example.com",
      });
    });
  });

  // ============================================================================
  // Initial State (Signals)
  // ============================================================================

  describe("initial state", () => {
    it("has disconnected connection state signal", () => {
      expect(service.connectionState()).toBe("disconnected");
    });

    it("has empty streaming text signal", () => {
      expect(service.streamingText()).toEqual({
        text: "",
        isStreaming: false,
      });
    });

    it("has computed signals for derived state", () => {
      expect(service.isConnected()).toBe(false);
      expect(service.isConnecting()).toBe(false);
      expect(service.text()).toBe("");
      expect(service.isStreaming()).toBe(false);
    });

    it("has undefined sessionId and error signals", () => {
      expect(service.sessionId()).toBeUndefined();
      expect(service.error()).toBeUndefined();
    });
  });

  // ============================================================================
  // Connection Lifecycle
  // ============================================================================

  describe("connect", () => {
    it("creates session and connects when no sessionId provided", async () => {
      mockClient.createSession.mockResolvedValue({ sessionId: "new-session-123" });
      mockClient.connect.mockResolvedValue(undefined);

      await service.connect();

      expect(mockClient.createSession).toHaveBeenCalledWith({ props: undefined });
      expect(mockClient.connect).toHaveBeenCalledWith("new-session-123");
    });

    it("connects to existing session when sessionId provided", async () => {
      mockClient.connect.mockResolvedValue(undefined);

      await service.connect("existing-session-456");

      expect(mockClient.createSession).not.toHaveBeenCalled();
      expect(mockClient.connect).toHaveBeenCalledWith("existing-session-456");
    });

    it("passes props when creating session", async () => {
      mockClient.createSession.mockResolvedValue({ sessionId: "new-session" });
      mockClient.connect.mockResolvedValue(undefined);

      await service.connect(undefined, { userId: "user-1" });

      expect(mockClient.createSession).toHaveBeenCalledWith({
        props: { userId: "user-1" },
      });
    });

    it("updates connection state signal to connecting", async () => {
      mockClient.createSession.mockResolvedValue({ sessionId: "session-1" });
      mockClient.connect.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      const connectPromise = service.connect();

      // Check connecting state via signal
      expect(service.connectionState()).toBe("connecting");
      expect(service.isConnecting()).toBe(true);

      await connectPromise;
    });

    it("sets error signal on connection failure", async () => {
      mockClient.createSession.mockRejectedValue(new Error("Connection failed"));

      await expect(service.connect()).rejects.toThrow("Connection failed");

      expect(service.connectionState()).toBe("error");
      expect(service.error()?.message).toBe("Connection failed");
    });

    it("does not reconnect if already connected", async () => {
      mockClient.createSession.mockResolvedValue({ sessionId: "session-1" });
      mockClient.connect.mockResolvedValue(undefined);

      await service.connect();
      connectionChangeHandler("connected");

      await service.connect();

      expect(mockClient.createSession).toHaveBeenCalledTimes(1);
    });

    it("does not reconnect if already connecting", async () => {
      mockClient.createSession.mockResolvedValue({ sessionId: "session-1" });
      mockClient.connect.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      const promise1 = service.connect();
      const promise2 = service.connect();

      await Promise.all([promise1, promise2]);

      expect(mockClient.createSession).toHaveBeenCalledTimes(1);
    });
  });

  describe("disconnect", () => {
    it("calls client disconnect", async () => {
      mockClient.disconnect.mockResolvedValue(undefined);

      await service.disconnect();

      expect(mockClient.disconnect).toHaveBeenCalled();
    });

    it("updates signals on disconnect", async () => {
      mockClient.disconnect.mockResolvedValue(undefined);

      await service.disconnect();

      expect(service.connectionState()).toBe("disconnected");
      expect(service.sessionId()).toBeUndefined();
    });

    it("sets error signal on disconnect failure", async () => {
      mockClient.disconnect.mockRejectedValue(new Error("Disconnect failed"));

      await expect(service.disconnect()).rejects.toThrow("Disconnect failed");

      expect(service.error()?.message).toBe("Disconnect failed");
    });
  });

  // ============================================================================
  // Connection State Changes
  // ============================================================================

  describe("connection state changes", () => {
    it("updates signals when connection state changes", async () => {
      connectionChangeHandler("connecting");
      expect(service.connectionState()).toBe("connecting");
      expect(service.isConnecting()).toBe(true);
      expect(service.isConnected()).toBe(false);

      connectionChangeHandler("connected");
      expect(service.connectionState()).toBe("connected");
      expect(service.isConnecting()).toBe(false);
      expect(service.isConnected()).toBe(true);

      connectionChangeHandler("disconnected");
      expect(service.connectionState()).toBe("disconnected");
      expect(service.isConnecting()).toBe(false);
      expect(service.isConnected()).toBe(false);
    });

    it("connectionState$ observable emits values", async () => {
      const states: ConnectionState[] = [];
      const sub = service.connectionState$.subscribe((s) => states.push(s));

      // Wait for initial value
      await new Promise((resolve) => setTimeout(resolve, 20));

      connectionChangeHandler("connecting");
      await new Promise((resolve) => setTimeout(resolve, 20));

      connectionChangeHandler("connected");
      await new Promise((resolve) => setTimeout(resolve, 20));

      sub.unsubscribe();

      expect(states).toContain("disconnected");
      expect(states).toContain("connecting");
      expect(states).toContain("connected");
    });

    it("isConnected$ observable emits values", async () => {
      const values: boolean[] = [];
      const sub = service.isConnected$.subscribe((v) => values.push(v));

      // Wait for initial value
      await new Promise((resolve) => setTimeout(resolve, 20));

      connectionChangeHandler("connected");
      await new Promise((resolve) => setTimeout(resolve, 20));

      sub.unsubscribe();

      expect(values).toContain(false);
      expect(values).toContain(true);
    });
  });

  // ============================================================================
  // Messaging
  // ============================================================================

  describe("send", () => {
    it("delegates to client", async () => {
      mockClient.send.mockResolvedValue(undefined);

      await service.send("Hello");

      expect(mockClient.send).toHaveBeenCalledWith("Hello");
    });
  });

  describe("tick", () => {
    it("delegates to client", async () => {
      mockClient.tick.mockResolvedValue(undefined);

      await service.tick();

      expect(mockClient.tick).toHaveBeenCalledWith(undefined);
    });

    it("passes props to client", async () => {
      mockClient.tick.mockResolvedValue(undefined);

      await service.tick({ mode: "fast" });

      expect(mockClient.tick).toHaveBeenCalledWith({ mode: "fast" });
    });
  });

  describe("abort", () => {
    it("delegates to client", async () => {
      mockClient.abort.mockResolvedValue(undefined);

      await service.abort();

      expect(mockClient.abort).toHaveBeenCalledWith(undefined);
    });

    it("passes reason to client", async () => {
      mockClient.abort.mockResolvedValue(undefined);

      await service.abort("User cancelled");

      expect(mockClient.abort).toHaveBeenCalledWith("User cancelled");
    });
  });

  // ============================================================================
  // Events
  // ============================================================================

  describe("events$", () => {
    it("emits events from client", async () => {
      const events: StreamEvent[] = [];
      const sub = service.events$.subscribe((e) => events.push(e));

      eventHandler({ type: "tick_start" } as StreamEvent);
      eventHandler({ type: "content_delta", delta: "Hello" } as StreamEvent);
      eventHandler({ type: "tick_end" } as StreamEvent);

      sub.unsubscribe();

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe("tick_start");
      expect(events[1].type).toBe("content_delta");
      expect(events[2].type).toBe("tick_end");
    });
  });

  describe("eventsOfType", () => {
    it("filters events by type", async () => {
      const events: StreamEvent[] = [];
      const sub = service
        .eventsOfType("content_delta")
        .subscribe((e) => events.push(e));

      eventHandler({ type: "tick_start" } as StreamEvent);
      eventHandler({ type: "content_delta", delta: "Hello" } as StreamEvent);
      eventHandler({ type: "content_delta", delta: " World" } as StreamEvent);
      eventHandler({ type: "tick_end" } as StreamEvent);

      sub.unsubscribe();

      expect(events).toHaveLength(2);
      expect(events.every((e) => e.type === "content_delta")).toBe(true);
    });

    it("filters multiple event types", async () => {
      const events: StreamEvent[] = [];
      const sub = service
        .eventsOfType("tick_start", "tick_end")
        .subscribe((e) => events.push(e));

      eventHandler({ type: "tick_start" } as StreamEvent);
      eventHandler({ type: "content_delta", delta: "Hello" } as StreamEvent);
      eventHandler({ type: "tick_end" } as StreamEvent);

      sub.unsubscribe();

      expect(events).toHaveLength(2);
      expect(events.map((e) => e.type)).toEqual(["tick_start", "tick_end"]);
    });
  });

  // ============================================================================
  // Streaming Text (Signals)
  // ============================================================================

  describe("streaming text", () => {
    it("updates streaming text signal from client", async () => {
      emitMockStreamingText({ text: "", isStreaming: true });
      expect(service.streamingText()).toEqual({ text: "", isStreaming: true });
    });

    it("updates text computed signal", async () => {
      emitMockStreamingText({ text: "Hello World", isStreaming: true });
      expect(service.text()).toBe("Hello World");
    });

    it("updates isStreaming computed signal", async () => {
      emitMockStreamingText({ text: "Hello", isStreaming: true });
      expect(service.isStreaming()).toBe(true);

      emitMockStreamingText({ text: "Hello", isStreaming: false });
      expect(service.isStreaming()).toBe(false);
    });

    it("streamingText$ observable emits values", async () => {
      const states: StreamingTextState[] = [];
      const sub = service.streamingText$.subscribe((s) => states.push(s));

      // Wait for initial value
      await new Promise((resolve) => setTimeout(resolve, 20));

      emitMockStreamingText({ text: "Hello", isStreaming: true });
      await new Promise((resolve) => setTimeout(resolve, 20));

      sub.unsubscribe();

      expect(states.some((s) => s.text === "")).toBe(true);
      expect(states.some((s) => s.text === "Hello")).toBe(true);
    });

    it("text$ observable emits values", async () => {
      const texts: string[] = [];
      const sub = service.text$.subscribe((t) => texts.push(t));

      // Wait for initial value
      await new Promise((resolve) => setTimeout(resolve, 20));

      emitMockStreamingText({ text: "Hello", isStreaming: true });
      await new Promise((resolve) => setTimeout(resolve, 20));

      emitMockStreamingText({ text: "Hello World", isStreaming: true });
      await new Promise((resolve) => setTimeout(resolve, 20));

      sub.unsubscribe();

      expect(texts).toContain("");
      expect(texts).toContain("Hello");
      expect(texts).toContain("Hello World");
    });

    it("isStreaming$ observable emits values", async () => {
      const values: boolean[] = [];
      const sub = service.isStreaming$.subscribe((v) => values.push(v));

      // Wait for initial value
      await new Promise((resolve) => setTimeout(resolve, 20));

      emitMockStreamingText({ text: "", isStreaming: true });
      await new Promise((resolve) => setTimeout(resolve, 20));

      emitMockStreamingText({ text: "Hello", isStreaming: false });
      await new Promise((resolve) => setTimeout(resolve, 20));

      sub.unsubscribe();

      expect(values).toContain(false);
      expect(values).toContain(true);
    });

    it("clearStreamingText calls client", async () => {
      emitMockStreamingText({ text: "Hello", isStreaming: true });

      service.clearStreamingText();

      expect(mockClient.clearStreamingText).toHaveBeenCalled();
      expect(service.streamingText()).toEqual({ text: "", isStreaming: false });
    });
  });

  // ============================================================================
  // Results
  // ============================================================================

  describe("result$", () => {
    it("emits results from client", async () => {
      const result = {
        response: "Hello",
        outputs: {},
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };

      const resultPromise = firstValueFrom(service.result$);

      resultHandler(result);

      const received = await resultPromise;
      expect(received).toEqual(result);
    });
  });

  // ============================================================================
  // Channels
  // ============================================================================

  describe("channel", () => {
    it("delegates to client", () => {
      const mockChannel = {
        subscribe: vi.fn(),
        publish: vi.fn(),
      };
      mockClient.channel.mockReturnValue(mockChannel);

      const channel = service.channel("todos");

      expect(mockClient.channel).toHaveBeenCalledWith("todos");
      expect(channel).toBe(mockChannel);
    });
  });

  describe("channel$", () => {
    it("creates observable from channel", async () => {
      const mockUnsubscribe = vi.fn();
      let channelCallback: (payload: unknown, event: { type: string }) => void;

      const mockChannel = {
        subscribe: vi.fn((cb) => {
          channelCallback = cb;
          return mockUnsubscribe;
        }),
      };
      mockClient.channel.mockReturnValue(mockChannel);

      const events: Array<{ type: string; payload: unknown }> = [];
      const sub = service.channel$("todos").subscribe((e) => events.push(e));

      // Simulate channel events
      channelCallback!({ items: [] }, { type: "initialized" });
      channelCallback!({ item: { id: 1 } }, { type: "added" });

      sub.unsubscribe();

      expect(events).toEqual([
        { type: "initialized", payload: { items: [] } },
        { type: "added", payload: { item: { id: 1 } } },
      ]);
      expect(mockUnsubscribe).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Cleanup
  // ============================================================================

  describe("ngOnDestroy", () => {
    it("destroys client", () => {
      service.ngOnDestroy();

      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it("completes channel observables", async () => {
      const mockChannel = {
        subscribe: vi.fn(() => vi.fn()),
      };
      mockClient.channel.mockReturnValue(mockChannel);

      let completed = false;
      service.channel$("todos").subscribe({
        complete: () => {
          completed = true;
        },
      });

      service.ngOnDestroy();

      // Give time for completion to propagate
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(completed).toBe(true);
    });
  });
});

// ============================================================================
// provideTentickle Factory
// ============================================================================

describe("provideTentickle", () => {
  it("returns array with TENTICKLE_CONFIG and TentickleService", () => {
    const providers = provideTentickle({ baseUrl: "https://api.example.com" });

    expect(providers).toHaveLength(2);
    expect(providers[0]).toEqual({
      provide: TENTICKLE_CONFIG,
      useValue: { baseUrl: "https://api.example.com" },
    });
    expect(providers[1]).toBe(TentickleService);
  });

  it("includes full config in provider", () => {
    const config = {
      baseUrl: "https://custom.api.com",
      token: "my-token",
    };
    const providers = provideTentickle(config);

    expect(providers[0]).toEqual({
      provide: TENTICKLE_CONFIG,
      useValue: config,
    });
  });
});
