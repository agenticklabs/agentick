/**
 * React Hooks Tests
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { type ReactNode } from "react";
import {
  AgentickProvider,
  useClient,
  useSession,
  useConnectionState,
  useEvents,
  useStreamingText,
} from "../index.js";
import type {
  AgentickClient,
  ConnectionState,
  StreamEvent,
  SessionStreamEvent,
} from "@agentick/client";
import { createEventBase } from "@agentick/shared/testing";

// ============================================================================
// Mock Client
// ============================================================================

import type { StreamingTextState } from "@agentick/client";

function createMockClient(): AgentickClient & {
  _eventHandlers: Set<(event: SessionStreamEvent) => void>;
  _stateHandlers: Set<(state: ConnectionState) => void>;
  _streamingTextHandlers: Set<(state: StreamingTextState) => void>;
  _emitEvent: (event: StreamEvent | SessionStreamEvent) => void;
  _emitState: (state: ConnectionState) => void;
} {
  const eventHandlers = new Set<(event: SessionStreamEvent) => void>();
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

  const createHandle = () =>
    ({
      sessionId: "test-session",
      executionId: "exec-1",
      status: "completed",
      result: Promise.resolve({
        response: "ok",
        outputs: {},
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }),
      abort: vi.fn(),
      queueMessage: vi.fn(),
      submitToolResult: vi.fn(),
      async *[Symbol.asyncIterator]() {},
    }) as any;

  const createAccessor = (id: string) =>
    ({
      sessionId: id,
      isSubscribed: false,
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      send: vi.fn(() => createHandle()),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      submitToolResult: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      onResult: vi.fn(() => () => {}),
      onToolConfirmation: vi.fn(() => () => {}),
      channel: vi.fn((name: string) => ({
        name,
        subscribe: vi.fn(() => () => {}),
        publish: vi.fn(async () => {}),
        request: vi.fn(async () => ({})),
      })),
    }) as any;

  return {
    _eventHandlers: eventHandlers,
    _stateHandlers: stateHandlers,
    _streamingTextHandlers: streamingTextHandlers,

    _emitEvent(event: StreamEvent | SessionStreamEvent) {
      const withSession: SessionStreamEvent = {
        sessionId: "test-session",
        ...(event as StreamEvent),
      };
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
        handler(withSession);
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

    get streamingText() {
      return streamingTextState;
    },

    send: vi.fn(() => createHandle()),
    abort: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
    session: vi.fn((id: string) => createAccessor(id)),
    subscribe: vi.fn((id: string) => createAccessor(id)),

    onEvent(handler: (event: SessionStreamEvent) => void) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },

    onConnectionChange(handler: (newState: ConnectionState) => void) {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },

    onStreamingText(handler: (state: StreamingTextState) => void) {
      streamingTextHandlers.add(handler);
      handler(streamingTextState);
      return () => streamingTextHandlers.delete(handler);
    },

    clearStreamingText() {
      emitStreamingText({ text: "", isStreaming: false });
    },

    on: vi.fn(() => () => {}),
    destroy: vi.fn(),
  } as any;
}

// ============================================================================
// Test Wrapper
// ============================================================================

function createWrapper(client: AgentickClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AgentickProvider client={client}>{children}</AgentickProvider>;
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("AgentickProvider", () => {
  it("provides client to children", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useClient(), { wrapper });

    expect(result.current).toBe(mockClient);
  });

  it("throws when used outside provider", () => {
    expect(() => {
      renderHook(() => useClient());
    }).toThrow("useClient must be used within a AgentickProvider");
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
  it("returns session methods for ephemeral sends", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useSession(), { wrapper });

    expect(result.current.sessionId).toBeUndefined();
    expect(result.current.isSubscribed).toBe(false);
    expect(typeof result.current.send).toBe("function");
    expect(typeof result.current.subscribe).toBe("function");
    expect(typeof result.current.unsubscribe).toBe("function");
    expect(typeof result.current.abort).toBe("function");
  });

  it("uses client.send for ephemeral sends", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useSession(), { wrapper });

    act(() => {
      result.current.send("Hello!");
    });

    expect(mockClient.send).toHaveBeenCalledWith("Hello!");
  });

  it("uses session accessor when sessionId provided", () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useSession({ sessionId: "conv-123" }), { wrapper });

    act(() => {
      result.current.send("Hello!");
    });

    expect(mockClient.session).toHaveBeenCalledWith("conv-123");
  });
});

describe("useEvents", () => {
  it("receives events as a batched array", async () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useEvents(), { wrapper });

    expect(result.current.events).toHaveLength(0);

    await act(async () => {
      mockClient._emitEvent({ type: "tick_start", tick: 1 } as any);
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toEqual({
      type: "tick_start",
      tick: 1,
      sessionId: "test-session",
    });
  });

  it("filters events by type", async () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useEvents({ filter: ["content_delta"] }), { wrapper });

    await act(async () => {
      mockClient._emitEvent({ ...createEventBase(1), type: "tick_start", tick: 1 });
    });

    expect(result.current.events).toHaveLength(0);

    await act(async () => {
      mockClient._emitEvent({ type: "content_delta", delta: "Hello" } as any);
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toEqual({
      type: "content_delta",
      delta: "Hello",
      sessionId: "test-session",
    });
  });

  it("does not receive events when disabled", async () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useEvents({ enabled: false }), { wrapper });

    await act(async () => {
      mockClient._emitEvent({ ...createEventBase(1), type: "tick_start", tick: 1 });
    });

    expect(result.current.events).toHaveLength(0);
  });

  it("delivers ALL events when multiple fire synchronously", async () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useEvents({ filter: ["tool_result"] }), { wrapper });

    await act(async () => {
      for (let i = 0; i < 5; i++) {
        mockClient._emitEvent({
          type: "tool_result",
          callId: `call-${i}`,
          content: [],
          isError: false,
        } as any);
      }
    });

    expect(result.current.events).toHaveLength(5);
    expect(result.current.events.map((e) => (e as any).callId)).toEqual([
      "call-0",
      "call-1",
      "call-2",
      "call-3",
      "call-4",
    ]);
  });

  it("batches events across separate synchronous bursts", async () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    const { result } = renderHook(() => useEvents(), { wrapper });

    // First burst
    await act(async () => {
      mockClient._emitEvent({ type: "tick_start", tick: 1 } as any);
      mockClient._emitEvent({ type: "content_delta", delta: "a" } as any);
    });

    expect(result.current.events).toHaveLength(2);

    // Second burst — replaces the first batch
    await act(async () => {
      mockClient._emitEvent({ type: "content_delta", delta: "b" } as any);
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toEqual(
      expect.objectContaining({ type: "content_delta", delta: "b" }),
    );
  });

  it("respects filter changes via ref without re-subscribing", async () => {
    const mockClient = createMockClient();
    const wrapper = createWrapper(mockClient);

    // Start with tick_start filter, then switch to content_delta.
    // Inline filter arrays create new references each render — the ref-based
    // approach must handle this without re-subscribing.
    let filterTypes: Array<StreamEvent["type"] | SessionStreamEvent["type"]> = ["tick_start"];

    const { result, rerender } = renderHook(() => useEvents({ filter: filterTypes }), { wrapper });

    await act(async () => {
      mockClient._emitEvent({ type: "tick_start", tick: 1 } as any);
    });

    expect(result.current.events).toHaveLength(1);
    const batchAfterFirst = result.current.events;

    // Switch filter — tick_start should now be ignored by the handler
    filterTypes = ["content_delta"];
    rerender();

    await act(async () => {
      mockClient._emitEvent({ type: "tick_start", tick: 2 } as any);
    });

    // tick_start was filtered out, no new batch — events still holds previous batch
    expect(result.current.events).toBe(batchAfterFirst);

    // content_delta passes the new filter
    await act(async () => {
      mockClient._emitEvent({ type: "content_delta", delta: "hello" } as any);
    });

    // New batch contains ONLY the content_delta, not any tick_starts
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toEqual(
      expect.objectContaining({ type: "content_delta", delta: "hello" }),
    );
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
      mockClient._emitEvent({ ...createEventBase(1), type: "tick_start", tick: 1 });
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
