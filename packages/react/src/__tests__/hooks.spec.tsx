/**
 * React Hooks Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { TentickleProvider, useClient, useSession, useConnectionState, useEvents, useStreamingText, useResult, useChannel } from "../index.js";
import type { TentickleClient, ConnectionState, StreamEvent } from "@tentickle/client";

// ============================================================================
// Mock Client
// ============================================================================

import type { StreamingTextState } from "@tentickle/client";

function createMockClient(): TentickleClient & {
  _eventHandlers: Set<(event: StreamEvent) => void>;
  _resultHandlers: Set<(result: any) => void>;
  _stateHandlers: Set<(state: ConnectionState) => void>;
  _streamingTextHandlers: Set<(state: StreamingTextState) => void>;
  _emitEvent: (event: StreamEvent) => void;
  _emitResult: (result: any) => void;
  _emitState: (state: ConnectionState) => void;
} {
  const eventHandlers = new Set<(event: StreamEvent) => void>();
  const resultHandlers = new Set<(result: any) => void>();
  const stateHandlers = new Set<(state: ConnectionState) => void>();
  const streamingTextHandlers = new Set<(state: StreamingTextState) => void>();
  let state: ConnectionState = "disconnected";
  let streamingTextState: StreamingTextState = { text: "", isStreaming: false };

  const emitStreamingText = (newState: StreamingTextState) => {
    streamingTextState = newState;
    for (const handler of streamingTextHandlers) {
      handler(newState);
    }
  };

  return {
    _eventHandlers: eventHandlers,
    _resultHandlers: resultHandlers,
    _stateHandlers: stateHandlers,
    _streamingTextHandlers: streamingTextHandlers,

    _emitEvent(event: StreamEvent) {
      // Also update streaming text like the real client does
      switch (event.type) {
        case "tick_start":
          emitStreamingText({ text: "", isStreaming: true });
          break;
        case "content_delta":
          emitStreamingText({
            text: streamingTextState.text + (event as any).delta,
            isStreaming: true,
          });
          break;
        case "tick_end":
        case "execution_end":
          emitStreamingText({
            text: streamingTextState.text,
            isStreaming: false,
          });
          break;
      }

      for (const handler of eventHandlers) {
        handler(event);
      }
    },

    _emitResult(result: any) {
      for (const handler of resultHandlers) {
        handler(result);
      }
    },

    _emitState(newState: ConnectionState) {
      state = newState;
      for (const handler of stateHandlers) {
        handler(newState);
      }
    },

    get state() {
      return state;
    },

    get sessionId() {
      return "test-session";
    },

    get streamingText() {
      return streamingTextState;
    },

    createSession: vi.fn(async () => ({ sessionId: "new-session", status: "created" })),
    getSessionState: vi.fn(async () => ({ sessionId: "test-session", status: "idle", tick: 0, queuedMessages: 0 })),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    tick: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),

    onEvent(handler: (event: StreamEvent) => void) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },

    onResult(handler: (result: any) => void) {
      resultHandlers.add(handler);
      return () => resultHandlers.delete(handler);
    },

    onConnectionChange(handler: (state: ConnectionState) => void) {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },

    onStreamingText(handler: (state: StreamingTextState) => void) {
      streamingTextHandlers.add(handler);
      handler(streamingTextState); // Immediately call with current state
      return () => streamingTextHandlers.delete(handler);
    },

    clearStreamingText() {
      emitStreamingText({ text: "", isStreaming: false });
    },

    onToolConfirmation: vi.fn(() => () => {}),

    on: vi.fn(() => () => {}),

    channel: vi.fn((name: string) => ({
      name,
      subscribe: vi.fn(() => () => {}),
      publish: vi.fn(async () => {}),
      request: vi.fn(async () => ({})),
    })),

    destroy: vi.fn(),
  } as any;
}

// ============================================================================
// Test Wrapper
// ============================================================================

function createWrapper(client: TentickleClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <TentickleProvider client={client}>
        {children}
      </TentickleProvider>
    );
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("TentickleProvider", () => {
  it("provides client to children", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useClient(), { wrapper });

    expect(result.current).toBe(mockClient);
  });

  it("throws when used outside provider", () => {
    expect(() => {
      renderHook(() => useClient());
    }).toThrow("useClient must be used within a TentickleProvider");
  });
});

describe("useConnectionState", () => {
  it("returns current connection state", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useConnectionState(), { wrapper });

    expect(result.current).toBe("disconnected");
  });

  it("updates when state changes", async () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useConnectionState(), { wrapper });

    expect(result.current).toBe("disconnected");

    act(() => {
      mockClient._emitState("connecting");
    });

    expect(result.current).toBe("connecting");

    act(() => {
      mockClient._emitState("connected");
    });

    expect(result.current).toBe("connected");
  });
});

describe("useSession", () => {
  it("returns session state and methods", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useSession({ autoConnect: false }), { wrapper });

    expect(result.current.sessionId).toBeUndefined();
    expect(result.current.connectionState).toBe("disconnected");
    expect(result.current.isConnected).toBe(false);
    expect(result.current.isConnecting).toBe(false);
    expect(typeof result.current.connect).toBe("function");
    expect(typeof result.current.disconnect).toBe("function");
    expect(typeof result.current.send).toBe("function");
    expect(typeof result.current.tick).toBe("function");
    expect(typeof result.current.abort).toBe("function");
  });

  it("auto-connects by default", async () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    renderHook(() => useSession(), { wrapper });

    await waitFor(() => {
      expect(mockClient.createSession).toHaveBeenCalled();
      expect(mockClient.connect).toHaveBeenCalled();
    });
  });

  it("does not auto-connect when autoConnect is false", async () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    renderHook(() => useSession({ autoConnect: false }), { wrapper });

    // Wait a bit to ensure no calls
    await new Promise((r) => setTimeout(r, 50));

    expect(mockClient.createSession).not.toHaveBeenCalled();
    expect(mockClient.connect).not.toHaveBeenCalled();
  });

  it("connects to existing session when sessionId provided", async () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(
      () => useSession({ sessionId: "existing-session", autoConnect: false }),
      { wrapper },
    );

    await act(async () => {
      await result.current.connect();
    });

    expect(mockClient.createSession).not.toHaveBeenCalled();
    expect(mockClient.connect).toHaveBeenCalledWith("existing-session");
  });

  it("sends messages via send()", async () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useSession({ autoConnect: false }), { wrapper });

    await act(async () => {
      await result.current.send("Hello!");
    });

    expect(mockClient.send).toHaveBeenCalledWith("Hello!");
  });

  it("triggers tick via tick()", async () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useSession({ autoConnect: false }), { wrapper });

    await act(async () => {
      await result.current.tick({ mode: "fast" });
    });

    expect(mockClient.tick).toHaveBeenCalledWith({ mode: "fast" });
  });

  it("aborts via abort()", async () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useSession({ autoConnect: false }), { wrapper });

    await act(async () => {
      await result.current.abort("user requested");
    });

    expect(mockClient.abort).toHaveBeenCalledWith("user requested");
  });
});

describe("useEvents", () => {
  it("receives events", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useEvents(), { wrapper });

    expect(result.current.event).toBeUndefined();

    act(() => {
      mockClient._emitEvent({ type: "tick_start", tick: 1 });
    });

    expect(result.current.event).toEqual({ type: "tick_start", tick: 1 });
  });

  it("filters events by type", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(
      () => useEvents({ filter: ["content_delta"] }),
      { wrapper },
    );

    act(() => {
      mockClient._emitEvent({ type: "tick_start", tick: 1 });
    });

    expect(result.current.event).toBeUndefined();

    act(() => {
      mockClient._emitEvent({ type: "content_delta", delta: "Hello" } as any);
    });

    expect(result.current.event).toEqual({ type: "content_delta", delta: "Hello" });
  });

  it("clears event when clear() called", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useEvents(), { wrapper });

    act(() => {
      mockClient._emitEvent({ type: "tick_start", tick: 1 });
    });

    expect(result.current.event).toBeDefined();

    act(() => {
      result.current.clear();
    });

    expect(result.current.event).toBeUndefined();
  });

  it("does not receive events when disabled", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useEvents({ enabled: false }), { wrapper });

    act(() => {
      mockClient._emitEvent({ type: "tick_start", tick: 1 });
    });

    expect(result.current.event).toBeUndefined();
  });
});

describe("useStreamingText", () => {
  it("accumulates text from content_delta events", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useStreamingText(), { wrapper });

    expect(result.current.text).toBe("");
    expect(result.current.isStreaming).toBe(false);

    act(() => {
      mockClient._emitEvent({ type: "tick_start", tick: 1 });
    });

    expect(result.current.text).toBe("");
    expect(result.current.isStreaming).toBe(true);

    act(() => {
      mockClient._emitEvent({ type: "content_delta", delta: "Hello" } as any);
    });

    expect(result.current.text).toBe("Hello");

    act(() => {
      mockClient._emitEvent({ type: "content_delta", delta: " world" } as any);
    });

    expect(result.current.text).toBe("Hello world");

    act(() => {
      mockClient._emitEvent({ type: "tick_end", tick: 1 } as any);
    });

    expect(result.current.text).toBe("Hello world");
    expect(result.current.isStreaming).toBe(false);
  });

  it("clears text on new tick_start", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useStreamingText(), { wrapper });

    act(() => {
      mockClient._emitEvent({ type: "tick_start", tick: 1 });
      mockClient._emitEvent({ type: "content_delta", delta: "First" } as any);
      mockClient._emitEvent({ type: "tick_end", tick: 1 } as any);
    });

    expect(result.current.text).toBe("First");

    act(() => {
      mockClient._emitEvent({ type: "tick_start", tick: 2 });
    });

    expect(result.current.text).toBe("");
  });

  it("clears when clear() called", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useStreamingText(), { wrapper });

    act(() => {
      mockClient._emitEvent({ type: "tick_start", tick: 1 });
      mockClient._emitEvent({ type: "content_delta", delta: "Hello" } as any);
    });

    expect(result.current.text).toBe("Hello");

    act(() => {
      result.current.clear();
    });

    expect(result.current.text).toBe("");
    expect(result.current.isStreaming).toBe(false);
  });
});

describe("useResult", () => {
  it("receives execution results", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useResult(), { wrapper });

    expect(result.current).toBeUndefined();

    const mockResult = {
      response: "Hello!",
      outputs: {},
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      stopReason: "end_turn",
    };

    act(() => {
      mockClient._emitResult(mockResult);
    });

    expect(result.current).toEqual(mockResult);
  });
});

describe("useChannel", () => {
  it("returns channel accessor", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useChannel("todos"), { wrapper });

    expect(result.current.name).toBe("todos");
    expect(typeof result.current.subscribe).toBe("function");
    expect(typeof result.current.publish).toBe("function");
  });
});
